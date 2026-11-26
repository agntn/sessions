/** Vercel AI SDK tools over the same definitions MCP, Pi, OMP and the CLI read. */

import { toAiTools, type AiTools } from "@agntn/tools/ai";
import { sessionsTools } from "./tools.ts";

/** Every sessions tool under its MCP name. All three only read, so none waits for approval. */
export const sessionsAiTools: AiTools<typeof sessionsTools> = toAiTools(sessionsTools);
