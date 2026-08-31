import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { home } from "../core/env.ts";
import type { Block, Channel, Message, Participant, Source } from "../core/types.ts";
import { isRecord, parseJsonRecord, scalarText } from "./parsing.ts";

const RE_DISCORD_DM = /^\[Discord (\S+) user id:(\d+)/;
const RE_DISCORD_GUILD = /^\[Discord Guild #(\S+) channel id:(\d+)[^\]]*\] (.+?)(?:: | \()/;
const RE_DISCORD_FROM = /\[from: (.+?) \((\d+)\)\]/;
const RE_CRON = /^\[cron:([a-f0-9-]+)\s+([a-zA-Z0-9_-]+)\]/;

interface DiscordContext {
  readonly origin: string;
  readonly channel?: string;
  readonly channelId?: string;
  readonly userId?: string;
  readonly username?: string;
}

interface StringContext {
  readonly [key: string]: string;
}

interface SessionFile {
  readonly path: string;
  readonly mtime: number;
}

interface NormalizedEntry {
  readonly message: Message;
  readonly sessionContext?: StringContext;
}

function parseDiscordHeader(text: string): DiscordContext | undefined {
  const dm = text.match(RE_DISCORD_DM);
  if (dm) return { origin: "discord:dm", username: dm[1], userId: dm[2] };

  const guild = text.match(RE_DISCORD_GUILD);
  if (!guild) return undefined;
  const from = text.match(RE_DISCORD_FROM);
  return {
    origin: "discord:guild",
    channel: guild[1],
    channelId: guild[2],
    username: from?.[1] ?? guild[3].trim(),
    userId: from?.[2],
  };
}

function discordRecord(context: DiscordContext): Record<string, string> {
  const result: Record<string, string> = { origin: context.origin };
  if (context.channel) result.channel = context.channel;
  if (context.channelId) result.channelId = context.channelId;
  if (context.username) result.username = context.username;
  if (context.userId) result.userId = context.userId;
  return result;
}

function classifySession(firstUserText: string): Record<string, string> {
  const cron = firstUserText.match(RE_CRON);
  if (cron) return { origin: "cron", cronId: cron[1], cronTask: cron[2] };
  if (firstUserText.includes("HEARTBEAT") || firstUserText.startsWith("Przeczytaj HEARTBEAT")) {
    return { origin: "heartbeat" };
  }
  const discord = parseDiscordHeader(firstUserText);
  return discord ? discordRecord(discord) : { origin: "interactive" };
}

function textBlock(type: "text" | "thinking", value: unknown): Block[] {
  const text = scalarText(value);
  return text ? [{ type, text }] : [];
}

function toolCallBlock(value: Readonly<Record<string, unknown>>): Block[] {
  return [
    {
      type: "tool_call",
      toolName: scalarText(value.name) ?? "",
      toolCallId: scalarText(value.id) ?? "",
      toolInput:
        typeof value.input === "string" ? value.input : (JSON.stringify(value.input) ?? ""),
    },
  ];
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item) => {
      if (!isRecord(item) || item.type !== "text") return [];
      const text = scalarText(item.text);
      return text ? [text] : [];
    })
    .join("\n");
}

function toolResultBlock(value: Readonly<Record<string, unknown>>): Block[] {
  return [
    {
      type: "tool_result",
      toolCallId: scalarText(value.id) ?? "",
      text: toolResultText(value.content),
    },
  ];
}

function parseBlock(value: unknown): Block[] {
  if (!isRecord(value)) return [];
  switch (value.type) {
    case "text":
      return textBlock("text", value.text);
    case "thinking":
      return textBlock("thinking", value.thinking);
    case "toolCall":
      return toolCallBlock(value);
    case "toolResult":
      return toolResultBlock(value);
    default:
      return [];
  }
}

function parseBlocks(content: unknown): Block[] {
  return Array.isArray(content) ? content.flatMap(parseBlock) : [];
}

function* walkJsonl(dirs: readonly string[]): Generator<string> {
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.endsWith(".jsonl")) yield join(dir, entry.name);
    }
  }
}

function nativeRole(value: unknown): Message["role"] | undefined {
  if (value === "toolResult") return "tool";
  if (value === "user") return "user";
  if (value === "assistant") return "assistant";
  return undefined;
}

function messageContext(
  sessionContext: StringContext | undefined,
  role: "user" | "assistant" | "tool",
  firstText: string | undefined,
): StringContext | undefined {
  if (role !== "user" || !firstText) return sessionContext;
  const discord = parseDiscordHeader(firstText);
  if (!discord) return sessionContext;
  return {
    ...sessionContext,
    ...(discord.username ? { username: discord.username } : {}),
    ...(discord.userId ? { userId: discord.userId } : {}),
    ...(discord.channel ? { channel: discord.channel } : {}),
  };
}

function authorFromContext(context: StringContext | undefined): Participant | undefined {
  const username = context?.username;
  if (!username) return undefined;
  const origin = context.origin;
  const platform = origin?.startsWith("discord") ? "discord" : (origin ?? "unknown");
  return { platform, name: username, platformId: context.userId };
}

function channelFromContext(context: StringContext | undefined): Channel | undefined {
  switch (context?.origin) {
    case "discord:dm":
      return { platform: "discord", type: "dm" };
    case "discord:guild":
      return {
        platform: "discord",
        type: "guild",
        platformId: context.channelId,
        name: context.channel,
      };
    case "interactive":
      return { platform: "cli", type: "interactive" };
    case "cron":
      return { platform: "system", type: "cron" };
    case "heartbeat":
      return { platform: "system", type: "heartbeat" };
    default:
      return undefined;
  }
}

function timestampForEntry(
  entry: Readonly<Record<string, unknown>>,
  sessionTimestamp: string,
  mtime: number,
): number {
  const entryTimestamp = scalarText(entry.timestamp);
  const raw = entryTimestamp || sessionTimestamp;
  const parsed = raw ? new Date(raw).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : mtime;
}

export class OpenClawSource implements Source {
  name = "openclaw";
  private sessionsDirs: readonly string[];

  constructor(sessionsDirs?: readonly string[]) {
    const base = process.env.AEI_HOME || join(home(), ".config", "aei");
    this.sessionsDirs = sessionsDirs ?? [
      join(base, "external", "openclaw-sessions"),
      join(base, "external", "moltbot-sessions"),
    ];
  }

  available(): boolean {
    return this.sessionsDirs.some((dir) => existsSync(dir));
  }

  private normalizeEntry(
    entry: Readonly<Record<string, unknown>>,
    sessionId: string,
    sessionTimestamp: string,
    sessionContext: StringContext | undefined,
    mtime: number,
  ): NormalizedEntry | undefined {
    if (!isRecord(entry.message)) return undefined;
    const role = nativeRole(entry.message.role);
    if (!role) return undefined;
    const blocks = parseBlocks(entry.message.content);
    if (blocks.length === 0) return undefined;

    const firstText = blocks[0]?.text;
    const nextSessionContext =
      sessionContext ?? (role === "user" && firstText ? classifySession(firstText) : undefined);
    const context = messageContext(nextSessionContext, role, firstText);
    const timestamp = timestampForEntry(entry, sessionTimestamp, mtime);
    return {
      sessionContext: nextSessionContext,
      message: {
        source: this.name,
        sessionId,
        role,
        timestamp,
        date: new Date(timestamp).toISOString().split("T")[0],
        blocks,
        context,
        author: authorFromContext(context),
        channel: channelFromContext(nextSessionContext),
      },
    };
  }

  private async *readFile(file: SessionFile): AsyncGenerator<Message> {
    const sessionId = file.path.split("/").pop()?.replace(".jsonl", "") || "";
    const lines = createInterface({ input: createReadStream(file.path), crlfDelay: Infinity });
    let sessionTimestamp = "";
    let sessionContext: StringContext | undefined;

    for await (const line of lines) {
      const entry = parseJsonRecord(line);
      if (!entry) continue;
      if (entry.type === "session") {
        sessionTimestamp = scalarText(entry.timestamp) ?? sessionTimestamp;
        continue;
      }
      if (entry.type !== "message") continue;
      const normalized = this.normalizeEntry(
        entry,
        sessionId,
        sessionTimestamp,
        sessionContext,
        file.mtime,
      );
      if (!normalized) continue;
      sessionContext = normalized.sessionContext;
      yield normalized.message;
    }
  }

  async *read(): AsyncGenerator<Message> {
    const files: SessionFile[] = [];
    for (const path of walkJsonl(this.sessionsDirs)) {
      files.push({ path, mtime: statSync(path).mtimeMs });
    }
    files.sort((left, right) => left.mtime - right.mtime);
    for (const file of files) yield* this.readFile(file);
  }
}
