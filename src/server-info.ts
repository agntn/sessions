/** Who the server says it is. `sessions --help` and MCP read the same card. */
import { version } from "./version.ts";

export const serverInfo = {
  name: "sessions",
  version,
  description: "Read normalized AI coding sessions across harnesses",
} as const;
