import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  source: text('source').notNull(),
  startedAt: integer('started_at'),
}, table => [
  index('idx_sessions_source').on(table.source),
])

export const messages = sqliteTable('messages', {
   id: integer('id').primaryKey({ autoIncrement: true }),
   source: text('source').notNull(),
   sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
   role: text('role').notNull(),
   timestamp: integer('timestamp').notNull(),
   date: text('date').notNull(),
}, table => [
  index('idx_messages_session').on(table.sessionId),
  index('idx_messages_source').on(table.source),
  index('idx_messages_date').on(table.date),
  index('idx_messages_timestamp').on(table.timestamp),
])

export const blocks = sqliteTable('blocks', {
   id: integer('id').primaryKey({ autoIncrement: true }),
   messageId: integer('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
   position: integer('position').notNull(),
   type: text('type').notNull(),
   text: text('text'),
   toolName: text('tool_name'),
   toolInput: text('tool_input'),
   toolCallId: text('tool_call_id'),
}, table => [
  index('idx_blocks_message').on(table.messageId),
  index('idx_blocks_type').on(table.type),
])

export const contexts = sqliteTable('contexts', {
   id: integer('id').primaryKey({ autoIncrement: true }),
   messageId: integer('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
   key: text('key').notNull(),
   value: text('value').notNull(),
}, table => [
  index('idx_contexts_message').on(table.messageId),
])

export const ingestState = sqliteTable('ingest_state', {
  source: text('source').primaryKey(),
  cursor: text('cursor').notNull(),
  lastRun: integer('last_run').notNull(),
})

export const memxaMetadata = sqliteTable('memxa_metadata', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

export const schema = {
  sessions,
  messages,
  blocks,
  contexts,
  ingestState,
  memxaMetadata,
}
