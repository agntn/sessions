import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createSqliteStorage, SqliteStorage } from '../../src/storage/sqlite.ts'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import type { Message } from '../../src/core/types.ts'

let storage: SqliteStorage
let tempDir: string

function msg(source: string, role: 'user' | 'assistant', ts: number, text: string): Message {
  return {
    source,
    sessionId: `session-${source}`,
    role,
    timestamp: ts,
    date: new Date(ts).toISOString().split('T')[0],
    blocks: [{ type: 'text', text }],
  }
}

function toolMsg(source: string, ts: number): Message {
  return {
    source,
    sessionId: `session-${source}`,
    role: 'assistant',
    timestamp: ts,
    date: new Date(ts).toISOString().split('T')[0],
    blocks: [
      {
        type: 'tool_call',
        toolName: 'read_file',
        toolCallId: 'call-1',
        toolInput: '{"path": "/foo"}',
      },
    ],
  }
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'memxa-test-'))
  storage = await createSqliteStorage(join(tempDir, 'test.db'))
})

afterEach(async () => {
  await storage.close()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('SqliteStorage', () => {
  it('initializes without errors', async () => {
    expect(await storage.count()).toBe(0)
  })

  it('inserts and counts messages', async () => {
    await storage.insert([
      msg('claude', 'user', 1000, 'hello'),
      msg('claude', 'assistant', 2000, 'hi there'),
    ])

    expect(await storage.count()).toBe(2)
    expect(await storage.count('claude')).toBe(2)
    expect(await storage.count('mastra')).toBe(0)
  })

  it('manages cursors', async () => {
    expect(await storage.getCursor('test')).toBe('0')
    await storage.setCursor('test', '12345')
    expect(await storage.getCursor('test')).toBe('12345')
    await storage.setCursor('test', '99999')
    expect(await storage.getCursor('test')).toBe('99999')
  })

  it('inserts tool call blocks', async () => {
    await storage.insert([toolMsg('aei', 3000)])
    expect(await storage.count()).toBe(1)
  })

  it('inserts messages with context', async () => {
    const m = msg('aei', 'user', 4000, 'test context')
    m.context = { cwd: '/home/user', model: 'claude-3' }
    await storage.insert([m])
    expect(await storage.count()).toBe(1)
  })

  it('searches across individual query terms', async () => {
    await storage.insert([
      msg('claude', 'user', 1000, 'the quick brown fox jumps over the lazy dog'),
      msg('claude', 'user', 2000, 'hello world from memxa'),
      msg('claude', 'assistant', 2500, 'we should refactor the auth flow soon'),
      msg('claude', 'assistant', 3000, 'response about something else entirely'),
    ])

    const results = await storage.search('refactor auth module')
    expect(results.length).toBe(1)
    expect(results[0].text).toContain('refactor')
  })

  it('applies search filters', async () => {
    await storage.insert([
      msg('claude', 'user', 1000, 'auth plan for login module'),
      msg('claude', 'assistant', 2000, 'module cleanup is done'),
      msg('aei', 'user', 3000, 'auth migration checklist'),
    ])

    const results = await storage.search('auth module', {
      source: 'claude',
      role: 'user',
      dateFrom: '1970-01-01',
      dateTo: '1970-01-01',
    })

    expect(results).toHaveLength(1)
    expect(results[0].source).toBe('claude')
    expect(results[0].role).toBe('user')
  })

  it('handles multiple batches', async () => {
    await storage.insert([msg('a', 'user', 1000, 'first')])
    await storage.insert([msg('a', 'user', 2000, 'second')])
    expect(await storage.count()).toBe(2)
  })

  it('tracks source stats', async () => {
    await storage.insert([
      msg('claude', 'user', 1000, 'one'),
      msg('claude', 'assistant', 2000, 'two'),
      msg('aei', 'user', 3000, 'three'),
    ])

    const stats = await storage.sourceStats()
    expect(stats.length).toBe(2)

    const claude = stats.find(s => s.source === 'claude')
    expect(claude?.messages).toBe(2)
  })

  it('counts sessions', async () => {
    await storage.insert([
      msg('claude', 'user', 1000, 'a'),
      msg('aei', 'user', 2000, 'b'),
    ])
    expect(await storage.sessionCount()).toBe(2)
  })

  it('applies migrations idempotently', async () => {
    // Second init should be a no-op
    await storage.init()
    expect(await storage.count()).toBe(0)
  })

  it('imports legacy user_version metadata during initialization', async () => {
    const legacyPath = join(tempDir, 'legacy.db')
    const legacy = new Database(legacyPath)
    legacy.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at INTEGER);
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        date TEXT NOT NULL
      );
      CREATE TABLE blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        type TEXT NOT NULL,
        text TEXT,
        tool_name TEXT,
        tool_input TEXT,
        tool_call_id TEXT
      );
      CREATE TABLE contexts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE ingest_state (
        source TEXT PRIMARY KEY,
        cursor TEXT NOT NULL,
        last_run INTEGER NOT NULL
      );
      PRAGMA user_version = 7;
    `)
    legacy.close()

    const legacyStorage = await createSqliteStorage(legacyPath)
    await legacyStorage.close()

    const inspected = new Database(legacyPath, { readonly: true })
    const migrationTable = inspected.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'"
    ).get() as { name: string } | undefined
    const metadata = inspected.prepare(
      'SELECT value FROM memxa_metadata WHERE key = ?'
    ).get('legacy_user_version') as { value: string }
    inspected.close()

    expect(migrationTable?.name).toBe('__drizzle_migrations')
    expect(metadata.value).toBe('7')
  })

  it('enables foreign key enforcement on the active connection', () => {
    const db = storage.raw

    let error: unknown

    try {
      db.exec(`
        INSERT INTO blocks (message_id, position, type, text)
        VALUES (999, 0, 'text', 'orphan block')
      `)
    } catch (err) {
      error = err
    }

    expect(error).toBeInstanceOf(Error)
  })
})
