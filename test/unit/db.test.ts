import { describe, expect, it, vi } from "vitest";

const { libsql } = vi.hoisted(() => ({ libsql: { loaded: false } }));

vi.mock("@libsql/client", () => {
  libsql.loaded = true;
  return {
    createClient: () => ({
      execute: () => ({ rows: [] }),
      close: () => {},
    }),
  };
});

import { create } from "../../src/index.ts";

describe("libSQL client loading", () => {
  it("stays out of the module graph until a read opens a database", async () => {
    expect(libsql.loaded).toBe(false);

    const mastra = create("mastra");
    mastra.available();
    expect(libsql.loaded).toBe(false);

    await mastra.list();
    expect(libsql.loaded).toBe(true);
  });
});
