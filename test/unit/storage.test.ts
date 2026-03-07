import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createSqliteStorage, Db0Storage } from '../../src/storage/db.ts'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { Message } from '../../src/core/types.ts'

let storage: Db0Storage
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

describe('Db0Storage', () => {
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

  it('searches via LIKE', async () => {
    await storage.insert([
      msg('claude', 'user', 1000, 'the quick brown fox jumps over the lazy dog'),
      msg('claude', 'user', 2000, 'hello world from memxa'),
      msg('claude', 'assistant', 3000, 'response about something else entirely'),
    ])

    const results = await storage.search('memxa')
    expect(results.length).toBe(1)
    expect(results[0].text).toContain('memxa')
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
})
