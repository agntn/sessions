import type { Source } from "../core/types.ts";
import type { SessionReader } from "../core/session.ts";
import { createSessionReader } from "../core/session.ts";
import { UnknownSourceError } from "../core/errors.ts";
import { AeiSource } from "./aei.ts";
import { ClaudeSource } from "./claude.ts";
import { CodexSource } from "./codex.ts";
import { GeminiSource } from "./gemini.ts";
import { MastraSource } from "./mastra.ts";
import { OpenClawSource } from "./openclaw.ts";
import { OpenCodeSource } from "./opencode.ts";

const adapters: Record<string, new () => Source> = {
  aei: AeiSource,
  claude: ClaudeSource,
  codex: CodexSource,
  gemini: GeminiSource,
  mastra: MastraSource,
  openclaw: OpenClawSource,
  opencode: OpenCodeSource,
};

/** Creates a session reader for a supported harness. */
export function create(name: string): SessionReader {
  if (!Object.hasOwn(adapters, name)) throw new UnknownSourceError(name);
  const Adapter = adapters[name];
  if (!Adapter) throw new UnknownSourceError(name);
  return createSessionReader(new Adapter());
}

/** Lists supported harness source names. */
export function sources(): string[] {
  return Object.keys(adapters);
}

/** Creates readers for all supported harnesses. */
export function allSources(): SessionReader[] {
  return Object.values(adapters).map((Adapter) => createSessionReader(new Adapter()));
}

/** Returns whether a harness source is supported. */
export function has(name: string): boolean {
  return Object.hasOwn(adapters, name);
}
