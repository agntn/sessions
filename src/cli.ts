#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { consola } from "consola";
import { existsSync } from "node:fs";

import { ingest } from "./core/ingest.ts";
import { createSqliteStorage } from "./storage/sqlite.ts";
import { allSources } from "./sources/index.ts";
import { defaultDbPath } from "./core/paths.ts";
import type { Message } from "./core/types.ts";

function resolveDb(db?: string): string {
  const resolved = db || defaultDbPath();
  if (!db) consola.info(`Using default database: ${resolved}`);
  return resolved;
}

function preview(msg: Message): string {
  const prefix = msg.context?.origin
    ? `(${msg.context.origin}${msg.context.username ? ":" + msg.context.username : ""}) `
    : "";
  const textBlock = msg.blocks.find((b) => b.type === "text");
  if (textBlock?.text) return prefix + textBlock.text.slice(0, 120);
  const toolBlock = msg.blocks.find((b) => b.type === "tool_call");
  if (toolBlock) return prefix + `[tool: ${toolBlock.toolName}]`;
  return prefix + `[${msg.blocks.length} blocks]`;
}

const ingestCommand = defineCommand({
  meta: { name: "ingest", description: "Ingest sessions from AI tools" },
  args: {
    dryRun: { type: "boolean", description: "Preview without writing", alias: "n" },
    only: { type: "string", description: "Comma-separated list of sources" },
    db: { type: "string", description: "Database path (default: platform data dir)" },
  },
  async run({ args }) {
    const storage = await createSqliteStorage(resolveDb(args.db));
    try {
      const only = args.only
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const results = await ingest(allSources(), storage, {
        only,
        verbose: true,
        dryRun: args.dryRun,
        onLog: (m) => consola.log(m),
        onMessage(msg) {
          consola.log(`[dry] ${msg.source} ${msg.date} ${msg.role}: ${preview(msg)}`);
        },
      });

      const total = results.reduce((sum, r) => sum + r.count, 0);
      consola.info(`Total: ${total} messages`);
    } finally {
      await storage.close();
    }
  },
});

const statsCommand = defineCommand({
  meta: { name: "stats", description: "Show database statistics" },
  args: {
    db: { type: "string", description: "Database path (default: platform data dir)" },
  },
  async run({ args }) {
    const dbPath = resolveDb(args.db);
    if (!existsSync(dbPath)) {
      consola.warn(`Database not found: ${dbPath}`);
      return;
    }

    const storage = await createSqliteStorage(dbPath, { initialize: false });
    try {
      consola.info(`Database: ${dbPath}`);
      consola.info("");

      consola.info("Messages:");
      consola.info(`  Total: ${await storage.count()}`);

      const stats = await storage.sourceStats();
      for (const s of stats) {
        consola.info(`  ${s.source}: ${s.messages} messages, ${s.sessions} sessions`);
      }

      consola.info("");
      consola.info(`Sessions: ${await storage.sessionCount()}`);
    } finally {
      await storage.close();
    }
  },
});

const sourcesCommand = defineCommand({
  meta: { name: "sources", description: "List available sources" },
  run() {
    for (const source of allSources()) {
      const status = source.available() ? "✓" : "✗";
      consola.log(`${status} ${source.name}`);
    }
  },
});

const searchCommand = defineCommand({
  meta: { name: "search", description: "Search conversations" },
  args: {
    query: { type: "positional", description: "Search query", required: true },
    db: { type: "string", description: "Database path (default: platform data dir)" },
    source: { type: "string", description: "Filter by source" },
    role: { type: "string", description: "Filter by role" },
    dateFrom: { type: "string", description: "Filter from date (YYYY-MM-DD)" },
    dateTo: { type: "string", description: "Filter to date (YYYY-MM-DD)" },
    limit: { type: "string", description: "Max results", default: "20" },
    json: { type: "boolean", description: "Output as JSON" },
  },
  async run({ args }) {
    const dbPath = resolveDb(args.db);
    if (!existsSync(dbPath)) {
      consola.warn(`Database not found: ${dbPath}`);
      return;
    }

    const storage = await createSqliteStorage(dbPath, { initialize: false });
    try {
      const results = await storage.search(args.query, {
        source: args.source,
        role: args.role,
        dateFrom: args.dateFrom,
        dateTo: args.dateTo,
        limit: Math.max(1, parseInt(args.limit) || 20),
      });

      if (args.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      if (!results.length) {
        consola.info("No results found");
        return;
      }

      for (const r of results) {
        consola.log(`[${r.date}] ${r.source} (${r.role}) ${r.sessionId}`);
        consola.log(`  ${r.text?.trim()}`);
        consola.log("");
      }
    } finally {
      await storage.close();
    }
  },
});

const main = defineCommand({
  meta: {
    name: "memxa",
    version: "0.1.0",
    description: "Unified AI conversation memory",
  },
  subCommands: {
    ingest: ingestCommand,
    stats: statsCommand,
    sources: sourcesCommand,
    search: searchCommand,
  },
});

runMain(main);
