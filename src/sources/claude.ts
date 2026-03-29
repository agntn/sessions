import { home, osUser } from "../core/env.ts";
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseFrontmatter } from "../core/frontmatter.ts";
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

function decodeProjectPath(encoded: string): string {
  return encoded.replace(/^-/, "/").replace(/-/g, "/");
}

function* walkMemoryFiles(
  baseDir: string,
): Generator<{ path: string; project: string; mtime: number }> {
  if (!existsSync(baseDir)) return;
  for (const projectDir of readdirSync(baseDir, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue;
    const memoryDir = join(baseDir, projectDir.name, "memory");
    if (!existsSync(memoryDir)) continue;

    const project = decodeProjectPath(projectDir.name);

    for (const file of readdirSync(memoryDir, { withFileTypes: true })) {
      if (!file.name.endsWith(".md")) continue;
      if (file.name === "MEMORY.md") continue;
      const full = join(memoryDir, file.name);
      yield { path: full, project, mtime: statSync(full).mtimeMs };
    }
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

  async estimate(cursor: string): Promise<number> {
    const parsed = Number(cursor);
    const since = Number.isFinite(parsed) ? parsed : 0;
    let count = 0;
    for (const f of walkJsonl(this.projectsDir)) {
      if (statSync(f).mtimeMs >= since) count++;
    }
    for (const f of walkMemoryFiles(this.projectsDir)) {
      if (f.mtime >= since) count++;
    }
    return count;
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

    // Memory markdown files
    const memoryChannel: Channel = { platform: "cli", name: "claude-code", type: "memory" };
    const memoryFiles: { path: string; project: string; mtime: number }[] = [];
    for (const f of walkMemoryFiles(this.projectsDir)) {
      memoryFiles.push(f);
    }
    memoryFiles.sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));

    for (const file of memoryFiles) {
      if (file.mtime < since) continue;

      let raw: string;
      try {
        raw = readFileSync(file.path, "utf-8");
      } catch {
        continue;
      }

      const { meta, body } = parseFrontmatter(raw);
      if (!body) continue;

      const context: Record<string, string> = { project: file.project };
      if (meta.name) context.memoryName = meta.name;
      if (meta.description) context.memoryDescription = meta.description;
      if (meta.type) context.memoryType = meta.type;

      yield {
        source: this.name,
        sessionId: `claude-memory:${file.project}`,
        role: "assistant" as const,
        timestamp: file.mtime,
        date: new Date(file.mtime).toISOString().split("T")[0],
        blocks: [{ type: "text", text: body.slice(0, 8000) }],
        context,
        channel: memoryChannel,
        author: { platform: "cli", name: "claude-code", isBot: true },
      };
    }
  }

  cursor(message: Message): string {
    return String(message.timestamp);
  }
}
