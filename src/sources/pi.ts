import { OmpSource } from "./omp.ts";

/** Reads native Pi session JSONL with the parser shared by OMP. */
export class PiSource extends OmpSource {
  constructor(sessionsDir?: string) {
    super(sessionsDir, "pi");
  }
}
