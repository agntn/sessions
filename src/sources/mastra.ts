import Database from 'better-sqlite3'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { Source, Message, Block } from '../core/types.ts'

function parseContent(raw: string): Block[] {
  try {
    const parsed = JSON.parse(raw)
    if (parsed?.format === 2 && Array.isArray(parsed.parts)) {
      const out: Block[] = []
      for (const p of parsed.parts) {
        if (p.type === 'text' && p.text) {
          out.push({ type: 'text', text: String(p.text).slice(0, 8000) })
        } else if (p.type === 'tool-invocation' || p.type === 'tool-call') {
          out.push({
            type: 'tool_call',
            toolName: String(p.toolName || p.name || ''),
            toolCallId: String(p.toolCallId || p.id || ''),
            toolInput: typeof p.args === 'string' ? p.args : JSON.stringify(p.args),
          })
        } else if (p.type === 'tool-result') {
          out.push({
            type: 'tool_result',
            toolCallId: String(p.toolCallId || ''),
            text: typeof p.result === 'string' ? p.result.slice(0, 8000) : JSON.stringify(p.result).slice(0, 8000),
          })
        }
      }
      return out
    }
    if (typeof parsed?.content === 'string') {
      return [{ type: 'text', text: parsed.content.slice(0, 8000) }]
    }
    if (typeof parsed === 'string') {
      return parsed.length > 2 ? [{ type: 'text', text: parsed.slice(0, 8000) }] : []
    }
  } catch {}
  return raw.length > 2 ? [{ type: 'text', text: raw.slice(0, 8000) }] : []
}

export class MastraSource implements Source {
  name = 'mastra'
  private dbPath: string

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? join(process.env.HOME!, '.local/share/mastracode/mastra.db')
  }

  available(): boolean {
    return existsSync(this.dbPath)
  }

  async *ingest(cursor: string): AsyncGenerator<Message> {
    const db = new Database(this.dbPath, { readonly: true })
    try {
      const rows = db.prepare(`
        SELECT role, content, createdAt, thread_id
        FROM mastra_messages
        WHERE createdAt > ? AND role IN ('user', 'assistant')
        ORDER BY createdAt
      `).all(cursor || '1970-01-01') as {
        role: string
        content: string
        createdAt: string
        thread_id: string
      }[]

      for (const row of rows) {
        const entryBlocks = parseContent(row.content)
        if (!entryBlocks.length) continue

        const date = row.createdAt?.split('T')[0]
        if (!date) continue

        yield {
          source: this.name,
          sessionId: row.thread_id,
          role: row.role as 'user' | 'assistant',
          timestamp: new Date(row.createdAt).getTime(),
          date,
          blocks: entryBlocks,
        }
      }
    } finally {
      db.close()
    }
  }

  cursor(messages: Message[]): string {
    if (!messages.length) return ''
    return new Date(messages[messages.length - 1].timestamp).toISOString()
  }
}

/** Factory function for Mastra source. */
export function mastra(dbPath?: string): () => MastraSource {
  return () => new MastraSource(dbPath)
}
