import { home, osUser } from "../core/env.ts";
import { join } from "node:path";
import { existsSync, readdirSync, statSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Source, Message, Block, Channel, Participant } from "../core/types.ts";

function parseBlocks(content: unknown): Block[] {
  if (!Array.isArray(content)) return [];
  const out: Block[] = [];
  for (const b of content) {
    if (typeof b !== "object" || b === null) continue;
    const block = b as Record<string, unknown>;
    switch (block.type) {
      case "text":
        if (block.text) out.push({ type: "text", text: String(block.text) });
        break;
      case "thinking":
        if (block.thinking) out.push({ type: "thinking", text: String(block.thinking) });
        break;
      case "toolCall":
        out.push({
          type: "tool_call",
          toolName: String(block.name || ""),
          toolCallId: String(block.id || ""),
          toolInput:
            typeof block.arguments === "string"
              ? block.arguments
              : JSON.stringify(block.arguments ?? ""),
        });
        break;
    }
  }
  return out;
}

function* walkJsonl(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJsonl(full);
    else if (entry.name.endsWith(".jsonl")) yield full;
  }
}

export class OmpSource implements Source {
  name = "omp";
  private sessionsDir: string;
  private channel: Channel = { platform: "cli", name: "omp" };
  private user: Participant;

  constructor(sessionsDir?: string) {
    this.sessionsDir = sessionsDir ?? join(home(), ".omp/agent/sessions");
    this.user = { platform: "cli", name: osUser() };
  }

  available(): boolean {
    return existsSync(this.sessionsDir);
  }

  async *read(): AsyncGenerator<Message> {
    const files: { path: string; mtime: number }[] = [];
    for (const f of walkJsonl(this.sessionsDir)) {
      files.push({ path: f, mtime: statSync(f).mtimeMs });
    }
    files.sort((a, b) => a.mtime - b.mtime);

    for (const file of files) {
      // The id lives in the `session` entry and matches the file name; a
      // leading `title` entry can precede it, so the file stem stays the
      // fallback for headerless or truncated transcripts.
      let sessionId = file.path.split("/").pop()?.split("_").pop()?.replace(".jsonl", "") || "";
      const rl = createInterface({
        input: createReadStream(file.path),
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }

        if (entry.type === "session") {
          sessionId = String(entry.id || sessionId);
          continue;
        }
        if (entry.type !== "message") continue;

        const msg = entry.message as Record<string, unknown> | undefined;
        if (!msg) continue;

        const nativeRole = String(msg.role || "");
        const role =
          nativeRole === "assistant"
            ? ("assistant" as const)
            : nativeRole === "user"
              ? ("user" as const)
              : nativeRole === "toolResult"
                ? ("tool" as const)
                : null;
        if (!role) continue;

        // A toolResult carries its payload as text blocks plus the call it
        // answers, so it maps to one tool_result block outside parseBlocks.
        // A malformed non-array content yields no payload and drops the entry.
        const blocks =
          role === "tool"
            ? Array.isArray(msg.content)
              ? [
                  {
                    type: "tool_result" as const,
                    toolCallId: String(msg.toolCallId || ""),
                    text: (msg.content as unknown[])
                      .filter(
                        (b): b is Record<string, unknown> =>
                          typeof b === "object" &&
                          b !== null &&
                          (b as Record<string, unknown>).type === "text",
                      )
                      .map((b) => String(b.text || ""))
                      .join("\n"),
                  },
                ]
              : []
            : parseBlocks(msg.content);
        if (!blocks.length || (role === "tool" && !blocks[0]!.text)) continue;

        const parsed = entry.timestamp ? new Date(String(entry.timestamp)).getTime() : NaN;
        const ts = Number.isFinite(parsed) ? parsed : file.mtime;
        const date = new Date(ts).toISOString().split("T")[0];

        yield {
          source: this.name,
          sessionId,
          role,
          timestamp: ts,
          date,
          blocks,
          channel: this.channel,
          author: role === "user" ? this.user : { platform: "cli", name: "omp", isBot: true },
        };
      }
    }
  }
}
