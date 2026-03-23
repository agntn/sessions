import { platform } from "node:os";
import { join } from "node:path";
import { home } from "./env.ts";

export function defaultDbPath(): string {
  switch (platform()) {
    case "darwin":
      return join(home(), "Library", "Application Support", "memxa", "memxa.db");
    case "win32":
      return join(
        process.env.APPDATA || join(home(), "AppData", "Roaming"),
        "memxa",
        "memxa.db",
      );
    default:
      return join(
        process.env.XDG_DATA_HOME || join(home(), ".local", "share"),
        "memxa",
        "memxa.db",
      );
  }
}
