import { home, osUser } from "../core/env.ts";
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Source, Message, Block, Channel, Participant } from "../core/types.ts";

function* walkSessions(dir: string): Generator<{ path: string; format: "jsonl" | "json" }> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkSessions(full);
    else if (entry.name.endsWith(".jsonl")) yield { path: full, format: "jsonl" };
    else if (entry.name.endsWith(".json")) yield { path: full, format: "json" };
  }
}

function extractSessionId(filename: string): string {
  const match = filename.match(/rollout-[\dT-]+-(.+)\.jsonl?$/);
  return match?.[1] ?? filename.replace(/\.jsonl?$/, "");
}

function parseBlocks(
  payload: Record<string, unknown>,
): { role: Message["role"]; blocks: Block[] } | null {
  const type = String(payload.type || "");

  if (type === "message") {
    const role = String(payload.role || "");
    if (role === "developer") return null;

    const memxaRole = role === "assistant" ? ("assistant" as const) : ("user" as const);
    const content = payload.content as Array<Record<string, unknown>> | null;
    if (!content?.length) return null;

    const blocks: Block[] = [];
    for (const c of content) {
      const cType = String(c.type || "");
      if ((cType === "input_text" || cType === "output_text") && c.text) {
        const text = String(c.text);
        if (text.length > 0) blocks.push({ type: "text", text });
      }
    }

    return blocks.length ? { role: memxaRole, blocks } : null;
  }

  if (type === "function_call") {
    return {
      role: "assistant",
      blocks: [
        {
          type: "tool_call",
          toolName: String(payload.name || ""),
          toolCallId: String(payload.call_id || ""),
          toolInput: String(payload.arguments || ""),
        },
      ],
    };
  }

  if (type === "function_call_output") {
    const output = String(payload.output || "");
    if (!output) return null;
    return {
      role: "tool",
      blocks: [
        {
          type: "tool_result",
          toolCallId: String(payload.call_id || ""),
          text: output,
        },
      ],
    };
  }

  return null;
}

function* parseJsonSession(
  path: string,
  mtime: number,
  since: number,
  sourceName: string,
  channel: Channel,
  user: Participant,
): Generator<Message> {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return;
  }

  const session = data.session as Record<string, unknown> | undefined;
  const items = data.items as Array<Record<string, unknown>> | undefined;
  if (!items?.length) return;

  const sessionId = String(session?.id || extractSessionId(path.split("/").pop() || ""));
  const parsedSessionTs = session?.timestamp ? new Date(String(session.timestamp)).getTime() : NaN;
  const sessionTs = Number.isFinite(parsedSessionTs) ? parsedSessionTs : mtime;

  for (const [index, item] of items.entries()) {
    const parsed = parseBlocks(item);
    if (!parsed) continue;

    const ts = sessionTs + index;
    if (ts <= since) continue;

    yield {
      source: sourceName,
      sessionId,
      role: parsed.role,
      timestamp: ts,
      date: new Date(ts).toISOString().split("T")[0],
      blocks: parsed.blocks,
      channel,
      author: parsed.role === "user" ? user : { platform: "cli", name: "codex", isBot: true },
    };
  }
}

export class CodexSource implements Source {
  name = "codex";
  private sessionsDir: string;
  private channel: Channel = { platform: "cli", name: "codex" };
  private user: Participant;

  constructor(sessionsDir?: string) {
    this.sessionsDir = sessionsDir ?? join(home(), ".codex/sessions");
    this.user = { platform: "cli", name: osUser() };
  }

  available(): boolean {
    return existsSync(this.sessionsDir);
  }

  async *read(): AsyncGenerator<Message> {
    const since = 0;

    const files: { path: string; mtime: number; format: "jsonl" | "json" }[] = [];
    for (const f of walkSessions(this.sessionsDir)) {
      const mt = statSync(f.path).mtimeMs;
      files.push({ path: f.path, mtime: mt, format: f.format });
    }
    files.sort((a, b) => a.mtime - b.mtime);

    for (const file of files) {
      if (file.mtime < since) continue;

      if (file.format === "json") {
        yield* parseJsonSession(file.path, file.mtime, since, this.name, this.channel, this.user);
        continue;
      }

      const sessionId = extractSessionId(file.path.split("/").pop() || "");

      const rl = createInterface({
        input: createReadStream(file.path),
        crlfDelay: Infinity,
      });

      let cwd: string | undefined;
      let seenUserEvent = false;

      for await (const line of rl) {
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }

        const eventType = String(entry.type || "");

        if (eventType === "session_meta") {
          const p = entry.payload as Record<string, unknown> | undefined;
          if (p?.cwd) cwd = String(p.cwd);
          continue;
        }

        if (eventType === "event_msg") {
          const p = entry.payload as Record<string, unknown> | undefined;
          if (p?.type === "user_message" && !seenUserEvent) {
            seenUserEvent = true;
            const text = String(p.message || "");
            if (text.length > 0) {
              const parsedTs = new Date(String(entry.timestamp)).getTime();
              const ts = Number.isFinite(parsedTs) ? parsedTs : file.mtime;
              if (ts <= since) continue;
              yield {
                source: this.name,
                sessionId,
                role: "user",
                timestamp: ts,
                date: new Date(ts).toISOString().split("T")[0],
                blocks: [{ type: "text", text }],
                context: cwd ? { cwd } : undefined,
                channel: this.channel,
                author: this.user,
              };
            }
          }
          continue;
        }

        if (eventType !== "response_item") continue;

        const payload = entry.payload as Record<string, unknown> | undefined;
        if (!payload) continue;

        if (payload.type === "message" && payload.role === "user") {
          if (seenUserEvent) continue;
        }

        const parsed = parseBlocks(payload);
        if (!parsed) continue;

        const parsedEntryTs = new Date(String(entry.timestamp)).getTime();
        const ts = Number.isFinite(parsedEntryTs) ? parsedEntryTs : file.mtime;
        if (ts <= since) continue;

        yield {
          source: this.name,
          sessionId,
          role: parsed.role,
          timestamp: ts,
          date: new Date(ts).toISOString().split("T")[0],
          blocks: parsed.blocks,
          context: cwd ? { cwd } : undefined,
          channel: this.channel,
          author:
            parsed.role === "user" ? this.user : { platform: "cli", name: "codex", isBot: true },
        };
      }
    }
  }
}
