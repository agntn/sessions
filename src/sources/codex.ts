import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { home, osUser } from "../core/env.ts";
import type { Block, Message, Source } from "../core/types.ts";
import { isRecord, parseJson, parseJsonRecord, scalarText } from "./parsing.ts";

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

function* walkSessions(dir: string): Generator<Pick<SessionFile, "path" | "format">> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkSessions(path);
    else if (entry.name.endsWith(".jsonl")) yield { path, format: "jsonl" };
    else if (entry.name.endsWith(".json")) yield { path, format: "json" };
  }
}

function extractSessionId(filename: string): string {
  const match = filename.match(/rollout-[\dT-]+-(.+)\.jsonl?$/);
  return match?.[1] ?? filename.replace(/\.jsonl?$/, "");
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

function messagePayload(payload: Readonly<Record<string, unknown>>): ParsedPayload | undefined {
  const nativeRole = scalarText(payload.role) ?? "";
  if (nativeRole === "developer") return undefined;
  const blocks = textBlocks(payload.content);
  if (blocks.length === 0) return undefined;
  return { role: nativeRole === "assistant" ? "assistant" : "user", blocks };
}

function functionCallPayload(payload: Readonly<Record<string, unknown>>): ParsedPayload {
  return {
    role: "assistant",
    blocks: [
      {
        type: "tool_call",
        toolName: scalarText(payload.name) ?? "",
        toolCallId: scalarText(payload.call_id) ?? "",
        toolInput: scalarText(payload.arguments) ?? "",
      },
    ],
  };
}

function functionOutputPayload(
  payload: Readonly<Record<string, unknown>>,
): ParsedPayload | undefined {
  const output = scalarText(payload.output) ?? "";
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
    case "function_call":
      return functionCallPayload(payload);
    case "function_call_output":
      return functionOutputPayload(payload);
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
  return { id, timestamp };
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

  private *readJsonSession(file: SessionFile): Generator<Message> {
    const data = readJsonObject(file.path);
    if (!data || !Array.isArray(data.items)) return;
    const session = jsonSessionInfo(data, file);

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
    const lines = createInterface({ input: createReadStream(file.path), crlfDelay: Infinity });
    for await (const line of lines) {
      const entry = parseJsonRecord(line);
      if (!entry) continue;
      const message = normalizer.normalize(entry);
      if (message) yield message;
    }
  }

  async *read(): AsyncGenerator<Message> {
    const files: SessionFile[] = [];
    for (const file of walkSessions(this.sessionsDir)) {
      files.push({ ...file, mtime: statSync(file.path).mtimeMs });
    }
    files.sort((left, right) => left.mtime - right.mtime);
    for (const file of files) {
      if (file.format === "json") yield* this.readJsonSession(file);
      else yield* this.readJsonlSession(file);
    }
  }
}
