import { home } from '../core/env.ts'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { Source, Message } from '../core/types.ts'

export class OpenCodeSource implements Source {
  name = 'opencode'
  private dbPath: string

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? join(home(), '.local/share/opencode/opencode.db')
  }

  available(): boolean {
    return existsSync(this.dbPath)
  }

  async *ingest(cursor: string): AsyncGenerator<Message> {
    const since = Number(cursor) || 0
    const db = new Database(this.dbPath, { readonly: true })
    try {
      const rows = db.prepare(`
        SELECT
          p.data as pdata,
          json_extract(m.data, '$.role') as role,
          p.time_created as tc,
          p.session_id as sid
        FROM part p
        JOIN message m ON p.message_id = m.id
        WHERE p.time_created > ?
        ORDER BY p.time_created
      `).iterate(since) as IterableIterator<{
        pdata: string
        role: string
        tc: number
        sid: string
      }>

      for (const row of rows) {
        if (row.role !== 'user' && row.role !== 'assistant') continue

        let part: Record<string, unknown>
        try { part = JSON.parse(row.pdata) } catch { continue }

        const ptype = String(part.type || '')
        if (ptype === 'text') {
          const text = String(part.text || '')
          if (text.length <= 2) continue

          yield {
            source: this.name,
            sessionId: row.sid,
            role: row.role as 'user' | 'assistant',
            timestamp: row.tc,
            date: new Date(row.tc).toISOString().split('T')[0],
            blocks: [{ type: 'text', text: text.slice(0, 8000) }],
          }
        } else if (ptype === 'tool-invocation' || ptype === 'tool-call') {
          yield {
            source: this.name,
            sessionId: row.sid,
            role: row.role as 'user' | 'assistant',
            timestamp: row.tc,
            date: new Date(row.tc).toISOString().split('T')[0],
            blocks: [{
              type: 'tool_call',
              toolName: String(part.toolName || part.name || ''),
              toolCallId: String(part.toolCallId || part.id || ''),
              toolInput: typeof part.args === 'string' ? part.args
                : typeof part.input === 'string' ? part.input
                : JSON.stringify(part.args || part.input || ''),
            }],
          }
        } else if (ptype === 'tool-result') {
          yield {
            source: this.name,
            sessionId: row.sid,
            role: 'tool',
            timestamp: row.tc,
            date: new Date(row.tc).toISOString().split('T')[0],
            blocks: [{
              type: 'tool_result',
              toolCallId: String(part.toolCallId || ''),
              text: typeof part.result === 'string' ? part.result.slice(0, 8000)
                : JSON.stringify(part.result || '').slice(0, 8000),
            }],
          }
        }
      }
    } finally {
      db.close()
    }
  }

  cursor(messages: Message[]): string {
    if (!messages.length) return '0'
    return String(messages[messages.length - 1].timestamp)
  }
}

/** Factory function for OpenCode source. */
export function opencode(dbPath?: string): () => OpenCodeSource {
  return () => new OpenCodeSource(dbPath)
}
