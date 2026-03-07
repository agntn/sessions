export { aei, AeiSource } from './aei.ts'
export { claude, ClaudeSource } from './claude.ts'
export { mastra, MastraSource } from './mastra.ts'
export { opencode, OpenCodeSource } from './opencode.ts'
export { codex, CodexSource } from './codex.ts'
export { gemini, GeminiSource } from './gemini.ts'
export { openclaw, OpenClawSource } from './openclaw.ts'

import { aei } from './aei.ts'
import { claude } from './claude.ts'
import { mastra } from './mastra.ts'
import { opencode } from './opencode.ts'
import { codex } from './codex.ts'
import { gemini } from './gemini.ts'
import { openclaw } from './openclaw.ts'

/** All built-in source factories keyed by name. */
export const builtinSources = { aei, claude, mastra, opencode, codex, gemini, openclaw }
