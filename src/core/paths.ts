import { homedir, platform } from "node:os";
import { join } from "node:path";

export function defaultDbPath(): string {
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "memxa", "memxa.db");
    case "win32":
      return join(
        process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
        "memxa",
        "memxa.db",
      );
    default:
      return join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
        "memxa",
        "memxa.db",
      );
  }
}
