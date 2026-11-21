import type { Source } from "../core/types.ts";
import type { SessionReader } from "../core/session.ts";
import { createSessionReader } from "../core/session.ts";
import { statSync } from "node:fs";
import type { SourceData } from "../core/errors.ts";
import { SourcePathError, UnknownSourceError } from "../core/errors.ts";
import { ClaudeSource } from "./claude.ts";
import { CodexSource } from "./codex.ts";
import { GeminiSource } from "./gemini.ts";
import { GrokSource } from "./grok.ts";
import { MastraSource } from "./mastra.ts";
import { OmpSource } from "./omp.ts";
import { OpenBotSource } from "./openbot.ts";
import { OpenClawSource } from "./openclaw.ts";
import { OpenCodeSource } from "./opencode.ts";
import { PiSource } from "./pi.ts";
import { VibeSource } from "./vibe.ts";
/** Optional native data location for a harness reader. */
export interface SourceOptions {
  readonly path?: string;
  readonly paths?: string[];
}

type SourceOptionsInput = Readonly<Omit<SourceOptions, "paths">> & {
  readonly paths?: readonly string[];
};

type AdapterFactory = (options?: SourceOptionsInput) => Source;

const adapters: Record<string, AdapterFactory> = {
  claude: (options) => new ClaudeSource(options?.path),
  codex: (options) => new CodexSource(options?.path),
  gemini: (options) => new GeminiSource(options?.path),
  grok: (options) => new GrokSource(options?.path),
  mastra: (options) => new MastraSource(options?.path),
  omp: (options) => new OmpSource(options?.path),
  openbot: (options) => new OpenBotSource(options?.path),
  openclaw: (options) =>
    new OpenClawSource(options?.paths ?? (options?.path ? [options.path] : undefined)),
  opencode: (options) => new OpenCodeSource(options?.path),
  pi: (options) => new PiSource(options?.path),
  vibe: (options) => new VibeSource(options?.path),
};

/** Sources whose path is one database file; the rest read a directory of session files. */
const databaseSources = new Set(["mastra", "openbot", "opencode"]);

function overridePaths(
  name: string,
  options?: SourceOptionsInput,
): readonly (string | undefined)[] {
  return name === "openclaw" && options?.paths ? options.paths : [options?.path];
}

function holds(path: string, expected: SourceData): boolean {
  try {
    const stats = statSync(path, { throwIfNoEntry: false });
    if (!stats) return true;
    return expected === "directory" ? stats.isDirectory() : stats.isFile();
  } catch {
    return true;
  }
}

/**
 * Refuses an existing override of the wrong kind; a missing or unreadable one stays with `available()`.
 *
 * @param name - Registered harness source name.
 * @param options - Optional native data location overrides.
 * @throws {SourcePathError} When an existing override is the wrong kind of entry.
 */
function assertPathKind(name: string, options?: SourceOptionsInput): void {
  const expected: SourceData = databaseSources.has(name) ? "database file" : "directory";
  for (const path of overridePaths(name, options)) {
    if (path && !holds(path, expected)) throw new SourcePathError(name, path, expected);
  }
}

/**
 * Creates a session reader for a supported harness.
 *
 * @param name - Registered harness source name.
 * @param options - Optional native data location overrides.
 * @returns {SessionReader} A session-oriented reader for the harness.
 */
export function create(name: string, options?: SourceOptionsInput): SessionReader {
  return createSessionReader(createSource(name, options));
}

/**
 * Creates a native parser for streaming or bounded library reads.
 *
 * @param name - Registered harness source name.
 * @param options - Optional native data location overrides.
 * @returns {Source} The native harness parser.
 */
export function createSource(name: string, options?: SourceOptionsInput): Source {
  if (!Object.hasOwn(adapters, name)) throw new UnknownSourceError(name);
  const factory = adapters[name];
  if (!factory) throw new UnknownSourceError(name);
  assertPathKind(name, options);
  return factory(options);
}

/**
 * Lists supported harness source names.
 *
 * @returns {string[]} Registered source names.
 */
export function sources(): string[] {
  return Object.keys(adapters);
}

/**
 * Creates readers for all supported harnesses at their default locations.
 *
 * @returns {SessionReader[]} Readers in registry order.
 */
export function allSources(): SessionReader[] {
  return Object.values(adapters).map((factory) => createSessionReader(factory()));
}

/**
 * Returns whether a harness source is supported.
 *
 * @param name - Candidate source name.
 * @returns {boolean} Whether the source is registered.
 */
export function has(name: string): boolean {
  return Object.hasOwn(adapters, name);
}
