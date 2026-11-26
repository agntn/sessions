export type BlockType = "text" | "thinking" | "tool_call" | "tool_result" | "stop" | (string & {});

/** A normalized content block within a harness message. */
export interface Block {
  type: BlockType;
  text?: string;
  toolName?: string;
  toolInput?: string;
  toolCallId?: string;
  /** Native tool result status; absent when the outcome is unknown. */
  isError?: boolean;
  /** Native reason a `stop` block's turn ended early, such as `error` or `aborted`. */
  stopReason?: string;
}

/** Origin metadata retained when a harness exposes channels. */
export interface Channel {
  platform: string;
  platformId?: string;
  name?: string;
  type?: string;
}

/** Author metadata retained when a harness exposes participants. */
export interface Participant {
  platform: string;
  platformId?: string;
  name: string;
  isBot?: boolean;
}

/** The model a harness recorded on one assistant message, kept exactly as written. */
export interface Model {
  id: string;
  /** Present only when the harness stores it next to the model. */
  provider?: string;
}

/** A normalized message read from a native harness session. */
export interface Message {
  source: string;
  sessionId: string;
  role: "user" | "assistant" | "tool";
  timestamp: number;
  /** Native message time or its fallback origin; absent when provenance is not reported. */
  timestampSource?: "message" | "session" | "file";
  /** Native session creation time when this message's clock is not that instant. */
  sessionCreatedAt?: number;
  /** Native session last activity when this message's clock is not that instant. */
  sessionUpdatedAt?: number;
  date: string;
  blocks: Block[];
  context?: Record<string, string>;
  author?: Participant;
  channel?: Channel;
  /** The agent the whole session belongs to, whoever wrote this message. */
  owner?: Participant;
  /** Absent when the harness recorded none. Never guessed. */
  model?: Model;
}

/** Optional native filter for adapters that can avoid scanning unrelated sessions. */
export interface SourceReadOptions {
  readonly sessionId?: string;
  /**
   * Epoch milliseconds a listing needs sessions to reach. An adapter may leave out a whole
   * session it can prove ended earlier, but never a single message of a session it reads.
   */
  readonly activeSince?: number;
  /** Absolute directory a listing keeps. Same deal: only whole sessions proven elsewhere go. */
  readonly cwd?: string;
}

/** One session summary projected without retaining its message payloads. */
export interface SourceSessionSummary {
  readonly id: string;
  readonly source: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
  readonly snippetText?: string;
  /** Where the session ran, when the source records it. */
  readonly cwd?: string;
}

/** Inclusive epoch millisecond bounds for session activity or message timestamps. */
export interface SessionTimeRange {
  readonly since?: number;
  readonly until?: number;
}

/** Which sessions a listing keeps: last activity bounds and, optionally, a working directory. */
export interface SessionListFilter extends SessionTimeRange {
  /** Absolute directory a session ran in or below. A session without one never matches. */
  readonly cwd?: string;
  /** Stable owner id, such as an OpenBot agent id. A session without an owner never matches. */
  readonly owner?: string;
}

/** A bounded native summary page plus the complete session count. */
export interface SourceSummaryWindow {
  readonly total: number;
  readonly sessions: readonly SourceSessionSummary[];
}

/** Native parser contract used by streaming and bounded reads. */
export interface Source {
  readonly name: string;
  available(): boolean;
  read(options?: SourceReadOptions): AsyncGenerator<Message>;
  /** A native projection that applies every field of `filter` before `offset` and `limit`. */
  summaryWindow?(
    offset: number,
    limit: number,
    filter?: SessionListFilter,
  ): Promise<SourceSummaryWindow>;
}
