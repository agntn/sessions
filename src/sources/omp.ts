import { join } from "node:path";
import { home } from "../core/env.ts";
import { PiSource } from "./pi.ts";

/** Reads OMP session JSONL using Pi's native session format. */
export class OmpSource extends PiSource {
  override readonly name = "omp" as const;

  constructor(sessionsDir?: string) {
    super(sessionsDir ?? join(home(), ".omp/agent/sessions"));
  }
}
