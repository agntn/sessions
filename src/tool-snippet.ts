/** Native opener prefixes that do not identify a conversation. */
export const INJECTED_PREFIXES = [
  "# AGENTS.md instructions",
  "<environment_context>",
  "<user_instructions>",
  "<system-reminder>",
  "<user_info>",
  "<local-command-stdout>",
  "Caveat: The messages below",
] as const;

const SNIPPET_CHARS = 80;

/**
 * Collapses native text into one bounded printable listing cell.
 *
 * @param text - Native message text.
 * @returns {string | undefined} A useful bounded snippet when one exists.
 */
export function snippetLine(text: string): string | undefined {
  const line = text
    .slice(0, 2048)
    .replaceAll(/[\s\p{Cc}]+/gu, " ")
    .trim();
  if (!line || INJECTED_PREFIXES.some((prefix) => line.startsWith(prefix))) return undefined;
  return line.slice(0, SNIPPET_CHARS);
}
