#!/usr/bin/env node
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import { register, allSources } from './core/registry.ts'
import { ingest } from './core/ingest.ts'
import { createSqliteStorage } from './storage/db.ts'
import { builtinSources } from './sources/index.ts'
import type { Message } from './core/types.ts'

// Register all built-in sources
for (const [name, factory] of Object.entries(builtinSources)) {
  register(name, factory())
}

function preview(msg: Message): string {
  const prefix = msg.context?.origin
    ? `(${msg.context.origin}${msg.context.username ? ':' + msg.context.username : ''}) `
    : ''
  const textBlock = msg.blocks.find(b => b.type === 'text')
  if (textBlock?.text) return prefix + textBlock.text.slice(0, 120)
  const toolBlock = msg.blocks.find(b => b.type === 'tool_call')
  if (toolBlock) return prefix + `[tool: ${toolBlock.toolName}]`
  return prefix + `[${msg.blocks.length} blocks]`
}

const ingestCommand = defineCommand({
  meta: { name: 'ingest', description: 'Ingest sessions from AI tools' },
  args: {
    dryRun: { type: 'boolean', description: 'Preview without writing', alias: 'n' },
    only: { type: 'string', description: 'Comma-separated list of sources' },
    db: { type: 'string', description: 'Database path', required: true },
  },
  async run({ args }) {
    const storage = await createSqliteStorage(args.db)

    const only = args.only?.split(',').map(s => s.trim()).filter(Boolean)
    const results = await ingest(allSources(), storage, {
      only,
      verbose: true,
      dryRun: args.dryRun,
      onMessage(msg) {
        consola.log(`[dry] ${msg.source} ${msg.date} ${msg.role}: ${preview(msg)}`)
      },
    })

    const total = results.reduce((sum, r) => sum + r.count, 0)
    consola.info(`Total: ${total} messages`)
    await storage.close()
  },
})

const statsCommand = defineCommand({
  meta: { name: 'stats', description: 'Show database statistics' },
  args: {
    db: { type: 'string', description: 'Database path', required: true },
  },
  async run({ args }) {
    const storage = await createSqliteStorage(args.db)

    consola.info(`Database: ${args.db}`)
    consola.info('')

    consola.info('Messages:')
    consola.info(`  Total: ${await storage.count()}`)

    const stats = await storage.sourceStats()
    for (const s of stats) {
      consola.info(`  ${s.source}: ${s.messages} messages, ${s.sessions} sessions`)
    }

    consola.info('')
    consola.info(`Sessions: ${await storage.sessionCount()}`)

    await storage.close()
  },
})

const sourcesCommand = defineCommand({
  meta: { name: 'sources', description: 'List available sources' },
  run() {
    for (const source of allSources()) {
      const status = source.available() ? '✓' : '✗'
      consola.log(`${status} ${source.name}`)
    }
  },
})

const searchCommand = defineCommand({
  meta: { name: 'search', description: 'Search conversations' },
  args: {
    query: { type: 'positional', description: 'Search query', required: true },
    db: { type: 'string', description: 'Database path', required: true },
    source: { type: 'string', description: 'Filter by source' },
    role: { type: 'string', description: 'Filter by role' },
    limit: { type: 'string', description: 'Max results', default: '20' },
    json: { type: 'boolean', description: 'Output as JSON' },
  },
  async run({ args }) {
    const storage = await createSqliteStorage(args.db)

    const results = await storage.search(args.query, {
      source: args.source,
      role: args.role,
      limit: parseInt(args.limit) || 20,
    })

    if (args.json) {
      console.log(JSON.stringify(results, null, 2))
      await storage.close()
      return
    }

    if (!results.length) {
      consola.info('No results found')
      await storage.close()
      return
    }

    for (const r of results) {
      consola.log(`[${r.date}] ${r.source} (${r.role}) ${r.session_id}`)
      consola.log(`  ${r.text?.trim()}`)
      consola.log('')
    }

    await storage.close()
  },
})

const main = defineCommand({
  meta: {
    name: 'memxa',
    version: '0.1.0',
    description: 'Unified AI conversation memory',
  },
  subCommands: {
    ingest: ingestCommand,
    stats: statsCommand,
    sources: sourcesCommand,
    search: searchCommand,
  },
})

runMain(main)
