import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { count, desc, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { Message, SearchRow, SourceStats, Storage } from '../core/types.ts'
import { blocks, contexts, ingestState, memxaMetadata, messages, schema, sessions } from './schema.ts'

interface SqliteStorageInitOptions {
  initialize?: boolean
}

function resolveMigrationsFolder(): string {
   const baseDir = dirname(fileURLToPath(import.meta.url))
   const candidates = [
     resolve(baseDir, '../../drizzle'),
     resolve(baseDir, '../drizzle'),
   ]
 
   for (const candidate of candidates) {
     if (existsSync(candidate)) return candidate
   }
 
   throw new Error('Cannot find drizzle migrations folder. Searched: ' + candidates.join(', '))
 }

export class SqliteStorage implements Storage {
  private sqlite: Database.Database
  private db: ReturnType<typeof drizzle<typeof schema>>

   constructor(path: string) {
     mkdirSync(dirname(path), { recursive: true })
     this.sqlite = new Database(path)
     this.db = drizzle(this.sqlite, { schema })
     this.sqlite.pragma('journal_mode = WAL')
     this.sqlite.pragma('busy_timeout = 5000')
     this.sqlite.pragma('foreign_keys = ON')
   }

   async init(): Promise<void> {
     const legacyVersion = this.sqlite.pragma('user_version', { simple: true }) as number
    migrate(this.db, { migrationsFolder: resolveMigrationsFolder() })

    if (legacyVersion > 0) {
      const existing = this.db.select({ value: memxaMetadata.value })
        .from(memxaMetadata)
        .where(eq(memxaMetadata.key, 'legacy_user_version'))
        .get()

      if (!existing) {
        this.db.insert(memxaMetadata)
          .values({ key: 'legacy_user_version', value: String(legacyVersion) })
          .onConflictDoUpdate({
            target: memxaMetadata.key,
            set: { value: String(legacyVersion) },
          })
          .run()

        this.db.insert(memxaMetadata)
          .values({ key: 'legacy_schema_origin', value: 'pre-drizzle-kit-sqlite' })
          .onConflictDoUpdate({
            target: memxaMetadata.key,
            set: { value: 'pre-drizzle-kit-sqlite' },
          })
          .run()
      }
    }
  }

  async insert(batch: Message[]): Promise<void> {
    this.db.transaction(tx => {
      const seenSessions = new Set<string>()

      for (const message of batch) {
        const sessionId = message.sessionId || `${message.source}-${message.date}`

        if (!seenSessions.has(sessionId)) {
          tx.insert(sessions)
            .values({ id: sessionId, source: message.source, startedAt: message.timestamp })
            .onConflictDoNothing()
            .run()
          seenSessions.add(sessionId)
        }

        const result = tx.insert(messages)
          .values({
            source: message.source,
            sessionId,
            role: message.role,
            timestamp: message.timestamp,
            date: message.date,
          })
          .run()
        const messageId = Number(result.lastInsertRowid)

        if (message.blocks.length > 0) {
          tx.insert(blocks)
            .values(message.blocks.map((block, index) => ({
              messageId,
              position: index,
              type: block.type,
              text: block.text ?? null,
              toolName: block.toolName ?? null,
              toolInput: block.toolInput ?? null,
              toolCallId: block.toolCallId ?? null,
            })))
            .run()
        }

        if (message.context) {
          tx.insert(contexts)
            .values(Object.entries(message.context).map(([key, value]) => ({
              messageId,
              key,
              value,
            })))
            .run()
        }
      }
    })
  }

  async getCursor(source: string): Promise<string> {
    const row = this.db.select({ cursor: ingestState.cursor })
      .from(ingestState)
      .where(eq(ingestState.source, source))
      .get()

    return row?.cursor ?? '0'
  }

  async setCursor(source: string, cursor: string): Promise<void> {
    this.db.insert(ingestState)
      .values({ source, cursor, lastRun: Date.now() })
      .onConflictDoUpdate({
        target: ingestState.source,
        set: { cursor, lastRun: Date.now() },
      })
      .run()
  }

  async count(source?: string): Promise<number> {
    if (source) {
      const row = this.db.select({ value: count() })
        .from(messages)
        .where(eq(messages.source, source))
        .get()
      return row?.value ?? 0
    }

    const row = this.db.select({ value: count() }).from(messages).get()
    return row?.value ?? 0
  }

  async search(query: string, opts?: {
    source?: string
    role?: string
    limit?: number
    dateFrom?: string
    dateTo?: string
  }): Promise<SearchRow[]> {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return []

    const limit = opts?.limit ?? 20
    // snippetParam is used for substr/instr snippet extraction in the SELECT clause
    const snippetParam = terms[0]
    const filterParams: Array<string | number> = []
    const filters = ["b.type IN ('text', 'thinking')"]

    filters.push(`(${terms.map(() => 'lower(b.text) LIKE ?').join(' OR ')})`)
    filterParams.push(...terms.map(term => `%${term}%`))

    if (opts?.source) {
      filters.push('m.source = ?')
      filterParams.push(opts.source)
    }
    if (opts?.role) {
      filters.push('m.role = ?')
      filterParams.push(opts.role)
    }
    if (opts?.dateFrom) {
      filters.push('m.date >= ?')
      filterParams.push(opts.dateFrom)
    }
    if (opts?.dateTo) {
      filters.push('m.date <= ?')
      filterParams.push(opts.dateTo)
    }

    const sql = `
      SELECT DISTINCT m.date, m.source, m.role, m.session_id,
        substr(b.text, max(1, instr(lower(b.text), ?) - 80), 300) as text
      FROM blocks b
      JOIN messages m ON m.id = b.message_id
      WHERE ${filters.join(' AND ')}
      ORDER BY m.timestamp DESC
      LIMIT ?
    `

    return this.sqlite.prepare(sql).all(snippetParam, ...filterParams, limit) as SearchRow[]
  }

  async sessionCount(): Promise<number> {
    const row = this.db.select({ value: count() }).from(sessions).get()

    return row?.value ?? 0
  }

  async sourceStats(): Promise<SourceStats[]> {
    const messageCount = sql<number>`count(distinct ${messages.id})`
    const sessionCount = sql<number>`count(distinct ${messages.sessionId})`

    return this.db.select({
      source: messages.source,
      messages: messageCount,
      sessions: sessionCount,
    })
      .from(messages)
      .groupBy(messages.source)
      .orderBy(desc(messageCount))
      .all()
  }

  get raw(): Database.Database {
    return this.sqlite
  }

  async close(): Promise<void> {
    this.sqlite.close()
  }
}

export async function createSqliteStorage(
  path: string,
  options: SqliteStorageInitOptions = {},
): Promise<SqliteStorage> {
  const storage = new SqliteStorage(path)

  if (options.initialize ?? true) {
    await storage.init()
  }

  return storage
}
