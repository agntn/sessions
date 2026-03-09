import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const channels = sqliteTable(
  "channels",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    platform: text("platform").notNull(),
    platformId: text("platform_id"),
    name: text("name"),
    type: text("type"),
  },
  (table) => [index("idx_channels_platform").on(table.platform, table.platformId)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    channelId: text("channel_id").references(() => channels.id),
    createdAt: integer("created_at"),
    updatedAt: integer("updated_at"),
  },
  (table) => [
    index("idx_sessions_source").on(table.source),
    index("idx_sessions_channel").on(table.channelId),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    source: text("source").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    timestamp: integer("timestamp").notNull(),
    date: text("date").notNull(),
  },
  (table) => [
    index("idx_messages_session").on(table.sessionId),
    index("idx_messages_source").on(table.source),
    index("idx_messages_date").on(table.date),
    index("idx_messages_timestamp").on(table.timestamp),
  ],
);

export const blocks = sqliteTable(
  "blocks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    type: text("type").notNull(),
    text: text("text"),
    toolName: text("tool_name"),
    toolInput: text("tool_input"),
    toolCallId: text("tool_call_id"),
  },
  (table) => [
    index("idx_blocks_message").on(table.messageId),
    index("idx_blocks_type").on(table.type),
  ],
);

export const contexts = sqliteTable(
  "contexts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
  },
  (table) => [index("idx_contexts_message").on(table.messageId)],
);

export const participants = sqliteTable(
  "participants",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    platform: text("platform").notNull(),
    platformId: text("platform_id"),
    name: text("name").notNull(),
    isBot: integer("is_bot", { mode: "boolean" }).default(false),
  },
  (table) => [
    index("idx_participants_platform").on(table.platform, table.platformId),
    index("idx_participants_name").on(table.name),
  ],
);

export const sessionParticipants = sqliteTable(
  "session_participants",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    participantId: text("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    role: text("role"),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.participantId] }),
    index("idx_session_participants_session").on(table.sessionId),
    index("idx_session_participants_participant").on(table.participantId),
  ],
);

export const messageAuthors = sqliteTable(
  "message_authors",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    participantId: text("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.participantId] }),
    index("idx_message_authors_message").on(table.messageId),
    index("idx_message_authors_participant").on(table.participantId),
  ],
);

export const ingestState = sqliteTable("ingest_state", {
  source: text("source").primaryKey(),
  cursor: text("cursor").notNull(),
  lastRun: integer("last_run").notNull(),
});

export const memxaMetadata = sqliteTable("memxa_metadata", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const schema = {
  channels,
  sessions,
  messages,
  blocks,
  contexts,
  participants,
  sessionParticipants,
  messageAuthors,
  ingestState,
  memxaMetadata,
};
