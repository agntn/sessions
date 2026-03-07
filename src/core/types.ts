/** Content block types present in AI conversations. */
export type BlockType = 'text' | 'thinking' | 'tool_call' | 'tool_result'

/** A single content block within a message. */
export interface Block {
  type: BlockType
  text?: string
  /** tool_call: tool name */
  toolName?: string
  /** tool_call: serialized input */
  toolInput?: string
  /** tool_call / tool_result: shared call ID */
  toolCallId?: string
}

/** Normalized conversation message from any AI tool. */
export interface Message {
  source: string
  sessionId: string
  role: 'user' | 'assistant' | 'tool'
  timestamp: number
  date: string
  blocks: Block[]
  /** Source-specific context (cwd, model, etc). */
  context?: Record<string, string>
}

/** A source that can produce messages from a specific AI tool. */
export interface Source {
  name: string
  available(): boolean
  ingest(cursor: string): AsyncGenerator<Message>
  cursor(messages: Message[]): string
}

/** Persistence layer for ingested messages. */
export interface Storage {
  init(): Promise<void>
  insert(messages: Message[]): Promise<void>
  getCursor(source: string): Promise<string>
  setCursor(source: string, cursor: string): Promise<void>
  count(source?: string): Promise<number>
  close(): Promise<void>
}

export type SourceFactory = () => Source

export interface IngestResult {
  source: string
  count: number
  cursor: string
  skipped: boolean
}
