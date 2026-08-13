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

/** Optional native data location for a harness reader. */
export interface SourceOptions {
  readonly path?: string;
  readonly paths?: string[];
}

type AdapterFactory = (options?: SourceOptions) => Source;

const adapters: Record<string, AdapterFactory> = {
  aei: (options) => new AeiSource(options?.path),
  claude: (options) => new ClaudeSource(options?.path),
  codex: (options) => new CodexSource(options?.path),
  gemini: (options) => new GeminiSource(options?.path),
  mastra: (options) => new MastraSource(options?.path),
  openclaw: (options) =>
    new OpenClawSource(options?.paths ?? (options?.path ? [options.path] : undefined)),
  opencode: (options) => new OpenCodeSource(options?.path),
};

/** Creates a session reader for a supported harness. */
export function create(name: string, options?: SourceOptions): SessionReader {
  if (!Object.hasOwn(adapters, name)) throw new UnknownSourceError(name);
  const factory = adapters[name];
  if (!factory) throw new UnknownSourceError(name);
  return createSessionReader(factory(options));
}

/** Lists supported harness source names. */
export function sources(): string[] {
  return Object.keys(adapters);
}

/** Creates readers for all supported harnesses at their default locations. */
export function allSources(): SessionReader[] {
  return Object.values(adapters).map((factory) => createSessionReader(factory()));
}

/** Returns whether a harness source is supported. */
export function has(name: string): boolean {
  return Object.hasOwn(adapters, name);
}
