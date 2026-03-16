import { createClient, type Client } from "@libsql/client";
import { asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StorageError } from "../core/errors.ts";
import type {
  Channel,
  Message,
  Participant,
  SearchRow,
  Session,
  SourceStats,
  Storage,
  StoredMessage,
} from "../core/types.ts";
import {
  blocks,
  channels,
  contexts,
  ingestState,
  memxaMetadata,
  messages,
  participants,
  schema,
  sessionParticipants,
  sessions,
} from "./schema.ts";

interface SqliteStorageInitOptions {
  initialize?: boolean;
}

function resolveMigrationsFolder(): string {
  const baseDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(baseDir, "../../drizzle"), resolve(baseDir, "../drizzle")];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new StorageError(
    "Cannot find drizzle migrations folder. Searched: " + candidates.join(", "),
  );
}

function toFileUrl(path: string): string {
  const absPath = resolve(path);
  return `file:${absPath}`;
}

type BlockRow = {
  type: string;
  text: string | null;
  toolName: string | null;
  toolInput: string | null;
  toolCallId: string | null;
};

type ContextRow = { messageId: string; key: string; value: string };

function toBlock(b: BlockRow) {
  return {
    type: b.type,
    text: b.text ?? undefined,
    toolName: b.toolName ?? undefined,
    toolInput: b.toolInput ?? undefined,
    toolCallId: b.toolCallId ?? undefined,
  };
}

function toContext(rows: ContextRow[]): Record<string, string> | undefined {
  if (!rows.length) return undefined;
  return Object.fromEntries(rows.map((c) => [c.key, c.value]));
}

function clampInt(value: number | undefined, fallback: number, min = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.trunc(value));
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const arr = map.get(k) ?? [];
    arr.push(item);
    map.set(k, arr);
  }
  return map;
}

function resolveSessionId(message: Message): string {
  if (message.sessionId) return message.sessionId;

  const channelKey = message.channel?.platformId ?? message.channel?.name ?? "";
  const digest = createHash("sha1")
    .update([message.source, message.date, channelKey].join("|"))
    .digest("hex")
    .slice(0, 12);

  return `${message.source}-${message.date}-${digest}`;
}

export class SqliteStorage implements Storage {
  private readonly client: Client;
  private readonly db: ReturnType<typeof drizzle<typeof schema>>;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    const client = createClient({ url: toFileUrl(path) });
    this.client = client;
    this.db = drizzle(client, { schema });
  }

  async init(): Promise<void> {
    const pragma = await this.client.execute("PRAGMA user_version");
    const legacyVersion = Number((pragma.rows[0] as Record<string, unknown>)?.user_version ?? 0);

    await migrate(this.db, { migrationsFolder: resolveMigrationsFolder() });

    if (legacyVersion > 0) {
      const existing = await this.db
        .select({ value: memxaMetadata.value })
        .from(memxaMetadata)
        .where(eq(memxaMetadata.key, "legacy_user_version"))
        .get();

      if (!existing) {
        await this.db
          .insert(memxaMetadata)
          .values({ key: "legacy_user_version", value: String(legacyVersion) })
          .onConflictDoUpdate({
            target: memxaMetadata.key,
            set: { value: String(legacyVersion) },
          })
          .run();

        await this.db
          .insert(memxaMetadata)
          .values({ key: "legacy_schema_origin", value: "pre-drizzle-kit-sqlite" })
          .onConflictDoUpdate({
            target: memxaMetadata.key,
            set: { value: "pre-drizzle-kit-sqlite" },
          })
          .run();
      }
    }
  }

  get raw(): Client {
    return this.client;
  }

  async close(): Promise<void> {
    this.client.close();
  }

  async insert(batch: Message[]): Promise<void> {
    const statements: Array<{ sql: string; args: (string | number | null)[] }> = [];
    const channelCache = new Map<string, string>();
    const participantCache = new Map<string, string>();

    for (const message of batch) {
      const sessionId = resolveSessionId(message);
      const channelId = await this.resolveChannelIdForBatch(
        message.channel,
        channelCache,
        statements,
      );
      const participantId = message.author
        ? await this.resolveParticipantIdForBatch(message.author, participantCache, statements)
        : null;

      statements.push({
        sql: `INSERT INTO sessions (id, source, channel_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              channel_id = coalesce(sessions.channel_id, excluded.channel_id),
              updated_at = case when sessions.updated_at is null or sessions.updated_at < excluded.updated_at then excluded.updated_at else sessions.updated_at end`,
        args: [sessionId, message.source, channelId, message.timestamp, message.timestamp],
      });

      const messageId = crypto.randomUUID();
      statements.push({
        sql: "INSERT INTO messages (id, source, session_id, role, timestamp, date) VALUES (?, ?, ?, ?, ?, ?)",
        args: [messageId, message.source, sessionId, message.role, message.timestamp, message.date],
      });

      for (let i = 0; i < message.blocks.length; i++) {
        const block = message.blocks[i];
        statements.push({
          sql: "INSERT INTO blocks (message_id, position, type, text, tool_name, tool_input, tool_call_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
          args: [
            messageId,
            i,
            block.type,
            block.text ?? null,
            block.toolName ?? null,
            block.toolInput ?? null,
            block.toolCallId ?? null,
          ],
        });
      }

      if (message.context) {
        for (const [key, value] of Object.entries(message.context)) {
          statements.push({
            sql: "INSERT INTO contexts (message_id, key, value) VALUES (?, ?, ?)",
            args: [messageId, key, value],
          });
        }
      }

      if (participantId) {
        statements.push({
          sql: "INSERT OR IGNORE INTO session_participants (session_id, participant_id) VALUES (?, ?)",
          args: [sessionId, participantId],
        });
        statements.push({
          sql: "INSERT OR IGNORE INTO message_authors (message_id, participant_id) VALUES (?, ?)",
          args: [messageId, participantId],
        });
      }
    }

    if (statements.length > 0) {
      await this.client.batch(statements as Parameters<typeof this.client.batch>[0], "write");
    }
  }

  async createSession(session: {
    id: string;
    source: string;
    channelId?: string;
    createdAt?: number;
  }): Promise<void> {
    const ts = session.createdAt ?? Date.now();
    await this.db
      .insert(sessions)
      .values({
        id: session.id,
        source: session.source,
        channelId: session.channelId ?? null,
        createdAt: ts,
        updatedAt: ts,
      })
      .onConflictDoUpdate({
        target: sessions.id,
        set: {
          channelId: sql`coalesce(${sessions.channelId}, excluded.channel_id)`,
          updatedAt: sql`case when ${sessions.updatedAt} is null or ${sessions.updatedAt} < excluded.updated_at then excluded.updated_at else ${sessions.updatedAt} end`,
        },
      })
      .run();
  }

  async getSession(id: string): Promise<Session | null> {
    return (
      (await this.db
        .select({
          id: sessions.id,
          source: sessions.source,
          channelId: sessions.channelId,
          createdAt: sessions.createdAt,
          updatedAt: sessions.updatedAt,
        })
        .from(sessions)
        .where(eq(sessions.id, id))
        .get()) ?? null
    );
  }

  async listSessions(opts?: {
    source?: string;
    limit?: number;
    offset?: number;
  }): Promise<Session[]> {
    const query = this.db
      .select({
        id: sessions.id,
        source: sessions.source,
        channelId: sessions.channelId,
        createdAt: sessions.createdAt,
        updatedAt: sessions.updatedAt,
      })
      .from(sessions);

    const filtered = opts?.source ? query.where(eq(sessions.source, opts.source)) : query;

    return await filtered
      .orderBy(desc(sessions.updatedAt), desc(sessions.createdAt))
      .limit(clampInt(opts?.limit, 50, 1))
      .offset(clampInt(opts?.offset, 0))
      .all();
  }

  async deleteSession(id: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.id, id)).run();
  }

  async addMessage(message: Message): Promise<string> {
    const sessionId = resolveSessionId(message);
    const channelId = await this.resolveChannelId(message.channel);

    await this.db
      .insert(sessions)
      .values({
        id: sessionId,
        source: message.source,
        channelId,
        createdAt: message.timestamp,
        updatedAt: message.timestamp,
      })
      .onConflictDoUpdate({
        target: sessions.id,
        set: {
          channelId: sql`coalesce(${sessions.channelId}, excluded.channel_id)`,
          updatedAt: sql`case when ${sessions.updatedAt} is null or ${sessions.updatedAt} < excluded.updated_at then excluded.updated_at else ${sessions.updatedAt} end`,
        },
      })
      .run();

    const messageId = crypto.randomUUID();
    await this.db
      .insert(messages)
      .values({
        id: messageId,
        source: message.source,
        sessionId,
        role: message.role,
        timestamp: message.timestamp,
        date: message.date,
      })
      .run();

    if (message.blocks.length > 0) {
      await this.db
        .insert(blocks)
        .values(
          message.blocks.map((block, index) => ({
            messageId,
            position: index,
            type: block.type,
            text: block.text ?? null,
            toolName: block.toolName ?? null,
            toolInput: block.toolInput ?? null,
            toolCallId: block.toolCallId ?? null,
          })),
        )
        .run();
    }

    if (message.context) {
      await this.db
        .insert(contexts)
        .values(
          Object.entries(message.context).map(([key, value]) => ({
            messageId,
            key,
            value,
          })),
        )
        .run();
    }

    if (message.author) {
      const participantId = await this.resolveParticipantId(message.author);
      if (participantId) await this.linkParticipant(participantId, sessionId, messageId);
    }

    return messageId;
  }

  async getMessage(id: string): Promise<StoredMessage | null> {
    const msg = await this.db.select().from(messages).where(eq(messages.id, id)).get();
    if (!msg) return null;

    const msgBlocks = await this.db
      .select()
      .from(blocks)
      .where(eq(blocks.messageId, id))
      .orderBy(asc(blocks.position))
      .all();

    const msgContexts = await this.db
      .select()
      .from(contexts)
      .where(eq(contexts.messageId, id))
      .all();

    const authorRow = await this.client.execute({
      sql: `
      SELECT p.id, p.platform, p.platform_id as platformId, p.name, p.is_bot as isBot
      FROM message_authors ma JOIN participants p ON p.id = ma.participant_id
      WHERE ma.message_id = ? LIMIT 1
    `,
      args: [id],
    });

    const author = authorRow.rows[0]
      ? {
          id: (authorRow.rows[0] as Record<string, unknown>).id as string,
          platform: (authorRow.rows[0] as Record<string, unknown>).platform as string,
          platformId:
            ((authorRow.rows[0] as Record<string, unknown>).platformId as string) ?? undefined,
          name: (authorRow.rows[0] as Record<string, unknown>).name as string,
          isBot: !!((authorRow.rows[0] as Record<string, unknown>).isBot as number),
        }
      : undefined;

    return {
      id: msg.id,
      source: msg.source,
      sessionId: msg.sessionId,
      role: msg.role as Message["role"],
      timestamp: msg.timestamp,
      date: msg.date,
      blocks: msgBlocks.map(toBlock),
      context: toContext(msgContexts as ContextRow[]),
      author,
    };
  }

  async getMessages(
    sessionId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<StoredMessage[]> {
    const msgs = await this.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.timestamp))
      .limit(clampInt(opts?.limit, 1000, 1))
      .offset(clampInt(opts?.offset, 0))
      .all();

    if (!msgs.length) return [];

    const msgIds = msgs.map((m) => m.id);
    const allBlocks = await this.db
      .select()
      .from(blocks)
      .where(inArray(blocks.messageId, msgIds))
      .orderBy(asc(blocks.position))
      .all();

    const allContexts = await this.db
      .select()
      .from(contexts)
      .where(inArray(contexts.messageId, msgIds))
      .all();

    const blocksByMsg = groupBy(allBlocks, (b) => b.messageId);
    const ctxByMsg = groupBy(allContexts, (c) => c.messageId);

    type AuthorRow = {
      messageId: string;
      id: string;
      platform: string;
      platformId: string | null;
      name: string;
      isBot: number;
    };

    const authorRows: AuthorRow[] = msgIds.length
      ? (
          await this.client.execute({
            sql: `
          SELECT ma.message_id as messageId, p.id, p.platform, p.platform_id as platformId, p.name, p.is_bot as isBot
          FROM message_authors ma JOIN participants p ON p.id = ma.participant_id
          WHERE ma.message_id IN (${msgIds.map(() => "?").join(",")})
        `,
            args: msgIds,
          })
        ).rows.map((r) => r as unknown as AuthorRow)
      : [];
    const authorByMsg = new Map(authorRows.map((r) => [r.messageId, r]));

    return msgs.map((msg) => {
      const a = authorByMsg.get(msg.id);
      return {
        id: msg.id,
        source: msg.source,
        sessionId: msg.sessionId,
        role: msg.role as Message["role"],
        timestamp: msg.timestamp,
        date: msg.date,
        blocks: (blocksByMsg.get(msg.id) ?? []).map(toBlock),
        context: toContext((ctxByMsg.get(msg.id) ?? []) as ContextRow[]),
        author: a
          ? {
              id: a.id,
              platform: a.platform,
              platformId: a.platformId ?? undefined,
              name: a.name,
              isBot: !!a.isBot,
            }
          : undefined,
      };
    });
  }

  private channelCacheKey(channel: Message["channel"]): string | null {
    if (!channel) return null;
    return [
      channel.platform,
      channel.platformId ?? "",
      channel.name ?? "",
      channel.type ?? "",
    ].join("\0");
  }

  private participantCacheKey(author: Message["author"]): string | null {
    if (!author) return null;
    return [author.platform, author.platformId ?? "", author.name, author.isBot ? "1" : "0"].join(
      "\0",
    );
  }

  private async findChannelId(channel: Message["channel"]): Promise<string | null> {
    if (!channel) return null;

    if (channel.platformId) {
      const existing = await this.db
        .select({ id: channels.id })
        .from(channels)
        .where(
          sql`${channels.platform} = ${channel.platform} AND ${channels.platformId} = ${channel.platformId}`,
        )
        .get();
      if (existing) return existing.id;
      return null;
    }

    if (channel.name) {
      const existing = await this.db
        .select({ id: channels.id })
        .from(channels)
        .where(
          sql`${channels.platform} = ${channel.platform} AND ${channels.name} = ${channel.name} AND ${channels.platformId} IS NULL`,
        )
        .get();
      if (existing) return existing.id;
      return null;
    }

    const existing = await this.db
      .select({ id: channels.id })
      .from(channels)
      .where(
        sql`${channels.platform} = ${channel.platform} AND ${channels.name} IS NULL AND ${channels.platformId} IS NULL`,
      )
      .get();
    return existing?.id ?? null;
  }

  private async findParticipantId(author: Message["author"]): Promise<string | null> {
    if (!author) return null;

    const existing = author.platformId
      ? await this.db
          .select({ id: participants.id })
          .from(participants)
          .where(
            sql`${participants.platform} = ${author.platform} AND ${participants.platformId} = ${author.platformId}`,
          )
          .get()
      : await this.db
          .select({ id: participants.id })
          .from(participants)
          .where(
            sql`${participants.platform} = ${author.platform} AND ${participants.name} = ${author.name} AND ${participants.platformId} IS NULL`,
          )
          .get();

    return existing?.id ?? null;
  }

  private async resolveChannelIdForBatch(
    channel: Message["channel"],
    cache: Map<string, string>,
    statements: Array<{ sql: string; args: unknown[] }>,
  ): Promise<string | null> {
    if (!channel) return null;

    const cacheKey = this.channelCacheKey(channel);
    if (cacheKey) {
      const cached = cache.get(cacheKey);
      if (cached) return cached;
    }

    const existing = await this.findChannelId(channel);
    if (existing) {
      if (cacheKey) cache.set(cacheKey, existing);
      return existing;
    }

    const id = crypto.randomUUID();
    statements.push({
      sql: "INSERT OR IGNORE INTO channels (id, platform, platform_id, name, type) VALUES (?, ?, ?, ?, ?)",
      args: [
        id,
        channel.platform,
        channel.platformId ?? null,
        channel.name ?? null,
        channel.type ?? null,
      ],
    });
    if (cacheKey) cache.set(cacheKey, id);
    return id;
  }

  private async resolveParticipantIdForBatch(
    author: Message["author"],
    cache: Map<string, string>,
    statements: Array<{ sql: string; args: unknown[] }>,
  ): Promise<string | null> {
    if (!author) return null;

    const cacheKey = this.participantCacheKey(author);
    if (cacheKey) {
      const cached = cache.get(cacheKey);
      if (cached) return cached;
    }

    const existing = await this.findParticipantId(author);
    if (existing) {
      if (cacheKey) cache.set(cacheKey, existing);
      return existing;
    }

    const id = crypto.randomUUID();
    statements.push({
      sql: "INSERT OR IGNORE INTO participants (id, platform, platform_id, name, is_bot) VALUES (?, ?, ?, ?, ?)",
      args: [id, author.platform, author.platformId ?? null, author.name, author.isBot ? 1 : 0],
    });
    if (cacheKey) cache.set(cacheKey, id);
    return id;
  }

  private async resolveChannelId(channel: Message["channel"]): Promise<string | null> {
    if (!channel) return null;

    const existing = await this.findChannelId(channel);
    if (existing) return existing;

    const id = crypto.randomUUID();
    await this.db
      .insert(channels)
      .values({
        id,
        platform: channel.platform,
        platformId: channel.platformId ?? null,
        name: channel.name ?? null,
        type: channel.type ?? null,
      })
      .onConflictDoNothing()
      .run();
    return id;
  }

  private async resolveParticipantId(author: Message["author"]): Promise<string | null> {
    if (!author) return null;

    const existing = await this.findParticipantId(author);
    if (existing) return existing;

    const id = crypto.randomUUID();
    await this.db
      .insert(participants)
      .values({
        id,
        platform: author.platform,
        platformId: author.platformId ?? null,
        name: author.name,
        isBot: author.isBot ?? false,
      })
      .onConflictDoNothing()
      .run();
    return id;
  }

  private async linkParticipant(
    participantId: string,
    sessionId: string,
    messageId: string,
  ): Promise<void> {
    await this.db
      .insert(sessionParticipants)
      .values({ sessionId, participantId })
      .onConflictDoNothing()
      .run();
    await this.client.execute({
      sql: "INSERT OR IGNORE INTO message_authors (message_id, participant_id) VALUES (?, ?)",
      args: [messageId, participantId],
    });
  }

  async getParticipant(id: string): Promise<(Participant & { id: string }) | null> {
    const row = await this.db.select().from(participants).where(eq(participants.id, id)).get();
    if (!row) return null;
    return {
      id: row.id,
      platform: row.platform,
      platformId: row.platformId ?? undefined,
      name: row.name,
      isBot: row.isBot ?? false,
    };
  }

  async findParticipant(
    platform: string,
    platformId: string,
  ): Promise<(Participant & { id: string }) | null> {
    const row = await this.db
      .select()
      .from(participants)
      .where(
        sql`${participants.platform} = ${platform} AND ${participants.platformId} = ${platformId}`,
      )
      .get();
    if (!row) return null;
    return {
      id: row.id,
      platform: row.platform,
      platformId: row.platformId ?? undefined,
      name: row.name,
      isBot: row.isBot ?? false,
    };
  }

  async listParticipants(opts?: {
    platform?: string;
    limit?: number;
    offset?: number;
  }): Promise<Array<Participant & { id: string }>> {
    const query = this.db.select().from(participants);
    const filtered = opts?.platform ? query.where(eq(participants.platform, opts.platform)) : query;
    const rows = await filtered
      .orderBy(asc(participants.name))
      .limit(clampInt(opts?.limit, 50, 1))
      .offset(clampInt(opts?.offset, 0))
      .all();
    return rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      platformId: r.platformId ?? undefined,
      name: r.name,
      isBot: r.isBot ?? false,
    }));
  }

  async getSessionParticipants(sessionId: string): Promise<Array<Participant & { id: string }>> {
    const rows = await this.db
      .select({
        id: participants.id,
        platform: participants.platform,
        platformId: participants.platformId,
        name: participants.name,
        isBot: participants.isBot,
      })
      .from(sessionParticipants)
      .innerJoin(participants, eq(sessionParticipants.participantId, participants.id))
      .where(eq(sessionParticipants.sessionId, sessionId))
      .all();
    return rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      platformId: r.platformId ?? undefined,
      name: r.name,
      isBot: r.isBot ?? false,
    }));
  }

  async getChannel(id: string): Promise<(Channel & { id: string }) | null> {
    const row = await this.db.select().from(channels).where(eq(channels.id, id)).get();
    if (!row) return null;
    return {
      id: row.id,
      platform: row.platform,
      platformId: row.platformId ?? undefined,
      name: row.name ?? undefined,
      type: row.type ?? undefined,
    };
  }

  async findChannel(
    platform: string,
    by: { platformId?: string; name?: string },
  ): Promise<(Channel & { id: string }) | null> {
    if (!by.platformId && !by.name) return null;

    const predicate = by.platformId
      ? sql`${channels.platform} = ${platform} AND ${channels.platformId} = ${by.platformId}`
      : sql`${channels.platform} = ${platform} AND ${channels.name} = ${by.name} AND ${channels.platformId} IS NULL`;

    const row = await this.db.select().from(channels).where(predicate).get();
    if (!row) return null;
    return {
      id: row.id,
      platform: row.platform,
      platformId: row.platformId ?? undefined,
      name: row.name ?? undefined,
      type: row.type ?? undefined,
    };
  }

  async listChannels(opts?: {
    platform?: string;
    limit?: number;
    offset?: number;
  }): Promise<Array<Channel & { id: string }>> {
    const query = this.db.select().from(channels);
    const filtered = opts?.platform ? query.where(eq(channels.platform, opts.platform)) : query;
    const rows = await filtered
      .orderBy(asc(channels.platform), asc(channels.name))
      .limit(clampInt(opts?.limit, 50, 1))
      .offset(clampInt(opts?.offset, 0))
      .all();
    return rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      platformId: r.platformId ?? undefined,
      name: r.name ?? undefined,
      type: r.type ?? undefined,
    }));
  }

  async getCursor(source: string): Promise<string> {
    const row = await this.db
      .select({ cursor: ingestState.cursor })
      .from(ingestState)
      .where(eq(ingestState.source, source))
      .get();

    return row?.cursor ?? "0";
  }

  async setCursor(source: string, cursor: string): Promise<void> {
    await this.db
      .insert(ingestState)
      .values({ source, cursor, lastRun: Date.now() })
      .onConflictDoUpdate({
        target: ingestState.source,
        set: { cursor, lastRun: Date.now() },
      })
      .run();
  }

  async count(source?: string): Promise<number> {
    if (source) {
      const row = await this.db
        .select({ value: count() })
        .from(messages)
        .where(eq(messages.source, source))
        .get();
      return row?.value ?? 0;
    }

    const row = await this.db.select({ value: count() }).from(messages).get();
    return row?.value ?? 0;
  }

  async search(
    query: string,
    opts?: {
      source?: string;
      role?: string;
      limit?: number;
      dateFrom?: string;
      dateTo?: string;
    },
  ): Promise<SearchRow[]> {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];

    const rawLimit = opts?.limit;
    const limit =
      typeof rawLimit === "number" && Number.isFinite(rawLimit)
        ? Math.max(1, Math.trunc(rawLimit))
        : 20;
    const filterParams: Array<string | number> = [];
    const filters = ["b.type IN ('text', 'thinking', 'reasoning')"];

    filters.push(`(${terms.map(() => "lower(b.text) LIKE ? ESCAPE '\\'").join(" OR ")})`);
    filterParams.push(...terms.map((term) => `%${term.replace(/[\\%_]/g, "\\$&")}%`));

    if (opts?.source) {
      filters.push("m.source = ?");
      filterParams.push(opts.source);
    }
    if (opts?.role) {
      filters.push("m.role = ?");
      filterParams.push(opts.role);
    }
    if (opts?.dateFrom) {
      filters.push("m.date >= ?");
      filterParams.push(opts.dateFrom);
    }
    if (opts?.dateTo) {
      filters.push("m.date <= ?");
      filterParams.push(opts.dateTo);
    }

    const snippetExprs = terms.map(() => "nullif(instr(lower(b.text), ?), 0)");
    const snippetPosition = `coalesce(${snippetExprs.join(", ")}, 1)`;

    const rawSql = `
      SELECT DISTINCT m.date, m.source, m.role, m.session_id as sessionId,
        substr(b.text, max(1, ${snippetPosition} - 80), 300) as text
      FROM blocks b
      JOIN messages m ON m.id = b.message_id
      WHERE ${filters.join(" AND ")}
      ORDER BY m.timestamp DESC
      LIMIT ?
    `;

    const result = await this.client.execute({
      sql: rawSql,
      args: [...terms, ...filterParams, limit],
    });

    return result.rows.map((row) => row as unknown as SearchRow);
  }

  async sessionCount(): Promise<number> {
    const row = await this.db.select({ value: count() }).from(sessions).get();
    return row?.value ?? 0;
  }

  async sourceStats(): Promise<SourceStats[]> {
    const messageCount = sql<number>`count(distinct ${messages.id})`;
    const sessionCount = sql<number>`count(distinct ${messages.sessionId})`;

    return await this.db
      .select({
        source: messages.source,
        messages: messageCount,
        sessions: sessionCount,
      })
      .from(messages)
      .groupBy(messages.source)
      .orderBy(desc(messageCount))
      .all();
  }
}

export async function createSqliteStorage(
  path: string,
  options: SqliteStorageInitOptions = {},
): Promise<SqliteStorage> {
  const storage = new SqliteStorage(path);

  if (options.initialize ?? true) {
    await storage.init();
  }

  return storage;
}
