import Database from 'better-sqlite3'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { Source, Message, Block } from '../core/types.ts'

export class AeiSource implements Source {
  name = 'aei'
  private dbPath: string

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? join(process.env.HOME!, '.config/aei/.cache/memory.db')
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
          m.id, m.session_id, m.role, m.timestamp, m.date,
          m.cwd, m.git_branch, m.git_commit, m.git_worktree, m.git_dirty,
          m.model, m.sender_id,
          s.project, s.git_remote, s.hostname, s.os_user, s.initiator_id
        FROM messages m
        JOIN sessions s ON m.session_id = s.id
        WHERE m.source = 'aei-cli' AND m.timestamp > ?
        ORDER BY m.timestamp
      `).iterate(since) as IterableIterator<{
        id: number
        session_id: string
        role: string
        timestamp: number
        date: string
        cwd: string | null
        git_branch: string | null
        git_commit: string | null
        git_worktree: string | null
        git_dirty: number | null
        model: string | null
        sender_id: string | null
        project: string | null
        git_remote: string | null
        hostname: string | null
        os_user: string | null
        initiator_id: string | null
      }>

      const blockStmt = db.prepare(`
        SELECT position, type, text, tool_name, tool_input, tool_call_id
        FROM blocks
        WHERE message_id = ?
        ORDER BY position
      `)

      for (const row of rows) {
        const role = row.role as 'user' | 'assistant' | 'tool'
        if (role !== 'user' && role !== 'assistant' && role !== 'tool') continue

        const blockRows = blockStmt.all(row.id) as Array<{
          position: number
          type: string
          text: string | null
          tool_name: string | null
          tool_input: string | null
          tool_call_id: string | null
        }>

        const blocks: Block[] = []
        for (const b of blockRows) {
          const block: Block = { type: b.type as Block['type'] }
          if (b.text) block.text = b.text.slice(0, 8000)
          if (b.tool_name) block.toolName = b.tool_name
          if (b.tool_input) block.toolInput = b.tool_input.slice(0, 8000)
          if (b.tool_call_id) block.toolCallId = b.tool_call_id
          blocks.push(block)
        }

        if (!blocks.length) continue

        const context: Record<string, string> = {}
        if (row.cwd) context.cwd = row.cwd
        if (row.git_branch) context.git_branch = row.git_branch
        if (row.git_commit) context.git_commit = row.git_commit
        if (row.git_worktree) context.git_worktree = row.git_worktree
        if (row.git_dirty !== null) context.git_dirty = String(row.git_dirty)
        if (row.model) context.model = row.model
        if (row.sender_id) context.sender_id = row.sender_id
        if (row.project) context.project = row.project
        if (row.git_remote) context.git_remote = row.git_remote
        if (row.hostname) context.hostname = row.hostname
        if (row.os_user) context.os_user = row.os_user
        if (row.initiator_id) context.initiator_id = row.initiator_id

        yield {
          source: this.name,
          sessionId: row.session_id,
          role,
          timestamp: row.timestamp,
          date: row.date || new Date(row.timestamp).toISOString().split('T')[0],
          blocks,
          context: Object.keys(context).length ? context : undefined,
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

/** Factory function for AEI source. */
export function aei(dbPath?: string): () => AeiSource {
  return () => new AeiSource(dbPath)
}
