import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineTool, sanitizeText } from "@agntn/tools";
import { registerOmpTools, type OmpRenderers } from "@agntn/tools/omp";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type * as SessionsTools from "../../src/tools.ts";

/** Lines of an answer a collapsed row shows before it counts the rest. */
const COLLAPSED_LINES = 10;

const sourceModulePath = fileURLToPath(new URL("../../src/tools.ts", import.meta.url));

/**
 * Source in a checkout, the bundle in the package. Both specifiers stay literal, since OMP
 * rewrites bare imports like `@libsql/client` only in modules it can see.
 *
 * @returns {Promise<typeof SessionsTools>} The tool definitions.
 */
function loadTools(): Promise<typeof SessionsTools> {
  return (
    existsSync(sourceModulePath) ? import("../../src/tools.ts") : import("@agntn/sessions/tools")
  ) as Promise<typeof SessionsTools>;
}

interface PlaceholderSourceParams {
  readonly source?: string;
  readonly path?: string;
  readonly paths?: readonly string[];
  readonly since?: string;
  readonly until?: string;
}

interface PlaceholderListParams extends PlaceholderSourceParams {
  readonly sources?: readonly string[];
  readonly lastHours?: number;
}

interface PlaceholderReadParams extends PlaceholderSourceParams {
  readonly source: string;
  readonly offset?: number;
  readonly position?: Readonly<{ message: number; block: number; character: number }>;
}

/**
 * OMP drops `""` only where the schema sets `minLength`, so `path: ""` and `" "` still get here.
 *
 * @param {string | undefined} value - Field as OMP passed it on.
 * @returns {string | undefined} The value, or undefined when it's blank.
 */
function text(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

/**
 * `paths` has no `minItems`, so OMP passes `[]` on as it came.
 *
 * @param {readonly string[] | undefined} value - List as OMP passed it on.
 * @returns {readonly string[] | undefined} The list, or undefined when it's empty.
 */
function list(value: readonly string[] | undefined): readonly string[] | undefined {
  return value?.length ? value : undefined;
}

/**
 * Keeps one of `source` and `sources` when `sources` holds `source`. Other pairs stay a conflict.
 *
 * @param params - List parameters without placeholders.
 * @returns {Pick<PlaceholderListParams, "source" | "sources">} The harness selection to pass on.
 */
function harnesses(
  params: Readonly<PlaceholderListParams>,
): Pick<PlaceholderListParams, "source" | "sources"> {
  const { source, sources } = params;
  if (source === undefined || sources?.includes(source) !== true) return { source, sources };
  const single = sources.length === 1 || params.path !== undefined || params.paths !== undefined;
  return single ? { source, sources: undefined } : { source: undefined, sources };
}

/**
 * Unsets OMP's list placeholders. A filler `lastHours` yields to a real `since` or `until`.
 *
 * @param params - Parameters as OMP passed them on.
 * @returns {T} The same parameters with each placeholder unset.
 */
function listParams<T extends Readonly<PlaceholderListParams>>(params: T): T {
  const since = text(params.since);
  const until = text(params.until);
  const set = { source: text(params.source), path: text(params.path), paths: list(params.paths) };
  return {
    ...params,
    ...set,
    ...harnesses({ ...set, sources: params.sources }),
    since,
    until,
    lastHours: since !== undefined || until !== undefined ? undefined : params.lastHours,
  };
}

/**
 * A zero `offset` or `position` beside the other one is only OMP's default, so it goes.
 *
 * @param params - Parameters as OMP passed them on.
 * @returns {T} The same parameters with each placeholder unset.
 */
function readParams<T extends Readonly<PlaceholderReadParams>>(params: T): T {
  const { offset, position } = params;
  const origin =
    position !== undefined &&
    position.message === 0 &&
    position.block === 0 &&
    position.character === 0;
  return {
    ...params,
    path: text(params.path),
    paths: list(params.paths),
    since: text(params.since),
    until: text(params.until),
    ...(position !== undefined && offset === 0 ? { offset: undefined } : {}),
    ...(origin && offset !== undefined && offset !== 0 ? { position: undefined } : {}),
  };
}

type Args = Readonly<Record<string, unknown>>;

/** The part of a result the row draws. */
type Answer = Readonly<{ content: readonly unknown[] }>;

/**
 * The answer as the row shows it: the adapter's own result line is only a status and a badge.
 * Transcripts carry terminal output, so escapes go before the text reaches the screen.
 *
 * @param result - What the tool returned.
 * @param expanded - Whether the host shows the whole row.
 * @returns {string} Every line, or the first few and how many wait behind them.
 */
function answerLines(result: Answer, expanded: boolean): string {
  const lines = result.content.flatMap((part) => {
    const { text } = part as { text?: unknown };
    return typeof text === "string" ? sanitizeText(text).split("\n") : [];
  });
  if (expanded || lines.length <= COLLAPSED_LINES) return lines.join("\n");
  const hidden = lines.length - COLLAPSED_LINES;
  return [...lines.slice(0, COLLAPSED_LINES), `... ${hidden} more lines, expand to see them`].join(
    "\n",
  );
}

/**
 * The harnesses a listing asked for, as the call line names them.
 *
 * @param args - Raw arguments from the model.
 * @returns {string} One source, the joined list or `all`.
 */
function harnessLabel(args: Args): string {
  const { source, sources } = args;
  if (typeof source === "string") return source;
  return Array.isArray(sources) ? sources.map(String).join(", ") : "all";
}

const describeCall: Record<string, (args: Args) => string> = {
  sessions_sources: () => "all",
  sessions_list: harnessLabel,
  sessions_read: (args) => `${harnessLabel(args)}:${String(args["sessionId"])}`,
};

/**
 * Register the session tools with the OMP host; the executors load on the first call.
 *
 * @param pi - The OMP extension API.
 */
export default async function sessionsExtension(pi: ExtensionAPI): Promise<void> {
  pi.setLabel("Sessions");
  const { sessionsTools } = await loadTools();
  const [sources, list, read] = sessionsTools;
  const tools = [
    sources,
    defineTool({
      ...list,
      execute: (params, context) => list.execute(listParams(params), context),
    }),
    defineTool({
      ...read,
      execute: (params, context) => read.execute(readParams(params), context),
    }),
  ];
  const { Text } = pi.pi;
  const renderers = Object.fromEntries(
    Object.entries(describeCall).map(([name, describe]): [string, OmpRenderers] => [
      name,
      {
        describeCall: describe,
        renderResult(result, { expanded, isPartial }, theme) {
          if (isPartial) return new Text(theme.fg("muted", "Reading sessions…"), 0, 0);
          return new Text(answerLines(result, expanded), 0, 0);
        },
      },
    ]),
  );
  registerOmpTools(pi, tools, { Text, renderers });
}
