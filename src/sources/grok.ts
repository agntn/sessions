import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { home, osUser } from "../core/env.ts";
import type {
  Block,
  Channel,
  Message,
  Participant,
  Source,
  SourceReadOptions,
} from "../core/types.ts";
import { isRecord, parseJson, parseJsonRecord, scalarText } from "./parsing.ts";

interface Transcript {
  readonly directory: string;
  readonly path: string;
  readonly mtime: number;
}

interface SessionClock {
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly source: "session" | "file";
}

function defaultSessionsDir(): string {
  const override = process.env.GROK_HOME?.trim();
  return join(override || join(home(), ".grok"), "sessions");
}

function isSessionSegment(value: string): boolean {
  return (
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

function epoch(value: unknown): number | undefined {
  const text = scalarText(value);
  if (!text) return undefined;
  const parsed = new Date(text).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readSummary(directory: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed = parseJson(readFileSync(join(directory, "summary.json"), "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readClock(directory: string, mtime: number): SessionClock {
  const fileClock: SessionClock = { createdAt: mtime, updatedAt: mtime, source: "file" };
  const summary = readSummary(directory);
  if (!summary) return fileClock;
  const updated = epoch(summary.last_active_at) ?? epoch(summary.updated_at);
  const createdAt = epoch(summary.created_at) ?? updated;
  if (createdAt === undefined) return fileClock;
  return { createdAt, updatedAt: Math.max(createdAt, updated ?? createdAt), source: "session" };
}

function timestampAt(
  index: number,
  total: number,
  clock: SessionClock,
): Pick<Message, "timestamp" | "timestampSource"> {
  const timestamp =
    clock.source === "file" || total <= 1
      ? clock.updatedAt
      : index === total - 1
        ? clock.updatedAt
        : clock.createdAt;
  return { timestamp, timestampSource: clock.source };
}

function textBlocks(value: unknown): Block[] {
  return typeof value === "string" && value.length > 0 ? [{ type: "text", text: value }] : [];
}

function userBlocks(content: unknown): Block[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!isRecord(block) || block.type !== "text") return [];
    const text = scalarText(block.text);
    return text ? [{ type: "text" as const, text }] : [];
  });
}

function assistantToolCalls(value: unknown): Block[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((call) => {
    if (!isRecord(call)) return [];
    const toolInput =
      typeof call.arguments === "string"
        ? call.arguments
        : (JSON.stringify(call.arguments ?? "") ?? "");
    return [
      {
        type: "tool_call" as const,
        toolName: scalarText(call.name) ?? "",
        toolCallId: scalarText(call.id) ?? "",
        toolInput,
      },
    ];
  });
}

function imageUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((image) => {
    if (!isRecord(image)) return [];
    const url = scalarText(image.url);
    return url ? [url] : [];
  });
}

function toolResultBlocks(entry: Readonly<Record<string, unknown>>): Block[] {
  const text = [typeof entry.content === "string" ? entry.content : "", ...imageUrls(entry.images)]
    .filter((part) => part.length > 0)
    .join("\n");
  if (!text) return [];
  return [
    {
      type: "tool_result",
      toolCallId: scalarText(entry.tool_call_id) ?? "",
      text,
    },
  ];
}

function reasoningBlocks(entry: Readonly<Record<string, unknown>>): Block[] {
  if (!Array.isArray(entry.summary)) return [];
  return entry.summary.flatMap((item) => {
    if (!isRecord(item)) return [];
    const text = scalarText(item.text);
    return text ? [{ type: "thinking" as const, text }] : [];
  });
}

function backendInput(kind: Readonly<Record<string, unknown>>): string {
  if (typeof kind.input === "string") return kind.input;
  if (isRecord(kind.action)) return JSON.stringify(kind.action);
  if (kind.input === undefined) return "";
  return JSON.stringify(kind.input) ?? "";
}

function backendToolCall(value: unknown): Block[] {
  if (!isRecord(value)) return [];
  return [
    {
      type: "tool_call",
      toolName: scalarText(value.name) ?? scalarText(value.tool_type) ?? "",
      toolCallId: scalarText(value.id) ?? scalarText(value.call_id) ?? "",
      toolInput: backendInput(value),
    },
  ];
}

function blocksFor(entry: Readonly<Record<string, unknown>>): Block[] {
  switch (entry.type) {
    case "user":
      return userBlocks(entry.content);
    case "assistant":
      return [...textBlocks(entry.content), ...assistantToolCalls(entry.tool_calls)];
    case "reasoning":
      return reasoningBlocks(entry);
    case "tool_result":
      return toolResultBlocks(entry);
    case "backend_tool_call":
      return backendToolCall(entry.kind);
    default:
      return [];
  }
}

function roleFor(type: unknown): Message["role"] | undefined {
  if (type === "user") return "user";
  if (type === "tool_result") return "tool";
  if (type === "assistant" || type === "reasoning" || type === "backend_tool_call") {
    return "assistant";
  }
  return undefined;
}

function userContext(entry: Readonly<Record<string, unknown>>): Record<string, string> | undefined {
  const reason = scalarText(entry.synthetic_reason);
  return reason ? { syntheticReason: reason } : undefined;
}

function* transcriptAt(directory: string): Generator<Transcript> {
  const path = join(directory, "chat_history.jsonl");
  if (!existsSync(path)) return;
  yield { directory, path, mtime: statSync(path).mtimeMs };
}

function* transcripts(root: string, sessionId?: string): Generator<Transcript> {
  if (!existsSync(root)) return;
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectDir = join(root, project.name);
    if (sessionId) {
      yield* transcriptAt(join(projectDir, sessionId));
      continue;
    }
    for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      yield* transcriptAt(join(projectDir, entry.name));
    }
  }
}

async function* records(path: string): AsyncGenerator<Readonly<Record<string, unknown>>> {
  const input = createReadStream(path);
  try {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      const entry = parseJsonRecord(line);
      if (entry) yield entry;
    }
  } finally {
    input.destroy();
  }
}

/** Lines have no clock, so times come from `summary.json` or the file mtime. */
export class GrokSource implements Source {
  readonly name = "grok";
  private readonly sessionsDir: string;
  private readonly channel: Channel = { platform: "cli", name: "grok" };
  private readonly user: Participant;

  constructor(sessionsDir?: string) {
    this.sessionsDir = sessionsDir ?? defaultSessionsDir();
    this.user = { platform: "cli", name: osUser() };
  }

  available(): boolean {
    return existsSync(this.sessionsDir);
  }

  private messageFrom(
    entry: Readonly<Record<string, unknown>>,
    sessionId: string,
    clock: SessionClock,
    index: number,
    total: number,
  ): Message | undefined {
    const role = roleFor(entry.type);
    const blocks = blocksFor(entry);
    if (!role || blocks.length === 0) return undefined;
    const time = timestampAt(index, total, clock);
    const context = role === "user" ? userContext(entry) : undefined;
    return {
      source: this.name,
      sessionId,
      role,
      timestamp: time.timestamp,
      timestampSource: time.timestampSource,
      date: new Date(time.timestamp).toISOString().split("T")[0],
      blocks,
      channel: this.channel,
      author: role === "user" ? this.user : { platform: "cli", name: "grok", isBot: true },
      ...(context ? { context } : {}),
    };
  }

  private async *readFile(file: Transcript): AsyncGenerator<Message> {
    const sessionId = file.directory.split("/").pop() ?? "";
    const clock = readClock(file.directory, file.mtime);
    let total = 0;
    for await (const entry of records(file.path)) {
      if (roleFor(entry.type) && blocksFor(entry).length > 0) total += 1;
    }
    let index = 0;
    for await (const entry of records(file.path)) {
      const message = this.messageFrom(entry, sessionId, clock, index, total);
      if (!message) continue;
      index += 1;
      yield message;
    }
  }

  async *read(options?: SourceReadOptions): AsyncGenerator<Message> {
    const requested = options?.sessionId || undefined;
    if (requested !== undefined && !isSessionSegment(requested)) return;
    const files = [...transcripts(this.sessionsDir, requested)].sort(
      (left, right) => left.mtime - right.mtime,
    );
    for (const file of files) yield* this.readFile(file);
  }
}
