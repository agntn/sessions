import type { Source, Storage, Message, IngestResult } from "./types.ts";

export interface IngestCallbacks {
  onSourceStart?: (source: string, estimate?: number) => void;
  onSourceSkip?: (source: string, reason: "unavailable" | "up-to-date") => void;
  onProgress?: (source: string, count: number, estimate?: number) => void;
  onSourceDone?: (source: string, count: number, opts?: { dryRun?: boolean }) => void;
  onSourceError?: (source: string, error: string) => void;
  onMessage?: (message: Message) => void;
}

export interface IngestOptions extends IngestCallbacks {
  only?: string[];
  dryRun?: boolean;
  previewLimit?: number;
}

export const BATCH_SIZE = 1000;

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
      options.onSourceSkip?.(source.name, "unavailable");
      results.push({ source: source.name, count: 0, cursor: "", skipped: true });
      continue;
    }

    const cursor = await storage.getCursor(source.name);
    options.onSourceStart?.(source.name);

    let estimate: number | undefined;
    if (source.estimate) {
      try {
        estimate = await source.estimate(cursor);
        options.onProgress?.(source.name, 0, estimate);
      } catch (err) {
        options.onSourceError?.(source.name, `estimate failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    let count = 0;
    let ingestedCount = 0;
    let resultCursor = cursor;

    let batch: Message[] = [];
    let cursorSeed: Message | null = null;

    try {

      for await (const msg of source.ingest(cursor)) {
        count++;

        if (!cursorSeed || msg.timestamp >= cursorSeed.timestamp) {
          cursorSeed = msg;
        }

        if (options.dryRun) {
          ingestedCount++;
          if (count <= previewLimit) options.onMessage?.(msg);
          continue;
        }

        batch.push(msg);
        if (batch.length >= BATCH_SIZE) {
          await storage.insert(batch);
          ingestedCount += batch.length;
          options.onProgress?.(source.name, ingestedCount, estimate);

          if (cursorSeed) {
            const newCursor = source.cursor(cursorSeed);
            await storage.setCursor(source.name, newCursor);
            resultCursor = newCursor;
          }
          batch = [];
        }
      }

      // Flush remaining
      if (!options.dryRun && batch.length) {
        await storage.insert(batch);
        ingestedCount += batch.length;
      }

      if (!count) {
        options.onSourceSkip?.(source.name, "up-to-date");
        results.push({ source: source.name, count: 0, cursor, skipped: false });
        continue;
      }

      if (!options.dryRun && cursorSeed) {
        const newCursor = source.cursor(cursorSeed);
        await storage.setCursor(source.name, newCursor);
        resultCursor = newCursor;
      }

      options.onSourceDone?.(source.name, ingestedCount, { dryRun: options.dryRun });

      results.push({
        source: source.name,
        count: ingestedCount,
        cursor: options.dryRun ? cursor : resultCursor,
        skipped: false,
      });
    } catch (err) {
      try {
        if (!options.dryRun && batch.length) {
          await storage.insert(batch);
          ingestedCount += batch.length;
        }

        if (!options.dryRun && cursorSeed) {
          const newCursor = source.cursor(cursorSeed);
          await storage.setCursor(source.name, newCursor);
          resultCursor = newCursor;
        }
      } catch (cleanupErr) {
        const cleanupError =
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        options.onSourceError?.(source.name, `recovery failed - ${cleanupError}`);
      }

      const error = err instanceof Error ? err.message : String(err);
      options.onSourceError?.(source.name, error);
      results.push({
        source: source.name,
        count: ingestedCount,
        cursor: resultCursor,
        skipped: false,
        error,
      });
    }
  }

  return results;
}
