import { watch as fsWatch, existsSync } from "node:fs";
import { ingest } from "./ingest.ts";
import type { Source, Storage, IngestResult } from "./types.ts";

export interface WatchCallbacks {
  onReady?: (watchedPaths: Map<string, string[]>) => void;
  onTrigger?: (source: string) => void;
  onIngestDone?: (result: IngestResult) => void;
  onIngestError?: (source: string, error: string) => void;
  onWatchError?: (path: string, error: Error) => void;
  onShutdown?: () => void;
}

export interface WatchOptions extends WatchCallbacks {
  debounceMs?: number;
  only?: string[];
  initial?: boolean;
  signal?: AbortSignal;
}

interface SourceState {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  queued: boolean;
}

export async function watchSources(
  sources: Source[],
  storage: Storage,
  options: WatchOptions = {},
): Promise<void> {
  const debounceMs =
    typeof options.debounceMs === "number" &&
    Number.isFinite(options.debounceMs) &&
    options.debounceMs >= 0
      ? options.debounceMs
      : 2000;

  // Build path → source[] mapping
  const pathSources = new Map<string, Set<string>>();
  const sourcesByName = new Map<string, Source>();
  const pendingIngests = new Set<Promise<void>>();

  for (const source of sources) {
    if (options.only?.length && !options.only.includes(source.name)) continue;
    if (!source.available()) continue;
    if (typeof source.watchPaths !== "function") continue;

    let hasValidPath = false;
    for (const dir of source.watchPaths()) {
      if (!existsSync(dir)) {
        options.onWatchError?.(dir, new Error(`Directory does not exist: ${dir}`));
        continue;
      }
      let set = pathSources.get(dir);
      if (!set) {
        set = new Set();
        pathSources.set(dir, set);
      }
      set.add(source.name);
      hasValidPath = true;
    }

    if (hasValidPath) {
      sourcesByName.set(source.name, source);
    }
  }

  // Per-source state
  const stateMap = new Map<string, SourceState>();
  for (const name of sourcesByName.keys()) {
    stateMap.set(name, { timer: null, running: false, queued: false });
  }

  async function runIngest(sourceName: string): Promise<void> {
    const state = stateMap.get(sourceName)!;
    const source = sourcesByName.get(sourceName)!;
    state.running = true;
    state.queued = false;
    try {
      options.onTrigger?.(sourceName);
      const results = await ingest([source], storage);
      for (const r of results) {
        if (r.error) {
          options.onIngestError?.(sourceName, r.error);
        } else {
          options.onIngestDone?.(r);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      options.onIngestError?.(sourceName, message);
    } finally {
      state.running = false;
      if (state.queued) {
        state.queued = false;
        scheduleIngest(sourceName);
      }
    }
  }

  function scheduleIngest(sourceName: string): void {
    if (options.signal?.aborted) return;
    const state = stateMap.get(sourceName);
    if (!state) return;

    if (state.running) {
      state.queued = true;
      return;
    }

    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      const p = runIngest(sourceName);
      pendingIngests.add(p);
      p.finally(() => pendingIngests.delete(p));
    }, debounceMs);
  }

  // Start watchers
  for (const [dir, sourceNames] of pathSources) {
    try {
      fsWatch(dir, { recursive: true, signal: options.signal }, () => {
        for (const name of sourceNames) {
          scheduleIngest(name);
        }
      }).on("error", (err) => {
        options.onWatchError?.(dir, err);
      });
    } catch (err) {
      options.onWatchError?.(dir, err instanceof Error ? err : new Error(String(err)));
    }
  }

  // Notify ready
  const readableMap = new Map<string, string[]>();
  for (const [dir, names] of pathSources) {
    readableMap.set(dir, [...names]);
  }
  options.onReady?.(readableMap);

  // Initial ingest (skip if already aborted)
  if (options.initial !== false && !options.signal?.aborted) {
    for (const name of sourcesByName.keys()) {
      const p = runIngest(name);
      pendingIngests.add(p);
      p.finally(() => pendingIngests.delete(p));
    }
  }

  // Block until abort
  if (options.signal) {
    const drain = async () => {
      for (const state of stateMap.values()) {
        if (state.timer) clearTimeout(state.timer);
      }
      await Promise.allSettled(pendingIngests);
      options.onShutdown?.();
    };

    if (options.signal.aborted) {
      await drain();
      return;
    }

    await new Promise<void>((resolve) => {
      options.signal!.addEventListener(
        "abort",
        () => {
          drain().then(resolve);
        },
        { once: true },
      );
    });
  } else {
    await new Promise<void>(() => {});
  }
}
