export interface Block {
  type: string;
  text?: string;
  toolName?: string;
  toolInput?: string;
  toolCallId?: string;
}

export interface Channel {
  id?: string;
  platform: string;
  platformId?: string;
  name?: string;
  type?: string;
}

export interface Participant {
  id?: string;
  platform: string;
  platformId?: string;
  name: string;
  isBot?: boolean;
}

export interface Message {
  source: string;
  sessionId: string;
  role: "user" | "assistant" | "tool";
  timestamp: number;
  date: string;
  blocks: Block[];
  context?: Record<string, string>;
  author?: Participant;
  channel?: Channel;
}

export interface Source {
  name: string;
  available(): boolean;
  ingest(cursor: string): AsyncGenerator<Message>;
  cursor(messages: Message[]): string;
}

export interface Session {
  id: string;
  source: string;
  channelId: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface StoredMessage extends Message {
  id: string;
  author?: Participant & { id: string };
}

export interface SearchRow {
  date: string;
  source: string;
  role: string;
  sessionId: string;
  text: string;
}

export interface SourceStats {
  source: string;
  messages: number;
  sessions: number;
}

export interface Storage {
  init(): Promise<void>;
  close(): Promise<void>;

  getChannel(id: string): Promise<(Channel & { id: string }) | null>;
  findChannel(
    platform: string,
    by: { platformId?: string; name?: string },
  ): Promise<(Channel & { id: string }) | null>;
  listChannels(opts?: {
    platform?: string;
    limit?: number;
    offset?: number;
  }): Promise<Array<Channel & { id: string }>>;

  createSession(session: {
    id: string;
    source: string;
    channelId?: string;
    createdAt?: number;
  }): Promise<void>;
  getSession(id: string): Promise<Session | null>;
  listSessions(opts?: { source?: string; limit?: number; offset?: number }): Promise<Session[]>;
  deleteSession(id: string): Promise<void>;

  addMessage(message: Message): Promise<string>;
  getMessage(id: string): Promise<StoredMessage | null>;
  getMessages(
    sessionId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<StoredMessage[]>;
  insert(messages: Message[]): Promise<void>;

  search(
    query: string,
    opts?: {
      source?: string;
      role?: string;
      limit?: number;
      dateFrom?: string;
      dateTo?: string;
    },
  ): Promise<SearchRow[]>;
  count(source?: string): Promise<number>;
  sessionCount(): Promise<number>;
  sourceStats(): Promise<SourceStats[]>;

  getParticipant(id: string): Promise<(Participant & { id: string }) | null>;
  findParticipant(
    platform: string,
    platformId: string,
  ): Promise<(Participant & { id: string }) | null>;
  listParticipants(opts?: {
    platform?: string;
    limit?: number;
    offset?: number;
  }): Promise<Array<Participant & { id: string }>>;
  getSessionParticipants(sessionId: string): Promise<Array<Participant & { id: string }>>;

  getCursor(source: string): Promise<string>;
  setCursor(source: string, cursor: string): Promise<void>;
  deleteCursor(source: string): Promise<void>;
  deleteBySource(source: string): Promise<number>;
}

export interface IngestResult {
  source: string;
  count: number;
  cursor: string;
  skipped: boolean;
  error?: string;
}
