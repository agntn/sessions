import { describe, expect, it, vi } from "vite-plus/test";

const { sqlite } = vi.hoisted(() => ({ sqlite: { loaded: false } }));

vi.mock("node:sqlite", () => {
  sqlite.loaded = true;
  return {
    DatabaseSync: class {
      prepare() {
        return { all: () => [] };
      }

      close() {}
    },
  };
});

import { create } from "../../src/index.ts";

describe("SQLite loading", () => {
  it("stays out of the module graph until a read opens a database", async () => {
    expect(sqlite.loaded).toBe(false);

    const mastra = create("mastra");
    mastra.available();
    expect(sqlite.loaded).toBe(false);

    await mastra.list();
    expect(sqlite.loaded).toBe(true);
  });
});
