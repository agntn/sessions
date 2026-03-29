#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { intro, outro, spinner, progress, log } from "@clack/prompts";
import { existsSync } from "node:fs";

import { ingest } from "./core/ingest.ts";
import { watchSources } from "./core/watch.ts";
import { createSqliteStorage } from "./storage/sqlite.ts";
import { allSources } from "./sources/index.ts";
import { defaultDbPath } from "./core/paths.ts";
import type { Message } from "./core/types.ts";

function resolveDb(db?: string): string {
  return db || defaultDbPath();
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
    json: { type: "boolean", description: "Output as JSON" },
  },
  async run({ args }) {
    const dbPath = resolveDb(args.db);
    const storage = await createSqliteStorage(dbPath);

    try {
      const only = args.only
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      if (!args.json) {
        intro(`memxa ingest`);
        log.info(`Database: ${dbPath}`);
      }

      if (only?.length) {
        const known = new Set(allSources().map((s) => s.name));
        const unknown = only.filter((s) => !known.has(s));
        if (unknown.length) {
          log.warn(`Unknown source${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
        }
      }

      let spin: ReturnType<typeof spinner> | null = null;
      let prog: ReturnType<typeof progress> | null = null;
      let progressSent = 0;

      const stopIndicator = () => {
        if (prog) {
          try {
            prog.stop("interrupted");
          } catch {
            /* already stopped */
          }
          prog = null;
        }
        if (spin) {
          try {
            spin.stop("interrupted");
          } catch {
            /* already stopped */
          }
          spin = null;
        }
      };

      let results: Awaited<ReturnType<typeof ingest>>;
      try {
        results = await ingest(allSources(), storage, {
          only,
          dryRun: args.dryRun,
          onSourceStart: (source) => {
            if (args.json) return;
            progressSent = 0;
            spin = spinner();
            spin.start(`${source}: scanning...`);
          },
          onSourceSkip: (source, reason) => {
            if (args.json) return;
            const msg = reason === "unavailable" ? "not available" : "up to date";
            if (prog) {
              prog.stop(`${source}: ${msg}`);
              prog = null;
            } else if (spin) {
              spin.stop(`${source}: ${msg}`);
              spin = null;
            } else log.step(`${source}: ${msg}`);
          },
          onProgress: (source, count, estimate) => {
            if (args.json) return;
            if (estimate && estimate > 0 && !prog) {
              if (spin) {
                spin.stop(`${source}: estimating...`);
                spin = null;
              }
              prog = progress({ max: estimate });
              prog.start(`${source}: 0/${estimate}`);
            }
            if (prog && estimate) {
              const delta = count - progressSent;
              if (delta > 0) prog.advance(delta, `${source}: ${count}/${estimate}`);
              progressSent = count;
            } else {
              spin?.message(`${source}: ${count} messages...`);
            }
          },
          onSourceDone: (source, count, opts) => {
            if (args.json) return;
            const suffix = opts?.dryRun ? " (dry run)" : "";
            if (prog) {
              prog.stop(`${source}: ${count} messages${suffix}`);
              prog = null;
            } else if (spin) {
              spin.stop(`${source}: ${count} messages${suffix}`);
              spin = null;
            }
          },
          onSourceError: (source, error) => {
            if (args.json) return;
            if (prog) {
              prog.error(`${source}: ${error}`);
              prog = null;
            } else if (spin) {
              spin.error(`${source}: ${error}`);
              spin = null;
            } else log.warn(`${source}: ${error}`);
          },
          onMessage: args.json
            ? undefined
            : (msg) => {
                log.step(`[dry] ${msg.source} ${msg.date} ${msg.role}: ${preview(msg)}`);
              },
        });
      } catch (e) {
        stopIndicator();
        throw e;
      }

      const failed = results.filter((r) => r.error);
      if (failed.length) process.exitCode = 1;

      if (args.json) {
        const normalized = results.map((r) => ({
          ...r,
          cursor: r.cursor && r.cursor !== "0" ? r.cursor : null,
        }));
        console.log(JSON.stringify(normalized, null, 2));
        return;
      }

      const total = results.reduce((sum, r) => sum + r.count, 0);
      for (const r of failed) log.warn(`${r.source}: ${r.error}`);
      outro(`Done: ${total} messages`);
    } finally {
      await storage.close();
    }
  },
});

const statsCommand = defineCommand({
  meta: { name: "stats", description: "Show database statistics" },
  args: {
    db: { type: "string", description: "Database path (default: platform data dir)" },
    json: { type: "boolean", description: "Output as JSON" },
  },
  async run({ args }) {
    const dbPath = resolveDb(args.db);
    if (!existsSync(dbPath)) {
      log.warn(`Database not found: ${dbPath}`);
      return;
    }

    const storage = await createSqliteStorage(dbPath, { initialize: false });
    try {
      const totalMessages = await storage.count();
      const totalSessions = await storage.sessionCount();
      const stats = await storage.sourceStats();

      const cursorStates: Record<string, { cursor: string; lastRun: number | null }> = {};
      for (const source of allSources()) {
        const state = await storage.getCursorState(source.name);
        cursorStates[source.name] = { cursor: state.cursor, lastRun: state.lastRun };
      }

      if (args.json) {
        const cursors = Object.fromEntries(
          Object.entries(cursorStates).map(([name, state]) => [
            name,
            {
              cursor: state.cursor && state.cursor !== "0" ? state.cursor : null,
              lastRun: state.lastRun,
            },
          ]),
        );
        console.log(
          JSON.stringify(
            { database: dbPath, totalMessages, totalSessions, sources: stats, cursors },
            null,
            2,
          ),
        );
        return;
      }

      intro("memxa stats");
      log.info(`Database: ${dbPath}`);

      const lines = [`Total: ${totalMessages}`];
      for (const s of stats) {
        lines.push(`${s.source}: ${s.messages} messages, ${s.sessions} sessions`);
      }
      log.message(lines.join("\n"));

      log.info(`Sessions: ${totalSessions}`);

      const cursorLines: string[] = [];
      for (const [name, state] of Object.entries(cursorStates)) {
        const ts = Number(state.cursor);
        const date = new Date(ts);
        const hasValidDate = Number.isFinite(ts) && ts > 0 && Number.isFinite(date.getTime());
        const cursorDisplay = hasValidDate
          ? `${state.cursor} (${date.toISOString()})`
          : state.cursor && state.cursor !== "0"
            ? state.cursor
            : "(none)";

        const lastRunDisplay = state.lastRun ? new Date(state.lastRun).toISOString() : null;

        const parts = [`${name}: cursor ${cursorDisplay}`];
        if (lastRunDisplay) parts.push(`last run ${lastRunDisplay}`);
        cursorLines.push(parts.join(", "));
      }
      log.message(cursorLines.join("\n"));

      outro("done");
    } finally {
      await storage.close();
    }
  },
});

const sourcesCommand = defineCommand({
  meta: { name: "sources", description: "List available sources" },
  args: {
    json: { type: "boolean", description: "Output as JSON" },
  },
  run({ args }) {
    const all = allSources().map((s) => ({ name: s.name, available: s.available() }));

    if (args.json) {
      console.log(JSON.stringify(all, null, 2));
      return;
    }

    for (const s of all) {
      if (s.available) log.success(s.name);
      else log.warn(s.name);
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
      log.warn(`Database not found: ${dbPath}`);
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
        log.info("No results found");
        return;
      }

      for (const r of results) {
        log.step(`[${r.date}] ${r.source} (${r.role}) ${r.sessionId}`);
        log.message(`  ${r.text?.trim()}`);
      }
    } finally {
      await storage.close();
    }
  },
});

const cursorListCommand = defineCommand({
  meta: { name: "list", description: "Show cursor values for all sources" },
  args: {
    db: { type: "string", description: "Database path (default: platform data dir)" },
    json: { type: "boolean", description: "Output as JSON" },
  },
  async run({ args }) {
    const dbPath = resolveDb(args.db);
    if (!existsSync(dbPath)) {
      log.warn(`Database not found: ${dbPath}`);
      return;
    }

    const storage = await createSqliteStorage(dbPath, { initialize: false });
    try {
      const cursors = await storage.listCursors();
      const cursorMap = new Map(
        cursors.map((c) => [c.source, { cursor: c.cursor, lastRun: c.lastRun }]),
      );
      for (const source of allSources()) {
        if (!cursorMap.has(source.name)) cursorMap.set(source.name, { cursor: "0", lastRun: 0 });
      }

      if (args.json) {
        const entries = Object.fromEntries(
          [...cursorMap].map(([name, state]) => [
            name,
            {
              cursor: state.cursor && state.cursor !== "0" ? state.cursor : null,
              lastRun: state.lastRun || null,
            },
          ]),
        );
        console.log(JSON.stringify(entries, null, 2));
        return;
      }

      for (const [source, state] of cursorMap) {
        const ts = Number(state.cursor);
        const date = new Date(ts);
        const hasValidDate = Number.isFinite(ts) && ts > 0 && Number.isFinite(date.getTime());
        const display = hasValidDate
          ? `${state.cursor} (${date.toISOString()})`
          : state.cursor && state.cursor !== "0"
            ? state.cursor
            : "(none)";
        log.step(`${source}: ${display}`);
      }
    } finally {
      await storage.close();
    }
  },
});

const cursorResetCommand = defineCommand({
  meta: { name: "reset", description: "Reset cursor for a source to re-ingest from scratch" },
  args: {
    source: { type: "positional", description: "Source name to reset", required: true },
    db: { type: "string", description: "Database path (default: platform data dir)" },
  },
  async run({ args }) {
    const dbPath = resolveDb(args.db);
    if (!existsSync(dbPath)) {
      log.warn(`Database not found: ${dbPath}`);
      return;
    }

    const storage = await createSqliteStorage(dbPath, { initialize: false });
    try {
      await storage.deleteCursor(args.source);
      log.success(`Cursor reset for "${args.source}"`);
    } finally {
      await storage.close();
    }
  },
});

const cursorCommand = defineCommand({
  meta: { name: "cursor", description: "Manage ingestion cursors" },
  subCommands: {
    list: cursorListCommand,
    reset: cursorResetCommand,
  },
});

const purgeCommand = defineCommand({
  meta: { name: "purge", description: "Delete all data for a source and reset its cursor" },
  args: {
    source: { type: "positional", description: "Source name to purge", required: true },
    db: { type: "string", description: "Database path (default: platform data dir)" },
  },
  async run({ args }) {
    const dbPath = resolveDb(args.db);
    if (!existsSync(dbPath)) {
      log.warn(`Database not found: ${dbPath}`);
      return;
    }

    const storage = await createSqliteStorage(dbPath, { initialize: false });
    try {
      const deleted = await storage.purgeSource(args.source);
      log.success(`Purged "${args.source}": ${deleted} sessions removed, cursor reset`);
    } finally {
      await storage.close();
    }
  },
});

const watchCommand = defineCommand({
  meta: { name: "watch", description: "Watch source directories and auto-ingest on changes" },
  args: {
    db: { type: "string", description: "Database path (default: platform data dir)" },
    only: { type: "string", description: "Comma-separated list of sources" },
    debounce: { type: "string", description: "Debounce interval in ms (default: 2000)" },
    noInitial: { type: "boolean", description: "Skip initial ingest on startup" },
    json: { type: "boolean", description: "Output events as JSON lines" },
  },
  async run({ args }) {
    const dbPath = resolveDb(args.db);
    const storage = await createSqliteStorage(dbPath);

    const only = args.only
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const debounceMs = Math.max(500, parseInt(args.debounce || "2000") || 2000);

    if (!args.json) {
      intro("memxa watch");
      log.info(`Database: ${dbPath}`);
      log.info(`Debounce: ${debounceMs}ms`);
    }

    const ac = new AbortController();
    const shutdown = () => ac.abort();
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    try {
      await watchSources(allSources(), storage, {
        only,
        debounceMs,
        initial: !args.noInitial,
        signal: ac.signal,
        onReady: (watchedPaths) => {
          if (args.json) {
            const paths = Object.fromEntries([...watchedPaths].map(([p, s]) => [p, s]));
            console.log(JSON.stringify({ event: "ready", paths }));
            return;
          }
          for (const [path, sources] of watchedPaths) {
            log.step(`Watching: ${path} (${sources.join(", ")})`);
          }
          log.info("Waiting for changes... (Ctrl+C to stop)");
        },
        onTrigger: (source) => {
          if (args.json) {
            console.log(JSON.stringify({ event: "trigger", source }));
          } else {
            log.step(`${source}: change detected, ingesting...`);
          }
        },
        onIngestDone: (result) => {
          if (args.json) {
            const normalized = {
              ...result,
              cursor: result.cursor && result.cursor !== "0" ? result.cursor : null,
            };
            console.log(JSON.stringify({ event: "ingest", ...normalized }));
          } else if (result.count > 0) {
            log.success(`${result.source}: ${result.count} new messages`);
          }
        },
        onIngestError: (source, error) => {
          if (args.json) {
            console.log(JSON.stringify({ event: "error", source, error }));
          } else {
            log.warn(`${source}: ${error}`);
          }
        },
        onWatchError: (path, err) => {
          if (args.json) {
            console.log(JSON.stringify({ event: "watch_error", path, error: err.message }));
          } else {
            const hint =
              (err as NodeJS.ErrnoException).code === "ENOSPC"
                ? " (increase fs.inotify.max_user_watches)"
                : "";
            log.warn(`Watch error on ${path}: ${err.message}${hint}`);
          }
        },
        onShutdown: () => {
          if (!args.json) outro("Watch stopped");
        },
      });
    } finally {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
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
    cursor: cursorCommand,
    purge: purgeCommand,
    watch: watchCommand,
  },
});

runMain(main);
