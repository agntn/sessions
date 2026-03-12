import type { Source, Storage, Message, IngestResult } from "./types.ts";

export interface IngestOptions {
  only?: string[];
  verbose?: boolean;
  dryRun?: boolean;
  /** Max messages to show in dry-run preview. */
  previewLimit?: number;
  onMessage?: (message: Message) => void;
  /** Receives verbose status lines (replaces console.error). */
  onLog?: (message: string) => void;
}

const BATCH_SIZE = 1000;

export async function ingest(
  sources: Source[],
  storage: Storage,
  options: IngestOptions = {},
): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  const previewLimit = options.previewLimit ?? 5;

  for (const source of sources) {
    if (options.only?.length && !options.only.includes(source.name)) {
      continue;
    }

    if (!source.available()) {
      if (options.verbose) {
        options.onLog?.(`  ${source.name}: not available, skipping`);
      }
      results.push({ source: source.name, count: 0, cursor: "", skipped: true });
      continue;
    }

    const cursor = await storage.getCursor(source.name);
    let count = 0;
    let batch: Message[] = [];
    const cursorMessages: Message[] = [];

    for await (const msg of source.ingest(cursor)) {
      count++;
      cursorMessages.push(msg);

      if (options.dryRun) {
        if (count <= previewLimit) options.onMessage?.(msg);
        continue;
      }

      batch.push(msg);
      if (batch.length >= BATCH_SIZE) {
        await storage.insert(batch);
        batch = [];
      }
    }

    // Flush remaining
    if (!options.dryRun && batch.length) {
      await storage.insert(batch);
    }

    if (!count) {
      if (options.verbose) options.onLog?.(`  ${source.name}: up to date`);
      results.push({ source: source.name, count: 0, cursor, skipped: false });
      continue;
    }

    let resultCursor = cursor;

    if (options.dryRun) {
      if (count > previewLimit && options.verbose) {
        options.onLog?.(`  ... and ${count - previewLimit} more`);
      }
    } else if (cursorMessages.length) {
      const newCursor = source.cursor(cursorMessages);
      await storage.setCursor(source.name, newCursor);
      resultCursor = newCursor;
    }

    if (options.verbose) {
      const suffix = options.dryRun ? " (dry run)" : " ingested";
      options.onLog?.(`  ${source.name}: ${count} messages${suffix}`);
    }

    results.push({
      source: source.name,
      count,
      cursor: options.dryRun ? cursor : resultCursor,
      skipped: false,
    });
  }

  return results;
}
