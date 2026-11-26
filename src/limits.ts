/** Bounds the tool schemas and the executors share, in a module that imports nothing. */

export const DEFAULT_SESSION_LIMIT = 20;
export const MAX_SESSION_LIMIT = 100;
export const DEFAULT_MESSAGE_LIMIT = 100;
export const MAX_MESSAGE_LIMIT = 500;
export const DEFAULT_OUTPUT_CHARS = 20_000;
export const MIN_OUTPUT_CHARS = 1_000;
export const MAX_OUTPUT_CHARS = 100_000;
/** One name per harness. */
export const MAX_SOURCES = 12;
/** Digests a read can swap for references. */
export const MAX_KNOWN_TOOL_RESULTS = 100;
