import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Database } from 'db0'
import { createDatabase } from 'db0'
import type { Storage, Message } from '../core/types.ts'

/**
 * Migration version tracking table + versioned SQL migrations.
 * Uses a dedicated table instead of PRAGMA user_version for provider agnosticism.
 */
const MIGRATIONS: string[] = [
  // v1: core schema — sessions, messages, blocks, contexts, ingest state
  `CREATE TABLE IF NOT EXISTS memxa_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    started_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source);

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    date TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(source);
  CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date);
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);

  CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id),
    position INTEGER NOT NULL,
    type TEXT NOT NULL,
    text TEXT,
    tool_name TEXT,
    tool_input TEXT,
    tool_call_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_blocks_message ON blocks(message_id);
  CREATE INDEX IF NOT EXISTS idx_blocks_type ON blocks(type);

  CREATE TABLE IF NOT EXISTS contexts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id),
    key TEXT NOT NULL,
    value TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_contexts_message ON contexts(message_id);

  CREATE TABLE IF NOT EXISTS ingest_state (
    source TEXT PRIMARY KEY,
    cursor TEXT NOT NULL,
    last_run INTEGER NOT NULL
  );`,
]

/** Row types for typed query results */
interface IngestRow {
  source: string
  cursor: string
  last_run: number
}

interface CountRow {
  value: number
}

export interface SearchRow {
  date: string
  source: string
  role: string
  session_id: string
  text: string
}

export interface Db0StorageOptions {
  /** db0 connector to use (e.g. better-sqlite3, libsql, node-sqlite) */
  connector: Parameters<typeof createDatabase>[0]
}

export class Db0Storage implements Storage {
  private db: Database

  constructor(options: Db0StorageOptions) {
    this.db = createDatabase(options.connector)
  }

  async init(): Promise<void> {
    // Ensure migration tracking table exists
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS memxa_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `)

    // Get current version
    const row = await this.db.prepare(
      'SELECT MAX(version) as version FROM memxa_migrations'
    ).get() as { version: number | null } | undefined
    const currentVersion = row?.version ?? 0

    if (currentVersion >= MIGRATIONS.length) return

    const pending = MIGRATIONS.length - currentVersion
    process.stderr.write(`[memxa] Migrating DB: v${currentVersion} → v${MIGRATIONS.length} (${pending} pending)\n`)

    for (let i = currentVersion; i < MIGRATIONS.length; i++) {
      try {
        // Split multi-statement SQL and exec each
        const statements = MIGRATIONS[i]
          .split(';')
          .map(s => s.trim())
          .filter(s => s.length > 0)

        await this.db.exec('BEGIN')
        for (const stmt of statements) {
          await this.db.exec(stmt)
        }
        // Record migration
        await this.db.prepare(
          'INSERT INTO memxa_migrations (version, applied_at) VALUES (?, ?)'
        ).run(i + 1, Date.now())
        await this.db.exec('COMMIT')

        process.stderr.write(`[memxa] Applied migration v${i + 1}\n`)
      } catch (err) {
        await this.db.exec('ROLLBACK').catch(() => {})
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[memxa] MIGRATION v${i + 1} FAILED: ${msg}\n`)
        throw err
      }
    }
  }

  async insert(batch: Message[]): Promise<void> {
    const seenSessions = new Set<string>()

    await this.db.exec('BEGIN')
    try {
      for (const m of batch) {
        const sid = m.sessionId || `${m.source}-${m.date}`

        if (!seenSessions.has(sid)) {
          await this.db.prepare(
            'INSERT OR IGNORE INTO sessions (id, source, started_at) VALUES (?, ?, ?)'
          ).run(sid, m.source, m.timestamp)
          seenSessions.add(sid)
        }

        const result = await this.db.sql`
          INSERT INTO messages (source, session_id, role, timestamp, date)
          VALUES (${m.source}, ${sid}, ${m.role}, ${m.timestamp}, ${m.date})
        `
        const messageId = result?.lastInsertRowid ?? result?.rows?.[0]?.id

        if (messageId == null) {
          throw new Error('Failed to get lastInsertRowid for message')
        }

        for (let i = 0; i < m.blocks.length; i++) {
          const b = m.blocks[i]
          await this.db.prepare(
            'INSERT INTO blocks (message_id, position, type, text, tool_name, tool_input, tool_call_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).run(
            messageId, i, b.type,
            b.text ?? null,
            b.toolName ?? null,
            b.toolInput ?? null,
            b.toolCallId ?? null,
          )
        }

        if (m.context) {
          for (const [key, value] of Object.entries(m.context)) {
            await this.db.prepare(
              'INSERT INTO contexts (message_id, key, value) VALUES (?, ?, ?)'
            ).run(messageId, key, value)
          }
        }
      }
      await this.db.exec('COMMIT')
    } catch (err) {
      await this.db.exec('ROLLBACK').catch(() => {})
      throw err
    }
  }

  async getCursor(source: string): Promise<string> {
    const row = await this.db.prepare(
      'SELECT cursor FROM ingest_state WHERE source = ?'
    ).get(source) as IngestRow | undefined
    return row?.cursor ?? '0'
  }

  async setCursor(source: string, cursor: string): Promise<void> {
    await this.db.prepare(
      'INSERT OR REPLACE INTO ingest_state (source, cursor, last_run) VALUES (?, ?, ?)'
    ).run(source, cursor, Date.now())
  }

  async count(source?: string): Promise<number> {
    if (source) {
      const row = await this.db.prepare(
        'SELECT COUNT(*) as value FROM messages WHERE source = ?'
      ).get(source) as CountRow | undefined
      return row?.value ?? 0
    }
    const row = await this.db.prepare(
      'SELECT COUNT(*) as value FROM messages'
    ).get() as CountRow | undefined
    return row?.value ?? 0
  }

  async search(query: string, opts?: {
    source?: string
    role?: string
    limit?: number
    dateFrom?: string
    dateTo?: string
  }): Promise<SearchRow[]> {
    const limit = opts?.limit ?? 20
    const queryLower = `%${query.trim().toLowerCase()}%`

    const filterParts: string[] = ["b.type IN ('text', 'thinking')"]
    const filterParams: (string | number)[] = [queryLower]

    if (opts?.source) {
      filterParts.push('m.source = ?')
      filterParams.push(opts.source)
    }
    if (opts?.role) {
      filterParts.push('m.role = ?')
      filterParams.push(opts.role)
    }
    if (opts?.dateFrom) {
      filterParts.push('m.date >= ?')
      filterParams.push(opts.dateFrom)
    }
    if (opts?.dateTo) {
      filterParts.push('m.date <= ?')
      filterParams.push(opts.dateTo)
    }

    filterParams.push(limit)

    // Fallback to LIKE-based search (provider-agnostic, no FTS dependency)
    const sql = `
      SELECT DISTINCT m.date, m.source, m.role, m.session_id,
        substr(b.text, max(1, instr(lower(b.text), ?) - 80), 300) as text
      FROM blocks b
      JOIN messages m ON m.id = b.message_id
      WHERE lower(b.text) LIKE ?
        AND ${filterParts.join(' AND ')}
      ORDER BY m.timestamp DESC
      LIMIT ?
    `

    // first param for instr (highlight), second for LIKE
    const firstWord = query.trim().toLowerCase().split(/\s+/)[0] || ''
    return await this.db.prepare(sql).all(
      firstWord, ...filterParams
    ) as SearchRow[]
  }

  async sessionCount(): Promise<number> {
    const row = await this.db.prepare(
      'SELECT COUNT(*) as value FROM sessions'
    ).get() as CountRow | undefined
    return row?.value ?? 0
  }

  async sourceStats(): Promise<Array<{ source: string, messages: number, sessions: number }>> {
    return await this.db.prepare(`
      SELECT source,
        COUNT(DISTINCT id) as messages,
        COUNT(DISTINCT session_id) as sessions
      FROM messages
      GROUP BY source
      ORDER BY messages DESC
    `).all() as Array<{ source: string, messages: number, sessions: number }>
  }

  async close(): Promise<void> {
    await this.db.dispose()
  }
}

/**
 * Create a Db0Storage with better-sqlite3 connector.
 * Convenience factory for the most common local use case.
 */
export async function createSqliteStorage(path: string): Promise<Db0Storage> {
  mkdirSync(dirname(path), { recursive: true })

  const { default: connector } = await import('db0/connectors/better-sqlite3')
  const storage = new Db0Storage({
    connector: connector({ path }),
  })
  await storage.init()
  return storage
}
