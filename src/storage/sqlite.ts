import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { eq, count } from 'drizzle-orm'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Storage, Message } from '../core/types.ts'

// --- Schema ---

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  source: text('source').notNull(),
  startedAt: integer('started_at'),
}, (table) => [
  index('idx_sessions_source').on(table.source),
])

export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source').notNull(),
  sessionId: text('session_id').notNull().references(() => sessions.id),
  role: text('role').notNull(),
  timestamp: integer('timestamp').notNull(),
  date: text('date').notNull(),
}, (table) => [
  index('idx_messages_source_ts').on(table.source, table.timestamp),
  index('idx_messages_date').on(table.date),
  index('idx_messages_session').on(table.sessionId),
])

export const blocks = sqliteTable('blocks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  messageId: integer('message_id').notNull().references(() => messages.id),
  position: integer('position').notNull(),
  type: text('type').notNull(),
  text: text('text'),
  toolName: text('tool_name'),
  toolInput: text('tool_input'),
  toolCallId: text('tool_call_id'),
}, (table) => [
  index('idx_blocks_message').on(table.messageId),
  index('idx_blocks_type').on(table.type),
  index('idx_blocks_tool_name').on(table.toolName),
])

export const contexts = sqliteTable('contexts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  messageId: integer('message_id').notNull().references(() => messages.id),
  key: text('key').notNull(),
  value: text('value').notNull(),
}, (table) => [
  index('idx_contexts_message').on(table.messageId),
])

export const ingestState = sqliteTable('ingest_state', {
  source: text('source').primaryKey(),
  cursor: text('cursor').notNull(),
  lastRun: integer('last_run').notNull(),
})

// --- Knowledge tables ---

export const errors = sqliteTable('errors', {
  id: text('id').primaryKey(),
  date: text('date').notNull(),
  status: text('status').notNull(),
  priority: text('priority'),
  exitCode: integer('exit_code'),
  command: text('command'),
  output: text('output'),
  pattern: text('pattern'),
  file: text('file').notNull(),
}, (table) => [
  index('idx_errors_date').on(table.date),
  index('idx_errors_pattern').on(table.pattern),
  index('idx_errors_status').on(table.status),
])

export const mistakes = sqliteTable('mistakes', {
  id: text('id').primaryKey(),
  date: text('date').notNull(),
  category: text('category'),
  status: text('status').notNull(),
  whatWentWrong: text('what_went_wrong'),
  rootCause: text('root_cause'),
  lesson: text('lesson'),
  application: text('application'),
  file: text('file').notNull(),
}, (table) => [
  index('idx_mistakes_date').on(table.date),
  index('idx_mistakes_status').on(table.status),
  index('idx_mistakes_category').on(table.category),
])

export const knowledgeNodes = sqliteTable('knowledge_nodes', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  file: text('file').notNull(),
}, (table) => [
  index('idx_nodes_type').on(table.type),
])

export const knowledgeTags = sqliteTable('knowledge_tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  nodeId: text('node_id').notNull().references(() => knowledgeNodes.id),
  tag: text('tag').notNull(),
}, (table) => [
  index('idx_tags_node').on(table.nodeId),
  index('idx_tags_tag').on(table.tag),
])

export const knowledgeEdges = sqliteTable('knowledge_edges', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fromId: text('from_id').notNull().references(() => knowledgeNodes.id),
  toId: text('to_id').notNull().references(() => knowledgeNodes.id),
  relation: text('relation').notNull(),
}, (table) => [
  index('idx_edges_from').on(table.fromId),
  index('idx_edges_to').on(table.toId),
  index('idx_edges_relation').on(table.relation),
])

export const learnings = sqliteTable('learnings', {
  id: text('id').primaryKey(),
  date: text('date').notNull(),
  source: text('source').notNull(),          // 'error', 'mistake', 'conversation', 'manual'
  sourceRef: text('source_ref'),              // id of error/mistake/file
  category: text('category'),                 // 'command-not-found', 'architecture', ...
  lesson: text('lesson').notNull(),
  context: text('context'),                   // what happened
  frequency: integer('frequency').default(1), // how many times seen
  importance: integer('importance').default(5),
  status: text('status').default('active'),   // active, superseded, irrelevant
}, (table) => [
  index('idx_learnings_source').on(table.source),
  index('idx_learnings_category').on(table.category),
  index('idx_learnings_importance').on(table.importance),
  index('idx_learnings_status').on(table.status),
])

// --- Migrations ---
// Each migration runs once, tracked by schema_version pragma.
// NEVER modify existing migrations. Only append new ones.

const MIGRATIONS: string[] = [
  // v1: initial schema
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    started_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source);

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    date TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_source_ts ON messages(source, timestamp);
  CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date);
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

  CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id),
    position INTEGER NOT NULL,
    type TEXT NOT NULL,
    text TEXT,
    tool_name TEXT,
    tool_input TEXT,
    tool_call_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_blocks_message ON blocks(message_id);
  CREATE INDEX IF NOT EXISTS idx_blocks_type ON blocks(type);
  CREATE INDEX IF NOT EXISTS idx_blocks_tool_name ON blocks(tool_name);

  CREATE TABLE IF NOT EXISTS contexts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id),
    key TEXT NOT NULL,
    value TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_contexts_message ON contexts(message_id);

  CREATE TABLE IF NOT EXISTS ingest_state (
    source TEXT PRIMARY KEY,
    cursor TEXT NOT NULL,
    last_run INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS errors (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    status TEXT NOT NULL,
    priority TEXT,
    exit_code INTEGER,
    command TEXT,
    output TEXT,
    pattern TEXT,
    file TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_errors_date ON errors(date);
  CREATE INDEX IF NOT EXISTS idx_errors_pattern ON errors(pattern);
  CREATE INDEX IF NOT EXISTS idx_errors_status ON errors(status);

  CREATE TABLE IF NOT EXISTS mistakes (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    category TEXT,
    status TEXT NOT NULL,
    what_went_wrong TEXT,
    root_cause TEXT,
    lesson TEXT,
    application TEXT,
    file TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mistakes_date ON mistakes(date);
  CREATE INDEX IF NOT EXISTS idx_mistakes_status ON mistakes(status);
  CREATE INDEX IF NOT EXISTS idx_mistakes_category ON mistakes(category);

  CREATE TABLE IF NOT EXISTS learnings (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    source TEXT NOT NULL,
    source_ref TEXT,
    category TEXT,
    lesson TEXT NOT NULL,
    context TEXT,
    frequency INTEGER DEFAULT 1,
    importance INTEGER DEFAULT 5,
    status TEXT DEFAULT 'active'
  );
  CREATE INDEX IF NOT EXISTS idx_learnings_source ON learnings(source);
  CREATE INDEX IF NOT EXISTS idx_learnings_category ON learnings(category);
  CREATE INDEX IF NOT EXISTS idx_learnings_importance ON learnings(importance);
  CREATE INDEX IF NOT EXISTS idx_learnings_status ON learnings(status);

  CREATE TABLE IF NOT EXISTS knowledge_nodes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    file TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_nodes_type ON knowledge_nodes(type);

  CREATE TABLE IF NOT EXISTS knowledge_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT NOT NULL REFERENCES knowledge_nodes(id),
    tag TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tags_node ON knowledge_tags(node_id);
  CREATE INDEX IF NOT EXISTS idx_tags_tag ON knowledge_tags(tag);

  CREATE TABLE IF NOT EXISTS knowledge_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL REFERENCES knowledge_nodes(id),
    to_id TEXT NOT NULL REFERENCES knowledge_nodes(id),
    relation TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_edges_from ON knowledge_edges(from_id);
  CREATE INDEX IF NOT EXISTS idx_edges_to ON knowledge_edges(to_id);
  CREATE INDEX IF NOT EXISTS idx_edges_relation ON knowledge_edges(relation);`,

  // v2: FTS index for conversation search
  `CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
    text, content=blocks, content_rowid=id
  );

  -- Populate initial FTS index from existing blocks
  INSERT OR IGNORE INTO blocks_fts(rowid, text)
    SELECT id, text FROM blocks WHERE text IS NOT NULL AND length(text) > 0;

  -- Triggers to keep FTS in sync
  CREATE TRIGGER IF NOT EXISTS blocks_ai AFTER INSERT ON blocks
    WHEN NEW.text IS NOT NULL AND length(NEW.text) > 0
  BEGIN
    INSERT INTO blocks_fts(rowid, text) VALUES (NEW.rowid, NEW.text);
  END;

  CREATE TRIGGER IF NOT EXISTS blocks_ad AFTER DELETE ON blocks
    WHEN OLD.text IS NOT NULL
  BEGIN
    INSERT INTO blocks_fts(blocks_fts, rowid, text) VALUES('delete', OLD.rowid, OLD.text);
  END;

  CREATE TRIGGER IF NOT EXISTS blocks_au AFTER UPDATE ON blocks
    WHEN OLD.text IS NOT NULL OR NEW.text IS NOT NULL
  BEGIN
    INSERT INTO blocks_fts(blocks_fts, rowid, text) VALUES('delete', OLD.rowid, COALESCE(OLD.text, ''));
    INSERT INTO blocks_fts(rowid, text) VALUES(NEW.rowid, COALESCE(NEW.text, ''));
  END;`,

  // v3: extraction cache (token-expensive LLM results)
  `CREATE TABLE IF NOT EXISTS extraction_cache (
    session_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    prompt_version INTEGER NOT NULL DEFAULT 1,
    model TEXT,
    tokens_used INTEGER,
    learnings_count INTEGER DEFAULT 0,
    error_reason TEXT,
    extracted_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_extract_status ON extraction_cache(status);
  CREATE INDEX IF NOT EXISTS idx_extract_source ON extraction_cache(source);
  CREATE INDEX IF NOT EXISTS idx_extract_version ON extraction_cache(prompt_version);`,

  // v4: session summaries for sliding window compression
  `CREATE TABLE IF NOT EXISTS session_summaries (
    session_id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    messages_covered INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );`,

  // v5: observations for observational memory (context compression)
  `CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    content TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    messages_start INTEGER NOT NULL,
    messages_end INTEGER NOT NULL,
    model TEXT,
    tokens_used INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id);
  CREATE INDEX IF NOT EXISTS idx_obs_time ON observations(observed_at);

  CREATE TABLE IF NOT EXISTS reflections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    content TEXT NOT NULL,
    reflected_at INTEGER NOT NULL,
    observations_condensed INTEGER NOT NULL DEFAULT 0,
    model TEXT,
    tokens_used INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_refl_session ON reflections(session_id);`,

  // v6: embedding cache for semantic search reranking
  `CREATE TABLE IF NOT EXISTS embedding_cache (
    block_id INTEGER PRIMARY KEY,
    embedding BLOB NOT NULL,
    model TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );`,

  // v7: learnings embedding table for pure vector search
  `CREATE TABLE IF NOT EXISTS learning_embeddings (
    learning_id TEXT PRIMARY KEY REFERENCES learnings(id),
    embedding BLOB NOT NULL,
    model TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );`,
]

// --- Implementation ---

const schema = {
  sessions, messages, blocks, contexts, ingestState,
  errors, mistakes, learnings, knowledgeNodes, knowledgeTags, knowledgeEdges,
}

type Stmt = Database.Statement<unknown[]>

export class SqliteStorage implements Storage {
  private sqlite: InstanceType<typeof Database>
  private db: ReturnType<typeof drizzle>

  private stmts!: {
    insertSession: Stmt
    insertMessage: Stmt
    insertBlock: Stmt
    insertContext: Stmt
    upsertError: Stmt
    upsertMistake: Stmt
    upsertLearning: Stmt
    upsertNode: Stmt
    insertTag: Stmt
    insertEdge: Stmt
    clearTags: Stmt
    clearEdges: Stmt
    upsertExtraction: Stmt
    getExtraction: Stmt
    insertObservation: Stmt
    insertReflection: Stmt
    getEmbedding: Stmt
    setEmbedding: Stmt
    getLearningEmbedding: Stmt
    setLearningEmbedding: Stmt
  }

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.sqlite = new Database(path)
    this.db = drizzle(this.sqlite, { schema })
  }

  init(): void {
    this.sqlite.pragma('journal_mode = WAL')
    this.sqlite.pragma('busy_timeout = 5000')
    this.sqlite.pragma('foreign_keys = ON')
    this.migrate()
    this.prepareStatements()
  }

  private migrate(): void {
    // user_version tracks which migrations have been applied
    const currentVersion = this.sqlite.pragma('user_version', { simple: true }) as number

    if (currentVersion >= MIGRATIONS.length) return

    // Backup reminder — log to stderr before any migration
    if (currentVersion < MIGRATIONS.length) {
      const pending = MIGRATIONS.length - currentVersion
      process.stderr.write(`[memxa] Migrating DB: v${currentVersion} → v${MIGRATIONS.length} (${pending} pending)\n`)
    }

    for (let i = currentVersion; i < MIGRATIONS.length; i++) {
      const tx = this.sqlite.transaction(() => {
        this.sqlite.exec(MIGRATIONS[i])
        this.sqlite.pragma(`user_version = ${i + 1}`)
      })
      try {
        tx()
        process.stderr.write(`[memxa] Applied migration v${i + 1}\n`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[memxa] MIGRATION v${i + 1} FAILED: ${msg}\n`)
        throw err
      }
    }
  }

  private prepareStatements(): void {
    this.stmts = {
      insertSession: this.sqlite.prepare(
        'INSERT OR IGNORE INTO sessions (id, source, started_at) VALUES (?, ?, ?)',
      ),
      insertMessage: this.sqlite.prepare(
        'INSERT INTO messages (source, session_id, role, timestamp, date) VALUES (?, ?, ?, ?, ?)',
      ),
      insertBlock: this.sqlite.prepare(
        'INSERT INTO blocks (message_id, position, type, text, tool_name, tool_input, tool_call_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ),
      insertContext: this.sqlite.prepare(
        'INSERT INTO contexts (message_id, key, value) VALUES (?, ?, ?)',
      ),
      upsertError: this.sqlite.prepare(
        `INSERT OR REPLACE INTO errors (id, date, status, priority, exit_code, command, output, pattern, file)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      upsertMistake: this.sqlite.prepare(
        `INSERT OR REPLACE INTO mistakes (id, date, category, status, what_went_wrong, root_cause, lesson, application, file)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      upsertLearning: this.sqlite.prepare(
        `INSERT OR REPLACE INTO learnings (id, date, source, source_ref, category, lesson, context, frequency, importance, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      upsertNode: this.sqlite.prepare(
        'INSERT OR REPLACE INTO knowledge_nodes (id, name, type, file) VALUES (?, ?, ?, ?)',
      ),
      insertTag: this.sqlite.prepare(
        'INSERT INTO knowledge_tags (node_id, tag) VALUES (?, ?)',
      ),
      insertEdge: this.sqlite.prepare(
        'INSERT INTO knowledge_edges (from_id, to_id, relation) VALUES (?, ?, ?)',
      ),
      clearTags: this.sqlite.prepare('DELETE FROM knowledge_tags WHERE node_id = ?'),
      clearEdges: this.sqlite.prepare('DELETE FROM knowledge_edges'),
      upsertExtraction: this.sqlite.prepare(
        `INSERT OR REPLACE INTO extraction_cache
         (session_id, source, status, prompt_version, model, tokens_used, learnings_count, error_reason, extracted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      getExtraction: this.sqlite.prepare(
        'SELECT * FROM extraction_cache WHERE session_id = ?',
      ),
      insertObservation: this.sqlite.prepare(
        `INSERT INTO observations (session_id, content, observed_at, messages_start, messages_end, model, tokens_used)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertReflection: this.sqlite.prepare(
        `INSERT INTO reflections (session_id, content, reflected_at, observations_condensed, model, tokens_used)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ),
      getEmbedding: this.sqlite.prepare(
        'SELECT embedding FROM embedding_cache WHERE block_id = ?',
      ),
      setEmbedding: this.sqlite.prepare(
        'INSERT OR REPLACE INTO embedding_cache (block_id, embedding, model) VALUES (?, ?, ?)',
      ),
      getLearningEmbedding: this.sqlite.prepare(
        'SELECT embedding FROM learning_embeddings WHERE learning_id = ?',
      ),
      setLearningEmbedding: this.sqlite.prepare(
        'INSERT OR REPLACE INTO learning_embeddings (learning_id, embedding, model) VALUES (?, ?, ?)',
      ),
    }
  }

  insert(batch: Message[]): void {
    const tx = this.sqlite.transaction(() => {
      const seenSessions = new Set<string>()

      for (const m of batch) {
        const sid = m.sessionId || `${m.source}-${m.date}`

        if (!seenSessions.has(sid)) {
          this.stmts.insertSession.run(sid, m.source, m.timestamp)
          seenSessions.add(sid)
        }

        const result = this.stmts.insertMessage.run(m.source, sid, m.role, m.timestamp, m.date)
        const messageId = result.lastInsertRowid

        for (let i = 0; i < m.blocks.length; i++) {
          const b = m.blocks[i]
          this.stmts.insertBlock.run(
            messageId, i, b.type,
            b.text || null,
            b.toolName || null,
            b.toolInput || null,
            b.toolCallId || null,
          )
        }

        if (m.context) {
          for (const [key, value] of Object.entries(m.context)) {
            this.stmts.insertContext.run(messageId, key, value)
          }
        }
      }
    })

    tx()
  }

  // --- Error/Mistake methods ---

  insertError(entry: {
    id: string, date: string, status: string, priority: string | null,
    exitCode: number | null, command: string | null, output: string | null,
    pattern: string | null, file: string,
  }): void {
    this.stmts.upsertError.run(
      entry.id, entry.date, entry.status, entry.priority,
      entry.exitCode, entry.command, entry.output, entry.pattern, entry.file,
    )
  }

  insertMistake(entry: {
    id: string, date: string, category: string | null, status: string,
    whatWentWrong: string | null, rootCause: string | null,
    lesson: string | null, application: string | null, file: string,
  }): void {
    this.stmts.upsertMistake.run(
      entry.id, entry.date, entry.category, entry.status,
      entry.whatWentWrong, entry.rootCause, entry.lesson, entry.application, entry.file,
    )
  }

  insertLearning(entry: {
    id: string, date: string, source: string, sourceRef: string | null,
    category: string | null, lesson: string, context: string | null,
    frequency: number, importance: number, status: string,
  }): void {
    this.stmts.upsertLearning.run(
      entry.id, entry.date, entry.source, entry.sourceRef,
      entry.category, entry.lesson, entry.context,
      entry.frequency, entry.importance, entry.status,
    )
  }

  learningCount(source?: string): number {
    if (source) {
      const row = this.db.select({ value: count() })
        .from(learnings)
        .where(eq(learnings.source, source))
        .get()
      return row?.value ?? 0
    }
    return this.db.select({ value: count() }).from(learnings).get()?.value ?? 0
  }

  allLearnings(opts?: { source?: string, category?: string, status?: string }): Array<{
    id: string, date: string, source: string, sourceRef: string | null,
    category: string | null, lesson: string, context: string | null,
    frequency: number, importance: number, status: string,
  }> {
    let query = 'SELECT * FROM learnings WHERE 1=1'
    const params: string[] = []
    if (opts?.source) { query += ' AND source = ?'; params.push(opts.source) }
    if (opts?.category) { query += ' AND category = ?'; params.push(opts.category) }
    if (opts?.status) { query += ' AND status = ?'; params.push(opts.status) }
    query += ' ORDER BY importance DESC, date DESC'
    return this.sqlite.prepare(query).all(...params) as Array<{
      id: string, date: string, source: string, sourceRef: string | null,
      category: string | null, lesson: string, context: string | null,
      frequency: number, importance: number, status: string,
    }>
  }

  topLearningCategories(limit = 20): { category: string, count: number }[] {
    return this.sqlite.prepare(`
      SELECT category, COUNT(*) as count FROM learnings
      WHERE category IS NOT NULL
      GROUP BY category ORDER BY count DESC LIMIT ?
    `).all(limit) as { category: string; count: number }[]
  }

  errorCount(pattern?: string): number {
    if (pattern) {
      const row = this.db.select({ value: count() })
        .from(errors)
        .where(eq(errors.pattern, pattern))
        .get()
      return row?.value ?? 0
    }
    return this.db.select({ value: count() }).from(errors).get()?.value ?? 0
  }

  mistakeCount(): number {
    return this.db.select({ value: count() }).from(mistakes).get()?.value ?? 0
  }

  // --- Extraction cache methods ---

  getExtraction(sessionId: string): {
    session_id: string, source: string, status: string,
    prompt_version: number, model: string | null,
    tokens_used: number | null, learnings_count: number,
    error_reason: string | null, extracted_at: number,
  } | undefined {
    return this.stmts.getExtraction.get(sessionId) as any
  }

  setExtraction(entry: {
    sessionId: string, source: string, status: string,
    promptVersion: number, model?: string,
    tokensUsed?: number, learningsCount?: number,
    errorReason?: string,
  }): void {
    this.stmts.upsertExtraction.run(
      entry.sessionId, entry.source, entry.status,
      entry.promptVersion, entry.model || null,
      entry.tokensUsed || null, entry.learningsCount || 0,
      entry.errorReason || null, Date.now(),
    )
  }

  extractionStats(): {
    total: number, done: number, empty: number, failed: number, skipped: number,
    totalTokens: number, totalLearnings: number,
  } {
    const rows = this.sqlite.prepare(`
      SELECT status, COUNT(*) as cnt,
        COALESCE(SUM(tokens_used), 0) as tokens,
        COALESCE(SUM(learnings_count), 0) as learns
      FROM extraction_cache GROUP BY status
    `).all() as Array<{ status: string, cnt: number, tokens: number, learns: number }>
    const stats = { total: 0, done: 0, empty: 0, failed: 0, skipped: 0, totalTokens: 0, totalLearnings: 0 }
    for (const r of rows) {
      stats.total += r.cnt
      stats.totalTokens += r.tokens
      stats.totalLearnings += r.learns
      if (r.status === 'done') stats.done = r.cnt
      else if (r.status === 'empty') stats.empty = r.cnt
      else if (r.status === 'failed') stats.failed = r.cnt
      else if (r.status === 'skipped') stats.skipped = r.cnt
    }
    return stats
  }

  // --- Observation/Reflection methods ---

  addObservation(entry: {
    sessionId: string, content: string, messagesStart: number,
    messagesEnd: number, model?: string, tokensUsed?: number,
  }): number {
    const result = this.stmts.insertObservation.run(
      entry.sessionId, entry.content, Date.now(),
      entry.messagesStart, entry.messagesEnd,
      entry.model || null, entry.tokensUsed || 0,
    )
    return Number(result.lastInsertRowid)
  }

  getObservations(sessionId: string): Array<{
    id: number, content: string, observed_at: number,
    messages_start: number, messages_end: number,
  }> {
    return this.sqlite.prepare(
      'SELECT id, content, observed_at, messages_start, messages_end FROM observations WHERE session_id = ? ORDER BY observed_at ASC'
    ).all(sessionId) as any[]
  }

  addReflection(entry: {
    sessionId: string, content: string, observationsCondensed: number,
    model?: string, tokensUsed?: number,
  }): number {
    const result = this.stmts.insertReflection.run(
      entry.sessionId, entry.content, Date.now(),
      entry.observationsCondensed, entry.model || null, entry.tokensUsed || 0,
    )
    return Number(result.lastInsertRowid)
  }

  getReflections(sessionId: string): Array<{
    id: number, content: string, reflected_at: number,
    observations_condensed: number,
  }> {
    return this.sqlite.prepare(
      'SELECT id, content, reflected_at, observations_condensed FROM reflections WHERE session_id = ? ORDER BY reflected_at ASC'
    ).all(sessionId) as any[]
  }

  /** Remove observations that have been condensed into a reflection */
  pruneObservations(sessionId: string, beforeId: number): number {
    const result = this.sqlite.prepare(
      'DELETE FROM observations WHERE session_id = ? AND id <= ?'
    ).run(sessionId, beforeId)
    return result.changes
  }

  observationTokenCount(sessionId: string): number {
    const row = this.sqlite.prepare(
      'SELECT SUM(length(content)) as chars FROM observations WHERE session_id = ?'
    ).get(sessionId) as { chars: number | null } | undefined
    // rough estimate: 1 token ~= 4 chars
    return Math.ceil((row?.chars || 0) / 4)
  }

  // --- Knowledge graph methods ---

  upsertNode(node: { id: string, name: string, type: string, file: string, tags: string[] }): void {
    this.stmts.upsertNode.run(node.id, node.name, node.type, node.file)
    this.stmts.clearTags.run(node.id)
    for (const tag of node.tags) {
      this.stmts.insertTag.run(node.id, tag)
    }
  }

  replaceEdges(edges: { from: string, to: string, relation: string }[]): void {
    const tx = this.sqlite.transaction(() => {
      this.stmts.clearEdges.run()
      for (const edge of edges) {
        this.stmts.insertEdge.run(edge.from, edge.to, edge.relation)
      }
    })
    tx()
  }

  nodeCount(type?: string): number {
    if (type) {
      const row = this.db.select({ value: count() })
        .from(knowledgeNodes)
        .where(eq(knowledgeNodes.type, type))
        .get()
      return row?.value ?? 0
    }
    return this.db.select({ value: count() }).from(knowledgeNodes).get()?.value ?? 0
  }

  edgeCount(): number {
    return this.db.select({ value: count() }).from(knowledgeEdges).get()?.value ?? 0
  }

  orphanNodes(): string[] {
    const rows = this.sqlite.prepare(`
      SELECT n.id FROM knowledge_nodes n
      LEFT JOIN knowledge_edges e1 ON e1.from_id = n.id
      LEFT JOIN knowledge_edges e2 ON e2.to_id = n.id
      WHERE e1.id IS NULL AND e2.id IS NULL
    `).all() as { id: string }[]
    return rows.map(r => r.id)
  }

  topHubs(limit = 15): { id: string, name: string, type: string, connections: number }[] {
    return this.sqlite.prepare(`
      SELECT n.id, n.name, n.type, COALESCE(e.cnt, 0) as connections
      FROM knowledge_nodes n
      JOIN (
        SELECT node_id, COUNT(*) as cnt FROM (
          SELECT from_id as node_id FROM knowledge_edges
          UNION ALL
          SELECT to_id as node_id FROM knowledge_edges
        ) GROUP BY node_id
      ) e ON e.node_id = n.id
      ORDER BY connections DESC
      LIMIT ?
    `).all(limit) as any[]
  }

  // --- Conversation search (FTS) ---

  search(query: string, opts?: {
    source?: string, role?: string, limit?: number, dateFrom?: string, dateTo?: string,
  }): Array<{
    date: string, source: string, role: string, session_id: string,
    text: string,
  }> {
    const limit = opts?.limit ?? 20
    // Escape FTS special chars and wrap terms in quotes
    const ftsQuery = query.replace(/["\-*^~(){}[\]:]/g, ' ').trim().split(/\s+/).filter(Boolean).map(t => `"${t}"`).join(' OR ')

    // Two-step: get rowids from FTS first (fast), then join with filters
    // FTS scan limit is generous to allow post-filtering
    const ftsLimit = limit * 20

    const filterParts: string[] = []
    const filterParams: any[] = []

    filterParts.push('b.type IN (\'text\', \'thinking\')')

    if (opts?.source) {
      filterParts.push('m.source = ?')
      filterParams.push(opts.source)
    }
    if (opts?.role) {
      filterParts.push('m.role = ?')
      filterParams.push(opts.role)
    }
    if (opts?.dateFrom) {
      filterParts.push('m.date >= ?')
      filterParams.push(opts.dateFrom)
    }
    if (opts?.dateTo) {
      filterParts.push('m.date <= ?')
      filterParams.push(opts.dateTo)
    }

    const whereClause = filterParts.length ? ' AND ' + filterParts.join(' AND ') : ''
    const queryLower = query.trim().toLowerCase().split(/\s+/)[0] // first word for substr highlight

    const sql = `
      SELECT DISTINCT m.date, m.source, m.role, m.session_id,
        substr(b.text, max(1, instr(lower(b.text), ?) - 80), 300) as text
      FROM blocks b
      JOIN messages m ON m.id = b.message_id
      WHERE b.id IN (
        SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? LIMIT ?
      )
      ${whereClause}
      ORDER BY m.timestamp DESC
      LIMIT ?
    `

    return this.sqlite.prepare(sql).all(queryLower, ftsQuery, ftsLimit, ...filterParams, limit) as any[]
  }

  // Search learnings by text (simple LIKE)
  searchLearnings(query: string, opts?: {
    category?: string, limit?: number,
  }): Array<{
    id: string, date: string, source: string, category: string | null,
    lesson: string, context: string | null, importance: number,
  }> {
    const limit = opts?.limit ?? 20
    const params: any[] = [`%${query}%`]
    let catFilter = ''
    if (opts?.category) {
      catFilter = ' AND category = ?'
      params.push(opts.category)
    }
    params.push(limit)

    return this.sqlite.prepare(`
      SELECT id, date, source, category, lesson, context, importance
      FROM learnings
      WHERE (lesson LIKE ? OR context LIKE ?)
        AND status = 'active'
        ${catFilter}
      ORDER BY importance DESC, date DESC
      LIMIT ?
    `).all(params[0], params[0], ...params.slice(1)) as any[]
  }

  getCursor(source: string): string {
    const row = this.db.select()
      .from(ingestState)
      .where(eq(ingestState.source, source))
      .get()
    return row?.cursor || '0'
  }

  setCursor(source: string, cursor: string): void {
    this.db.insert(ingestState)
      .values({ source, cursor, lastRun: Date.now() })
      .onConflictDoUpdate({
        target: ingestState.source,
        set: { cursor, lastRun: Date.now() },
      })
      .run()
  }

  count(source?: string): number {
    if (source) {
      const row = this.db.select({ value: count() })
        .from(messages)
        .where(eq(messages.source, source))
        .get()
      return row?.value ?? 0
    }
    const row = this.db.select({ value: count() })
      .from(messages)
      .get()
    return row?.value ?? 0
  }

  // --- Embedding cache ---

  getEmbedding(blockId: number): Buffer | null {
    const row = this.stmts.getEmbedding.get(blockId) as { embedding: Buffer } | undefined
    return row?.embedding ?? null
  }

  setEmbedding(blockId: number, embedding: Float32Array, model: string): void {
    this.stmts.setEmbedding.run(blockId, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength), model)
  }

  setEmbeddingBatch(items: Array<{ blockId: number, embedding: Float32Array, model: string }>): void {
    const tx = this.sqlite.transaction(() => {
      for (const item of items) {
        this.stmts.setEmbedding.run(
          item.blockId,
          Buffer.from(item.embedding.buffer, item.embedding.byteOffset, item.embedding.byteLength),
          item.model,
        )
      }
    })
    tx()
  }

  // Hybrid search: FTS candidates → embedding rerank
  // Returns FTS block IDs + text for embedding by caller
  getFTSCandidates(query: string, opts?: {
    source?: string, role?: string, limit?: number, dateFrom?: string, dateTo?: string,
  }): Array<{
    blockId: number, date: string, source: string, role: string,
    session_id: string, text: string, timestamp: number,
  }> {
    const limit = opts?.limit ?? 100
    const ftsQuery = query.replace(/["\-*^~(){}[\]:]/g, ' ').trim().split(/\s+/).filter(Boolean).map(t => `"${t}"`).join(' OR ')

    const filterParts: string[] = ['b.type IN (\'text\', \'thinking\')']
    const filterParams: any[] = []

    if (opts?.source) { filterParts.push('m.source = ?'); filterParams.push(opts.source) }
    if (opts?.role) { filterParts.push('m.role = ?'); filterParams.push(opts.role) }
    if (opts?.dateFrom) { filterParts.push('m.date >= ?'); filterParams.push(opts.dateFrom) }
    if (opts?.dateTo) { filterParts.push('m.date <= ?'); filterParams.push(opts.dateTo) }

    const whereClause = filterParts.length > 1 ? ' AND ' + filterParts.slice(1).join(' AND ') : ''

    return this.sqlite.prepare(`
      SELECT b.id as blockId, m.date, m.source, m.role, m.session_id, b.text, m.timestamp
      FROM blocks b
      JOIN messages m ON m.id = b.message_id
      WHERE b.id IN (
        SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ? LIMIT ?
      )
      AND b.type IN ('text', 'thinking')
      ${whereClause}
      ORDER BY m.timestamp DESC
      LIMIT ?
    `).all(ftsQuery, limit * 5, ...filterParams, limit) as any[]
  }

  // --- Learning embeddings ---

  getLearningEmbedding(id: string): Buffer | null {
    const row = this.stmts.getLearningEmbedding.get(id) as { embedding: Buffer } | undefined
    return row?.embedding ?? null
  }

  setLearningEmbedding(id: string, embedding: Float32Array, model: string): void {
    this.stmts.setLearningEmbedding.run(id, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength), model)
  }

  setLearningEmbeddingBatch(items: Array<{ id: string, embedding: Float32Array, model: string }>): void {
    const tx = this.sqlite.transaction(() => {
      for (const item of items) {
        this.stmts.setLearningEmbedding.run(
          item.id,
          Buffer.from(item.embedding.buffer, item.embedding.byteOffset, item.embedding.byteLength),
          item.model,
        )
      }
    })
    tx()
  }

  // Get all learnings (for bulk embedding)
  getAllLearnings(): Array<{ id: string, lesson: string, context: string | null, category: string | null }> {
    return this.sqlite.prepare(`
      SELECT id, lesson, context, category FROM learnings WHERE status = 'active'
    `).all() as any[]
  }

  // Get learnings without embeddings
  getUnembeddedLearnings(): Array<{ id: string, lesson: string, context: string | null, category: string | null }> {
    return this.sqlite.prepare(`
      SELECT l.id, l.lesson, l.context, l.category
      FROM learnings l
      LEFT JOIN learning_embeddings le ON le.learning_id = l.id
      WHERE l.status = 'active' AND le.learning_id IS NULL
    `).all() as any[]
  }

  // Vector search on learnings: returns all embeddings for cosine comparison
  getAllLearningEmbeddings(): Array<{ id: string, embedding: Buffer }> {
    return this.sqlite.prepare(
      'SELECT le.learning_id as id, le.embedding FROM learning_embeddings le JOIN learnings l ON l.id = le.learning_id WHERE l.status = \'active\''
    ).all() as any[]
  }

  learningEmbeddingStats(): { total: number, embedded: number } {
    const total = (this.sqlite.prepare('SELECT COUNT(*) as c FROM learnings WHERE status = \'active\'').get() as any).c
    const embedded = (this.sqlite.prepare('SELECT COUNT(*) as c FROM learning_embeddings').get() as any).c
    return { total, embedded }
  }

  embeddingCacheStats(): { total: number, models: Record<string, number> } {
    const total = (this.sqlite.prepare('SELECT COUNT(*) as c FROM embedding_cache').get() as any).c
    const rows = this.sqlite.prepare('SELECT model, COUNT(*) as c FROM embedding_cache GROUP BY model').all() as any[]
    const models: Record<string, number> = {}
    for (const r of rows) models[r.model] = r.c
    return { total, models }
  }

  get raw(): InstanceType<typeof Database> {
    return this.sqlite
  }

  close(): void {
    this.sqlite.close()
  }
}
