import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SqliteStorage } from '../../src/storage/sqlite.ts'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'memxa-test-'))
  storage = new SqliteStorage(join(tempDir, 'test.db'))
  storage.init()
})

afterEach(() => {
  storage.close()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('SqliteStorage', () => {
  it('initializes without errors', () => {
    expect(storage.count()).toBe(0)
  })

  it('inserts and counts messages', () => {
    storage.insert([
      msg('claude', 'user', 1000, 'hello'),
      msg('claude', 'assistant', 2000, 'hi there'),
    ])

    expect(storage.count()).toBe(2)
    expect(storage.count('claude')).toBe(2)
    expect(storage.count('mastra')).toBe(0)
  })

  it('manages cursors', () => {
    expect(storage.getCursor('test')).toBe('0')
    storage.setCursor('test', '12345')
    expect(storage.getCursor('test')).toBe('12345')
    storage.setCursor('test', '99999')
    expect(storage.getCursor('test')).toBe('99999')
  })

  it('inserts tool call blocks', () => {
    storage.insert([toolMsg('aei', 3000)])
    expect(storage.count()).toBe(1)
  })

  it('inserts messages with context', () => {
    const m = msg('aei', 'user', 4000, 'test context')
    m.context = { cwd: '/home/user', model: 'claude-3' }
    storage.insert([m])
    expect(storage.count()).toBe(1)
  })

  it('searches via FTS', () => {
    storage.insert([
      msg('claude', 'user', 1000, 'the quick brown fox jumps over the lazy dog'),
      msg('claude', 'user', 2000, 'hello world from memxa'),
      msg('claude', 'assistant', 3000, 'response about something else entirely'),
    ])

    const results = storage.search('memxa')
    expect(results.length).toBe(1)
    expect(results[0].text).toContain('memxa')
  })

  it('handles multiple batches', () => {
    storage.insert([msg('a', 'user', 1000, 'first')])
    storage.insert([msg('a', 'user', 2000, 'second')])
    expect(storage.count()).toBe(2)
  })
})
