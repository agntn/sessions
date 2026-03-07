#!/usr/bin/env node
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import { register, allSources, sources } from './core/registry.ts'
import { ingest } from './core/ingest.ts'
import { SqliteStorage } from './storage/sqlite.ts'
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
    const storage = new SqliteStorage(args.db)
    storage.init()

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
    storage.close()
  },
})

const statsCommand = defineCommand({
  meta: { name: 'stats', description: 'Show database statistics' },
  args: {
    db: { type: 'string', description: 'Database path', required: true },
  },
  run({ args }) {
    const storage = new SqliteStorage(args.db)
    storage.init()

    consola.info(`Database: ${args.db}`)
    consola.info('')

    consola.info('Messages:')
    consola.info(`  Total: ${storage.count()}`)
    for (const name of sources()) {
      const n = storage.count(name)
      if (n > 0) consola.info(`  ${name}: ${n}`)
    }

    const errCount = storage.errorCount()
    const misCount = storage.mistakeCount()
    if (errCount || misCount) {
      consola.info('')
      consola.info('Errors & Mistakes:')
      consola.info(`  Errors: ${errCount}`)
      consola.info(`  Mistakes: ${misCount}`)
    }

    const lrnCount = storage.learningCount()
    if (lrnCount) {
      consola.info('')
      consola.info('Learnings:')
      consola.info(`  Total: ${lrnCount}`)
      consola.info(`  From errors: ${storage.learningCount('error')}`)
      consola.info(`  From mistakes: ${storage.learningCount('mistake')}`)
      consola.info(`  From files: ${storage.learningCount('manual')}`)
      const cats = storage.topLearningCategories(10)
      if (cats.length) {
        consola.info('  Top categories:')
        for (const c of cats) {
          consola.info(`    ${c.category}: ${c.count}`)
        }
      }
    }

    const nodeCount = storage.nodeCount()
    const edgeCount = storage.edgeCount()
    if (nodeCount) {
      const exStats = storage.extractionStats()
      if (exStats.total > 0) {
        consola.info(`  From conversations: ${storage.learningCount('conversation')}`)
        consola.info('')
        consola.info('Extraction Cache:')
        consola.info(`  Sessions processed: ${exStats.total} (done: ${exStats.done}, empty: ${exStats.empty}, failed: ${exStats.failed}, skipped: ${exStats.skipped})`)
        consola.info(`  Tokens spent: ${exStats.totalTokens.toLocaleString()}`)
      }

      consola.info('')
      consola.info('Knowledge Graph:')
      consola.info(`  Nodes: ${nodeCount}`)
      consola.info(`  Edges: ${edgeCount}`)
      consola.info(`  Orphans: ${storage.orphanNodes().length}`)
      for (const type of ['person', 'concept', 'protocol', 'learning', 'tool', 'book', 'music', 'media']) {
        const n = storage.nodeCount(type)
        if (n > 0) consola.info(`    ${type}: ${n}`)
      }
    }

    storage.close()
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
  run({ args }) {
    const storage = new SqliteStorage(args.db)
    storage.init()

    const results = storage.search(args.query, {
      source: args.source,
      role: args.role,
      limit: parseInt(args.limit),
    })

    if (args.json) {
      console.log(JSON.stringify(results, null, 2))
    } else {
      if (!results.length) {
        consola.warn('No results found.')
        storage.close()
        return
      }
      for (const r of results) {
        consola.log(`[${r.date}] ${r.source}/${r.role}: ${r.text?.slice(0, 200)}`)
      }
    }

    storage.close()
  },
})

const main = defineCommand({
  meta: {
    name: 'memxa',
    version: '0.1.0',
    description: 'Universal AI conversation memory',
  },
  subCommands: {
    ingest: ingestCommand,
    stats: statsCommand,
    sources: sourcesCommand,
    search: searchCommand,
  },
})

runMain(main)
