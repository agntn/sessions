import type { Source } from "../core/types.ts";
import { UnknownSourceError } from "../core/errors.ts";

export { AeiSource } from "./aei.ts";
export { ClaudeSource } from "./claude.ts";
export { MastraSource } from "./mastra.ts";
export { OpenCodeSource } from "./opencode.ts";
export { CodexSource } from "./codex.ts";
export { GeminiSource } from "./gemini.ts";
export { OpenClawSource } from "./openclaw.ts";

import { AeiSource } from "./aei.ts";
import { ClaudeSource } from "./claude.ts";
import { MastraSource } from "./mastra.ts";
import { OpenCodeSource } from "./opencode.ts";
import { CodexSource } from "./codex.ts";
import { GeminiSource } from "./gemini.ts";
import { OpenClawSource } from "./openclaw.ts";

const providers: Record<string, new () => Source> = {
  aei: AeiSource,
  claude: ClaudeSource,
  mastra: MastraSource,
  opencode: OpenCodeSource,
  codex: CodexSource,
  gemini: GeminiSource,
  openclaw: OpenClawSource,
};

export function create(name: string): Source {
  const Provider = providers[name];
  if (!Provider) throw new UnknownSourceError(name);
  return new Provider();
}

export function sources(): string[] {
  return Object.keys(providers);
}

export function allSources(): Source[] {
  return Object.values(providers).map((P) => new P());
}

export function has(name: string): boolean {
  return name in providers;
}
