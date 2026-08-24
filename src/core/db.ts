import { resolve } from "node:path";
import type { Client } from "@libsql/client";

/** Opens a local libSQL database file. Loads the client on first read, not on import. */
export async function openDatabase(path: string): Promise<Client> {
  const { createClient } = await import("@libsql/client");
  return createClient({ url: `file:${resolve(path)}` });
}
