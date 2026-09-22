export type BlockType = "text" | "thinking" | "tool_call" | "tool_result" | (string & {});

/** A normalized content block within a harness message. */
export interface Block {
  type: BlockType;
  text?: string;
  toolName?: string;
  toolInput?: string;
  toolCallId?: string;
  /** Native tool result status; absent when the outcome is unknown. */
  isError?: boolean;
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
}

/** Optional native filter for adapters that can avoid scanning unrelated sessions. */
export interface SourceReadOptions {
  readonly sessionId?: string;
  /**
   * Epoch milliseconds a listing needs sessions to reach. An adapter may leave out a whole
   * session it can prove ended earlier, but never a single message of a session it reads.
   */
  readonly activeSince?: number;
}

/** One session summary projected without retaining its message payloads. */
export interface SourceSessionSummary {
  readonly id: string;
  readonly source: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
  readonly snippetText?: string;
}

/** Inclusive epoch millisecond bounds for session activity or message timestamps. */
export interface SessionTimeRange {
  readonly since?: number;
  readonly until?: number;
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
  summaryWindow?(
    offset: number,
    limit: number,
    range?: SessionTimeRange,
  ): Promise<SourceSummaryWindow>;
}
