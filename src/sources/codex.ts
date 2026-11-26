import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { home, osUser } from "../core/env.ts";
import type { Block, Message, Source, SourceReadOptions } from "../core/types.ts";
import { activeFiles } from "./activity.ts";
import { isRecord, jsonlLines, parseJson, parseJsonRecord, scalarText } from "./parsing.ts";

interface SessionFile {
  readonly path: string;
  readonly mtime: number;
  readonly format: "jsonl" | "json";
}

interface ParsedPayload {
  readonly role: "user" | "assistant" | "tool";
  readonly blocks: Block[];
}

interface ParsedTimestamp {
  readonly timestamp: number;
  readonly native?: number;
}

function extractSessionId(filename: string): string {
  const match = filename.match(/rollout-[\dT-]+-(.+)\.jsonl?(?:\.zst)?$/);
  return match?.[1] ?? filename.replace(/\.jsonl?(?:\.zst)?$/, "");
}

/**
 * Codex zstd compresses cold rollouts and keeps the plain file when it reopens one.
 *
 * @param path - Directory entry to check.
 * @returns {boolean} Whether the entry is a rollout to read.
 */
function isRollout(path: string): boolean {
  if (path.endsWith(".jsonl")) return true;
  return path.endsWith(".jsonl.zst") && !existsSync(path.slice(0, -".zst".length));
}

/**
 * A JSONL rollout is named after its session, so an exact filter skips the
 * others unopened; a legacy JSON rollout carries its id inside and is settled
 * by `readJsonSession`.
 *
 * @param dir - Directory to walk recursively.
 * @param sessionId - Exact session filter.
 * @yields {Pick<SessionFile, "path" | "format">} Rollout files that can hold the session.
 */
function* walkSessions(
  dir: string,
  sessionId?: string,
): Generator<Pick<SessionFile, "path" | "format">> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkSessions(path, sessionId);
    else if (isRollout(path)) {
      if (!sessionId || extractSessionId(entry.name) === sessionId) yield { path, format: "jsonl" };
    } else if (entry.name.endsWith(".json")) yield { path, format: "json" };
  }
}

function textBlocks(content: unknown): Block[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((value) => {
    if (!isRecord(value)) return [];
    if (value.type !== "input_text" && value.type !== "output_text") return [];
    const text = scalarText(value.text);
    return text ? [{ type: "text" as const, text }] : [];
  });
}

function thinkingBlocks(entries: unknown): Block[] {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((value) => {
    if (!isRecord(value)) return [];
    const text = scalarText(value.text);
    return text ? [{ type: "thinking" as const, text }] : [];
  });
}

/**
 * Reads a reasoning item's summary entries, then the raw text some models add.
 *
 * @param payload - Native `reasoning` response item.
 * @returns {ParsedPayload | undefined} Thinking blocks, or `undefined` when only encrypted content is left.
 */
function reasoningPayload(payload: Readonly<Record<string, unknown>>): ParsedPayload | undefined {
  const blocks = [...thinkingBlocks(payload.summary), ...thinkingBlocks(payload.content)];
  if (blocks.length === 0) return undefined;
  return { role: "assistant", blocks };
}

function messagePayload(payload: Readonly<Record<string, unknown>>): ParsedPayload | undefined {
  const nativeRole = scalarText(payload.role) ?? "";
  if (nativeRole === "developer") return undefined;
  const blocks = textBlocks(payload.content);
  if (blocks.length === 0) return undefined;
  return { role: nativeRole === "assistant" ? "assistant" : "user", blocks };
}

function toolCallPayload(
  payload: Readonly<Record<string, unknown>>,
  input: unknown,
): ParsedPayload {
  return {
    role: "assistant",
    blocks: [
      {
        type: "tool_call",
        toolName: scalarText(payload.name) ?? "",
        toolCallId: scalarText(payload.call_id) ?? "",
        toolInput: scalarText(input) ?? "",
      },
    ],
  };
}

function toolOutputText(output: unknown): string {
  const scalar = scalarText(output);
  if (scalar !== undefined) return scalar;
  return textBlocks(output)
    .map((block) => block.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function toolOutputPayload(payload: Readonly<Record<string, unknown>>): ParsedPayload | undefined {
  const output = toolOutputText(payload.output);
  if (!output) return undefined;
  return {
    role: "tool",
    blocks: [
      {
        type: "tool_result",
        toolCallId: scalarText(payload.call_id) ?? "",
        text: output,
      },
    ],
  };
}

function parsePayload(payload: Readonly<Record<string, unknown>>): ParsedPayload | undefined {
  switch (payload.type) {
    case "message":
      return messagePayload(payload);
    case "reasoning":
      return reasoningPayload(payload);
    case "function_call":
      return toolCallPayload(payload, payload.arguments);
    case "custom_tool_call":
      return toolCallPayload(payload, payload.input);
    case "function_call_output":
    case "custom_tool_call_output":
      return toolOutputPayload(payload);
    default:
      return undefined;
  }
}

function parsedTimestamp(
  entry: Readonly<Record<string, unknown>>,
  fallback: number,
): ParsedTimestamp {
  const text = scalarText(entry.timestamp);
  const native = text ? new Date(text).getTime() : Number.NaN;
  return Number.isFinite(native) ? { timestamp: native, native } : { timestamp: fallback };
}

function sessionIdFromPath(path: string): string {
  return extractSessionId(path.split("/").pop() || "");
}

class MirrorTracker {
  private eventKeys = new Map<string, number>();
  private responseKeys = new Map<string, number>();
  private timestamp: number | undefined;

  private start(timestamp: number): void {
    if (timestamp === this.timestamp) return;
    this.eventKeys.clear();
    this.responseKeys.clear();
    this.timestamp = timestamp;
  }

  private consumeEvent(key: string): boolean {
    const count = this.eventKeys.get(key);
    if (!count) return false;
    if (count === 1) this.eventKeys.delete(key);
    else this.eventKeys.set(key, count - 1);
    return true;
  }

  private consumeResponse(key: string): boolean {
    const count = this.responseKeys.get(key);
    if (!count) return false;
    if (count === 1) this.responseKeys.delete(key);
    else this.responseKeys.set(key, count - 1);
    return true;
  }

  private rememberEvent(key: string): void {
    this.eventKeys.set(key, (this.eventKeys.get(key) ?? 0) + 1);
  }

  private rememberResponse(key: string): void {
    this.responseKeys.set(key, (this.responseKeys.get(key) ?? 0) + 1);
  }

  event(nativeTimestamp: number | undefined, text: string): boolean {
    if (nativeTimestamp === undefined) return false;
    this.start(nativeTimestamp);
    const key = `${nativeTimestamp}\0${text}`;
    if (this.consumeResponse(key)) return true;
    this.rememberEvent(key);
    return false;
  }

  response(nativeTimestamp: number | undefined, text: string): boolean {
    if (nativeTimestamp === undefined) return false;
    this.start(nativeTimestamp);
    const key = `${nativeTimestamp}\0${text}`;
    if (this.consumeEvent(key)) return true;
    this.rememberResponse(key);
    return false;
  }
}

class JsonlNormalizer {
  private cwd: string | undefined;
  private mirrors = new MirrorTracker();
  private source: string;
  private sessionId: string;
  private mtime: number;
  private userName: string;

  constructor(source: string, sessionId: string, mtime: number, userName: string) {
    this.source = source;
    this.sessionId = sessionId;
    this.mtime = mtime;
    this.userName = userName;
  }

  private eventMessage(
    entry: Readonly<Record<string, unknown>>,
    payload: Readonly<Record<string, unknown>>,
  ): Message | undefined {
    if (payload.type !== "user_message") return undefined;
    const text = scalarText(payload.message) ?? "";
    if (!text) return undefined;
    const timestamp = parsedTimestamp(entry, this.mtime);
    if (this.mirrors.event(timestamp.native, text)) return undefined;
    return {
      source: this.source,
      sessionId: this.sessionId,
      role: "user",
      timestampSource: timestamp.native === undefined ? "file" : "message",
      timestamp: timestamp.timestamp,
      date: new Date(timestamp.timestamp).toISOString().split("T")[0],
      blocks: [{ type: "text", text }],
      context: this.cwd ? { cwd: this.cwd } : undefined,
      channel: { platform: "cli", name: "codex" },
      author: { platform: "cli", name: this.userName },
    };
  }

  private responseMessage(
    entry: Readonly<Record<string, unknown>>,
    payload: Readonly<Record<string, unknown>>,
  ): Message | undefined {
    const parsed = parsePayload(payload);
    if (!parsed) return undefined;
    const timestamp = parsedTimestamp(entry, this.mtime);
    if (parsed.role === "user") {
      const text = parsed.blocks.map((block) => block.text || "").join("\n");
      if (this.mirrors.response(timestamp.native, text)) return undefined;
    }
    return {
      source: this.source,
      sessionId: this.sessionId,
      role: parsed.role,
      timestampSource: timestamp.native === undefined ? "file" : "message",
      timestamp: timestamp.timestamp,
      date: new Date(timestamp.timestamp).toISOString().split("T")[0],
      blocks: parsed.blocks,
      context: this.cwd ? { cwd: this.cwd } : undefined,
      channel: { platform: "cli", name: "codex" },
      author:
        parsed.role === "user"
          ? { platform: "cli", name: this.userName }
          : { platform: "cli", name: "codex", isBot: true },
    };
  }

  normalize(entry: Readonly<Record<string, unknown>>): Message | undefined {
    if (entry.type === "session_meta") {
      if (isRecord(entry.payload)) this.cwd = scalarText(entry.payload.cwd) || this.cwd;
      return undefined;
    }
    if (!isRecord(entry.payload)) return undefined;
    if (entry.type === "event_msg") return this.eventMessage(entry, entry.payload);
    if (entry.type === "response_item") return this.responseMessage(entry, entry.payload);
    return undefined;
  }
}

interface JsonSessionInfo {
  readonly id: string;
  readonly timestamp: number;
  readonly timestampSource: "session" | "file";
}

function readJsonObject(path: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const data = parseJson(readFileSync(path, "utf-8"));
    return isRecord(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

function jsonSessionInfo(
  data: Readonly<Record<string, unknown>>,
  file: SessionFile,
): JsonSessionInfo {
  const session = isRecord(data.session) ? data.session : undefined;
  const id = scalarText(session?.id) || sessionIdFromPath(file.path);
  const timestampText = scalarText(session?.timestamp);
  const nativeTimestamp = timestampText ? new Date(timestampText).getTime() : Number.NaN;
  const timestamp = Number.isFinite(nativeTimestamp) ? nativeTimestamp : file.mtime;
  return { id, timestamp, timestampSource: Number.isFinite(nativeTimestamp) ? "session" : "file" };
}

export class CodexSource implements Source {
  name = "codex";
  private sessionsDir: string;
  private userName: string;

  constructor(sessionsDir?: string) {
    this.sessionsDir = sessionsDir ?? join(home(), ".codex/sessions");
    this.userName = osUser();
  }

  available(): boolean {
    return existsSync(this.sessionsDir);
  }

  private *readJsonSession(file: SessionFile, sessionId?: string): Generator<Message> {
    const data = readJsonObject(file.path);
    if (!data || !Array.isArray(data.items)) return;
    const session = jsonSessionInfo(data, file);
    if (sessionId && session.id !== sessionId) return;

    for (const [index, item] of data.items.entries()) {
      if (!isRecord(item)) continue;
      const parsed = parsePayload(item);
      if (!parsed) continue;
      const timestamp = session.timestamp + index;
      yield {
        source: this.name,
        sessionId: session.id,
        role: parsed.role,
        timestamp,
        timestampSource: session.timestampSource,
        date: new Date(timestamp).toISOString().split("T")[0],
        blocks: parsed.blocks,
        channel: { platform: "cli", name: "codex" },
        author:
          parsed.role === "user"
            ? { platform: "cli", name: this.userName }
            : { platform: "cli", name: "codex", isBot: true },
      };
    }
  }

  private async *readJsonlSession(file: SessionFile): AsyncGenerator<Message> {
    const normalizer = new JsonlNormalizer(
      this.name,
      sessionIdFromPath(file.path),
      file.mtime,
      this.userName,
    );
    const lines = jsonlLines(file.path);
    for await (const line of lines) {
      const entry = parseJsonRecord(line);
      if (!entry) continue;
      const message = normalizer.normalize(entry);
      if (message) yield message;
    }
  }

  async *read(options?: SourceReadOptions): AsyncGenerator<Message> {
    const sessionId = options?.sessionId || undefined;
    const files: SessionFile[] = [];
    for (const file of walkSessions(this.sessionsDir, sessionId)) {
      files.push({ ...file, mtime: statSync(file.path).mtimeMs });
    }
    files.sort((left, right) => left.mtime - right.mtime);
    const active = activeFiles(files, (file) => sessionIdFromPath(file.path), options?.activeSince);
    for (const file of active) {
      if (file.format === "json") yield* this.readJsonSession(file, sessionId);
      else yield* this.readJsonlSession(file);
    }
  }
}
