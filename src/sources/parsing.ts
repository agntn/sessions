import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/**
 * Parses untrusted JSON without leaking `any` into adapter code.
 *
 * @param text - Serialized JSON.
 * @returns {unknown} The parsed value, still requiring structural narrowing.
 */
export function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/**
 * Returns whether an untrusted value is a non-null object record.
 *
 * @param value - Value to inspect.
 * @returns {boolean} Whether the value can be read as an object record.
 */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Converts a scalar native value to text without object default stringification.
 *
 * @param value - Untrusted native value.
 * @returns {string | undefined} Scalar text, or `undefined` for objects and nullish values.
 */
export function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

/**
 * Parses one untrusted JSON object while treating malformed or scalar input as absent.
 *
 * @param text - Serialized JSON.
 * @returns {Readonly<Record<string, unknown>> | undefined} The parsed record when valid.
 */
export function parseJsonRecord(text: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed = parseJson(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Streams JSONL split on `\n` alone, since readline also cuts at the U+2028 JSON leaves raw.
 *
 * @param path - JSONL file to read.
 * @param highWaterMark - Smaller reads for a caller that may stop after the header.
 * @yields {string} Each line without its `\n`; an empty last line is skipped.
 */
export async function* jsonlLines(path: string, highWaterMark?: number): AsyncGenerator<string> {
  const input = createReadStream(path, highWaterMark === undefined ? {} : { highWaterMark });
  const decoder = new StringDecoder("utf8");
  let pending = "";
  try {
    for await (const chunk of input as AsyncIterable<Buffer>) {
      const parts = decoder.write(chunk).split("\n");
      const tail = parts.pop() ?? "";
      for (const part of parts) {
        yield pending + part;
        pending = "";
      }
      pending += tail;
    }
    const last = pending + decoder.end();
    if (last) yield last;
  } finally {
    input.destroy();
  }
}
