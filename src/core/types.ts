export type BlockType = "text" | "thinking" | "tool_call" | "tool_result" | (string & {});

/** A normalized content block within a harness message. */
export interface Block {
  type: BlockType;
  text?: string;
  toolName?: string;
  toolInput?: string;
  toolCallId?: string;
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
  date: string;
  blocks: Block[];
  context?: Record<string, string>;
  author?: Participant;
  channel?: Channel;
}

/** Internal parser contract implemented by each harness adapter. */
export interface Source {
  readonly name: string;
  available(): boolean;
  read(): AsyncGenerator<Message>;
}
