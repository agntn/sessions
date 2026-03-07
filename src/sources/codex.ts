import { home } from '../core/env.ts'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { Source, Message } from '../core/types.ts'

export class CodexSource implements Source {
  name = 'codex'
  private dbPath: string

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? join(home(), '.codex/state_5.sqlite')
  }

  available(): boolean {
    return existsSync(this.dbPath)
  }

  async *ingest(cursor: string): AsyncGenerator<Message> {
    const since = Number(cursor) || 0
    const db = new Database(this.dbPath, { readonly: true })
    try {
      const rows = db.prepare(`
        SELECT id, first_user_message, cwd, updated_at
        FROM threads
        WHERE updated_at > ? AND length(first_user_message) > 2
        ORDER BY updated_at
      `).all(since) as {
        id: string
        first_user_message: string
        cwd: string
        updated_at: number
      }[]

      for (const row of rows) {
        const ts = row.updated_at * 1000
        const date = new Date(ts).toISOString().split('T')[0]

        yield {
          source: this.name,
          sessionId: row.id,
          role: 'user',
          timestamp: ts,
          date,
          blocks: [{ type: 'text', text: row.first_user_message.slice(0, 8000) }],
          context: row.cwd ? { cwd: row.cwd } : undefined,
        }
      }
    } finally {
      db.close()
    }
  }

  cursor(messages: Message[]): string {
    if (!messages.length) return '0'
    return String(Math.floor(messages[messages.length - 1].timestamp / 1000))
  }
}

/** Factory function for Codex source. */
export function codex(dbPath?: string): () => CodexSource {
  return () => new CodexSource(dbPath)
}
