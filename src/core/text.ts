/**
 * Quotes caller text for an error line, escaping what JSON leaves raw: C1, separators and bidi.
 *
 * @param {string} value - Caller-controlled text, such as a path or a session id.
 * @returns {string} A JSON string literal that stays on one line and shows every hidden character.
 */
export function quoted(value: string): string {
  return JSON.stringify(value).replaceAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, escapeCodePoint);
}

/**
 * Spells one code point as a `\u` escape, braced past the BMP so the digits stay unambiguous.
 *
 * @param {string} char - One matched code point.
 * @returns {string} Its escape sequence.
 */
function escapeCodePoint(char: string): string {
  const hex = (char.codePointAt(0) ?? 0).toString(16);
  return hex.length > 4 ? `\\u{${hex}}` : `\\u${hex.padStart(4, "0")}`;
}
