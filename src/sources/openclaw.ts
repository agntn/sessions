import { join } from 'node:path'
import { existsSync, readdirSync, statSync, createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { Source, Message, Block } from '../core/types.ts'

const RE_DISCORD_DM = /^\[Discord (\S+) user id:(\d+)/
const RE_DISCORD_GUILD = /^\[Discord Guild #(\S+) channel id:(\d+)[^\]]*\] (.+?)(?:: | \()/
const RE_DISCORD_FROM = /\[from: (.+?) \((\d+)\)\]/

interface DiscordContext {
  origin: string
  channel?: string
  channelId?: string
  userId?: string
  username?: string
}

function parseDiscordHeader(text: string): DiscordContext | null {
  const dm = text.match(RE_DISCORD_DM)
  if (dm) {
    return { origin: 'discord:dm', username: dm[1], userId: dm[2] }
  }
  const guild = text.match(RE_DISCORD_GUILD)
  if (guild) {
    const ctx: DiscordContext = {
      origin: 'discord:guild',
      channel: guild[1],
      channelId: guild[2],
      username: guild[3].trim(),
    }
    const from = text.match(RE_DISCORD_FROM)
    if (from) {
      ctx.username = from[1]
      ctx.userId = from[2]
    }
    return ctx
  }
  return null
}

const RE_CRON = /^\[cron:([a-f0-9-]+)\s+([a-zA-Z0-9_-]+)\]/

function classifySession(firstUserText: string): Record<string, string> {
  const cron = firstUserText.match(RE_CRON)
  if (cron) return { origin: 'cron', cronId: cron[1], cronTask: cron[2] }

  if (firstUserText.includes('HEARTBEAT') || firstUserText.startsWith('Przeczytaj HEARTBEAT')) {
    return { origin: 'heartbeat' }
  }

  const discord = parseDiscordHeader(firstUserText)
  if (discord) {
    const ctx: Record<string, string> = { origin: discord.origin }
    if (discord.channel) ctx.channel = discord.channel
    if (discord.channelId) ctx.channelId = discord.channelId
    if (discord.username) ctx.username = discord.username
    if (discord.userId) ctx.userId = discord.userId
    return ctx
  }

  return { origin: 'interactive' }
}

function parseBlocks(content: unknown[]): Block[] {
  const out: Block[] = []
  for (const b of content) {
    const block = b as Record<string, unknown>
    switch (block.type) {
      case 'text':
        if (block.text) out.push({ type: 'text', text: String(block.text).slice(0, 8000) })
        break
      case 'thinking':
        if (block.thinking) out.push({ type: 'thinking', text: String(block.thinking).slice(0, 8000) })
        break
      case 'toolCall':
        out.push({
          type: 'tool_call',
          toolName: String(block.name || ''),
          toolCallId: String(block.id || ''),
          toolInput: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
        })
        break
      case 'toolResult':
        out.push({
          type: 'tool_result',
          toolCallId: String(block.id || ''),
          text: Array.isArray(block.content)
            ? (block.content as Record<string, unknown>[])
                .filter(c => c.type === 'text')
                .map(c => String(c.text || '')).join('\n').slice(0, 8000)
            : typeof block.content === 'string' ? block.content.slice(0, 8000) : '',
        })
        break
    }
  }
  return out
}

function* walkJsonl(dirs: string[]): Generator<string> {
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.endsWith('.jsonl')) yield join(dir, entry.name)
    }
  }
}

export class OpenClawSource implements Source {
  name = 'openclaw'
  private sessionsDirs: string[]

  constructor(sessionsDirs?: string[]) {
    const base = process.env.AEI_HOME || join(process.env.HOME!, '.config', 'aei')
    this.sessionsDirs = sessionsDirs ?? [
      join(base, 'external', 'openclaw-sessions'),
      join(base, 'external', 'moltbot-sessions'),
    ]
  }

  available(): boolean {
    return this.sessionsDirs.some(d => existsSync(d))
  }

  async *ingest(cursor: string): AsyncGenerator<Message> {
    const since = Number(cursor) || 0

    const files: { path: string; mtime: number }[] = []
    for (const f of walkJsonl(this.sessionsDirs)) {
      const mt = statSync(f).mtimeMs
      if (mt > since) files.push({ path: f, mtime: mt })
    }
    files.sort((a, b) => a.mtime - b.mtime)

    for (const file of files) {
      const sessionId = file.path.split('/').pop()?.replace('.jsonl', '') || ''

      const rl = createInterface({
        input: createReadStream(file.path),
        crlfDelay: Infinity,
      })

      let sessionTimestamp = ''
      let sessionContext: Record<string, string> | undefined

      for await (const line of rl) {
        let entry: Record<string, unknown>
        try { entry = JSON.parse(line) } catch { continue }

        if (entry.type === 'session' && entry.timestamp) {
          sessionTimestamp = String(entry.timestamp)
          continue
        }
        if (entry.type !== 'message') continue

        const msg = entry.message as Record<string, unknown> | undefined
        if (!msg) continue

        const rawRole = String(msg.role || '')
        const role = rawRole === 'toolResult' ? 'tool' as const
          : rawRole === 'user' ? 'user' as const
          : rawRole === 'assistant' ? 'assistant' as const
          : null
        if (!role) continue

        const content = Array.isArray(msg.content) ? msg.content : []
        const entryBlocks = parseBlocks(content)
        if (!entryBlocks.length) continue

        if (!sessionContext && role === 'user' && entryBlocks[0]?.text) {
          sessionContext = classifySession(entryBlocks[0].text)
        }

        let msgContext = sessionContext
        if (role === 'user' && entryBlocks[0]?.text) {
          const discord = parseDiscordHeader(entryBlocks[0].text)
          if (discord) {
            msgContext = { ...sessionContext }
            if (discord.username) msgContext!.username = discord.username
            if (discord.userId) msgContext!.userId = discord.userId
            if (discord.channel) msgContext!.channel = discord.channel
          }
        }

        const ts = entry.timestamp
          ? new Date(String(entry.timestamp)).getTime()
          : sessionTimestamp
            ? new Date(sessionTimestamp).getTime()
            : file.mtime
        const date = new Date(ts).toISOString().split('T')[0]

        yield {
          source: this.name,
          sessionId,
          role,
          timestamp: ts,
          date,
          blocks: entryBlocks,
          context: msgContext,
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

/** Factory function for OpenClaw source. */
export function openclaw(sessionsDirs?: string[]): () => OpenClawSource {
  return () => new OpenClawSource(sessionsDirs)
}
