import { resolve } from "node:path";
import type { Client } from "@libsql/client";

/**
 * Opens a local libSQL database file and loads the client on first read.
 *
 * @param path - Local database path.
 * @returns {Promise<Client>} The connected libSQL client.
 */
export async function openDatabase(path: string): Promise<Client> {
  const { createClient } = await import("@libsql/client");
  return createClient({ url: `file:${resolve(path)}` });
}
