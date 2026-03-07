import { home } from '../core/env.ts'
import { join } from 'node:path'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import type { Source, Message, Block } from '../core/types.ts'

function parseGeminiBlocks(entry: Record<string, unknown>): Block[] {
  const out: Block[] = []

  if (Array.isArray(entry.thoughts)) {
    for (const t of entry.thoughts as Record<string, unknown>[]) {
      const text = [t.subject, t.description].filter(Boolean).join(': ')
      if (text) out.push({ type: 'thinking', text: text.slice(0, 8000) })
    }
  }

  if (typeof entry.content === 'string' && entry.content.length > 0) {
    out.push({ type: 'text', text: String(entry.content).slice(0, 8000) })
  }

  if (Array.isArray(entry.toolCalls)) {
    for (const tc of entry.toolCalls as Record<string, unknown>[]) {
      out.push({
        type: 'tool_call',
        toolName: String(tc.name || tc.displayName || ''),
        toolCallId: String(tc.id || ''),
        toolInput: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args),
      })

      if (Array.isArray(tc.result)) {
        for (const r of tc.result as Record<string, unknown>[]) {
          const fr = r.functionResponse as Record<string, unknown> | undefined
          const resp = fr?.response as Record<string, unknown> | undefined
          const output = resp?.output
          if (output) {
            out.push({
              type: 'tool_result',
              toolCallId: String(tc.id || ''),
              text: String(output).slice(0, 8000),
            })
          }
        }
      }
    }
  }

  return out
}

function* walkChatFiles(dir: string): Generator<{ path: string; mtime: number }> {
  if (!existsSync(dir)) return
  for (const project of readdirSync(dir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const chatsDir = join(dir, project.name, 'chats')
    if (!existsSync(chatsDir)) continue
    for (const file of readdirSync(chatsDir, { withFileTypes: true })) {
      if (!file.name.endsWith('.json')) continue
      const full = join(chatsDir, file.name)
      yield { path: full, mtime: statSync(full).mtimeMs }
    }
  }
}

export class GeminiSource implements Source {
  name = 'gemini'
  private geminiDir: string

  constructor(geminiDir?: string) {
    this.geminiDir = geminiDir ?? join(home(), '.gemini', 'tmp')
  }

  available(): boolean {
    return existsSync(this.geminiDir)
  }

  async *ingest(cursor: string): AsyncGenerator<Message> {
    const since = Number(cursor) || 0

    const files: { path: string; mtime: number }[] = []
    for (const f of walkChatFiles(this.geminiDir)) {
      if (f.mtime > since) files.push(f)
    }
    files.sort((a, b) => a.mtime - b.mtime)

    for (const file of files) {
      let data: Record<string, unknown>
      try {
        data = JSON.parse(readFileSync(file.path, 'utf-8'))
      } catch { continue }

      const msgs = data.messages as Record<string, unknown>[] | undefined
      if (!Array.isArray(msgs)) continue

      const sessionId = file.path.split('/').pop()?.replace('.json', '') || ''

      for (const entry of msgs) {
        const type = String(entry.type || '')
        const role = type === 'user' ? 'user' as const
          : type === 'gemini' ? 'assistant' as const
          : null
        if (!role) continue

        const entryBlocks = role === 'user'
          ? (typeof entry.content === 'string' && entry.content.length > 0
            ? [{ type: 'text' as const, text: String(entry.content).slice(0, 8000) }]
            : [])
          : parseGeminiBlocks(entry)

        if (!entryBlocks.length) continue

        const ts = entry.timestamp
          ? new Date(String(entry.timestamp)).getTime()
          : file.mtime
        const date = new Date(ts).toISOString().split('T')[0]

        yield {
          source: this.name,
          sessionId,
          role,
          timestamp: ts,
          date,
          blocks: entryBlocks,
        }
      }
    }
  }

  cursor(messages: Message[]): string {
    if (!messages.length) return '0'
    let max = 0
    for (const m of messages) if (m.timestamp > max) max = m.timestamp
    return String(max)
  }
}

/** Factory function for Gemini source. */
export function gemini(geminiDir?: string): () => GeminiSource {
  return () => new GeminiSource(geminiDir)
}
