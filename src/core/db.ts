import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/**
 * Opens a local SQLite database read-only and loads `node:sqlite` on first read.
 *
 * @param path - Local database path.
 * @returns {Promise<DatabaseSync>} The open database. We only look.
 */
export async function openDatabase(path: string): Promise<DatabaseSync> {
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(resolve(path), { readOnly: true });
}
