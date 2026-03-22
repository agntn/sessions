import { home, osUser } from "../core/env.ts";
import { join } from "node:path";
import { existsSync, readdirSync, statSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Source, Message, Block, Channel, Participant } from "../core/types.ts";

function parseBlocks(content: unknown): Block[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content.slice(0, 8000) }] : [];
  }
  if (!Array.isArray(content)) return [];

  const out: Block[] = [];
  for (const b of content) {
    const block = b as Record<string, unknown>;
    switch (block.type) {
      case "text":
        if (block.text) out.push({ type: "text", text: String(block.text).slice(0, 8000) });
        break;
      case "thinking":
        if (block.thinking)
          out.push({ type: "thinking", text: String(block.thinking).slice(0, 8000) });
        break;
      case "tool_use":
        out.push({
          type: "tool_call",
          toolName: String(block.name || ""),
          toolCallId: String(block.id || ""),
          toolInput: typeof block.input === "string" ? block.input : JSON.stringify(block.input),
        });
        break;
      case "tool_result":
        out.push({
          type: "tool_result",
          toolCallId: String(block.tool_use_id || ""),
          text:
            typeof block.content === "string"
              ? block.content.slice(0, 8000)
              : Array.isArray(block.content)
                ? (block.content as Record<string, unknown>[])
                    .filter((c) => c.type === "text")
                    .map((c) => String(c.text || ""))
                    .join("\n")
                    .slice(0, 8000)
                : "",
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

export class ClaudeSource implements Source {
  name = "claude";
  private projectsDir: string;
  private channel: Channel = { platform: "cli", name: "claude-code" };
  private user: Participant;

  constructor(projectsDir?: string) {
    this.projectsDir = projectsDir ?? join(home(), ".claude/projects");
    this.user = { platform: "cli", name: osUser() };
  }

  available(): boolean {
    return existsSync(this.projectsDir);
  }

  async *ingest(cursor: string): AsyncGenerator<Message> {
    const parsedCursor = Number(cursor);
    const since = Number.isFinite(parsedCursor) ? parsedCursor : 0;

    const files: { path: string; mtime: number }[] = [];
    for (const f of walkJsonl(this.projectsDir)) {
      files.push({ path: f, mtime: statSync(f).mtimeMs });
    }
    files.sort((a, b) => a.mtime - b.mtime);

    for (const file of files) {
      if (file.mtime < since) continue;

      const sessionId = file.path.split("/").pop()?.replace(".jsonl", "") || "";

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

        const type = String(entry.type || "");
        const role =
          type === "assistant"
            ? ("assistant" as const)
            : type === "user" || type === "human"
              ? ("user" as const)
              : null;
        if (!role) continue;

        const msg = entry.message as Record<string, unknown> | undefined;
        if (!msg) continue;

        const entryBlocks = parseBlocks(msg.content);
        if (!entryBlocks.length) continue;

        const parsed = entry.timestamp ? new Date(String(entry.timestamp)).getTime() : NaN;
        const ts = Number.isFinite(parsed) ? parsed : file.mtime;
        if (ts <= since) continue;
        const date = new Date(ts).toISOString().split("T")[0];

        yield {
          source: this.name,
          sessionId,
          role,
          timestamp: ts,
          date,
          blocks: entryBlocks,
          channel: this.channel,
          author:
            role === "user" ? this.user : { platform: "cli", name: "claude-code", isBot: true },
        };
      }
    }
  }

  cursor(message: Message): string {
    return String(message.timestamp);
  }
}
