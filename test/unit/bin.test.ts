import { execFile, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vite-plus/test";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url));
const hook = fileURLToPath(new URL("fixtures/record-loads.mjs", import.meta.url));
const copies: string[] = [];

afterEach(() => {
  for (const copy of copies.splice(0)) rmSync(copy, { recursive: true, force: true });
});

/**
 * Runs `mcp` from a built bin under the load hook with stdin closed, so the server ends as soon as
 * it has started. An inherited SESSIONS_DIST is dropped, so only `environment` sets it.
 * @param bin - Path to a `dist/cli.mjs`.
 * @param environment - Extra environment for the run.
 * @returns {Promise<string[]>} Every module URL the run loaded.
 */
async function mcpLoads(
  bin: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<string[]> {
  const { SESSIONS_DIST: _inherited, ...inherited } = process.env;
  const pending = execute(process.execPath, ["--import", hook, bin, "mcp"], {
    cwd: root,
    env: { ...inherited, ...environment },
    timeout: 10_000,
  });
  pending.child.stdin?.end();
  const { stderr } = await pending;
  const report = /@loaded (\[.*\])/u.exec(stderr)?.[1];
  if (report === undefined) throw new Error(`the load hook reported nothing: ${stderr}`);
  return JSON.parse(report) as string[];
}

/**
 * Whether a run served the tools from the bundle of a directory. The CLI hands `runCli` the list
 * from the `src/tools.ts` chunk, and `dist/mcp.mjs` never loads on that path.
 * @param loaded - Module URLs of the run.
 * @param directory - Root of the checkout or copy.
 * @returns {boolean} Whether a `dist/_chunks/tools*.mjs` chunk loaded.
 */
function loadedBundle(loaded: readonly string[], directory: string): boolean {
  const chunks = pathToFileURL(join(directory, "dist/_chunks/tools")).href;
  return loaded.some((url) => url.startsWith(chunks));
}

/**
 * Copies the named entries of the checkout into a fresh directory.
 * @param parent - Directory to create the copy in.
 * @param entries - Paths relative to the repo root.
 * @returns {string} The copy, removed after the test.
 */
function copyOf(parent: string, entries: readonly string[]): string {
  mkdirSync(parent, { recursive: true });
  const copy = mkdtempSync(join(parent, "sessions-bin-"));
  copies.push(copy);
  for (const entry of entries) cpSync(join(root, entry), join(copy, entry), { recursive: true });
  return copy;
}

const toolNames = ["sessions_sources", "sessions_list", "sessions_read"];

/**
 * Starts `mcp` from the built bin of the checkout and connects a client of one protocol era.
 * @param environment - Extra environment for the server.
 * @param mode - `legacy` for a 2025 `initialize`, or the revision a 2026 client pins.
 * @returns {Promise<Client>} The connected client, which the test closes.
 */
async function connect(
  environment: Readonly<Record<string, string>>,
  mode: "legacy" | Readonly<{ pin: string }>,
): Promise<Client> {
  const { SESSIONS_DIST: _inherited, ...inherited } = process.env;
  const client = new Client(
    { name: "sessions-test", version: "1.0.0" },
    { versionNegotiation: { mode } },
  );
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(root, "dist/cli.mjs"), "mcp"],
      cwd: root,
      env: { ...(inherited as Record<string, string>), ...environment },
      stderr: "ignore",
    }),
  );
  return client;
}

/** Antigravity's opening: a 2026 discover, a bare notification, then a 2026 `tools/list`. */
const antigravityOpening = (() => {
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "raw", version: "0" },
    "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
  };
  return [
    { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } },
    { jsonrpc: "2.0", method: "notifications/roots/list_changed", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: meta } },
  ];
})();

/**
 * Writes raw JSON-RPC lines to `mcp` and waits for the answer to `id` 2.
 * @param environment - Extra environment for the server.
 * @returns {Promise<Record<string, unknown>>} The `result` of that answer.
 */
async function rawToolsList(
  environment: Readonly<Record<string, string>>,
): Promise<Record<string, unknown>> {
  const { SESSIONS_DIST: _inherited, ...inherited } = process.env;
  const child = spawn(process.execPath, [join(root, "dist/cli.mjs"), "mcp"], {
    cwd: root,
    env: { ...inherited, ...environment },
    stdio: ["pipe", "pipe", "ignore"],
  });
  try {
    for (const message of antigravityOpening) child.stdin.write(`${JSON.stringify(message)}\n`);
    for await (const line of createInterface({ input: child.stdout })) {
      const answer = JSON.parse(line) as { id?: unknown; result?: Record<string, unknown> };
      if (answer.id === 2 && answer.result !== undefined) return answer.result;
    }
    throw new Error("mcp closed before answering tools/list");
  } finally {
    child.kill();
  }
}

describe.skipIf(!existsSync(join(root, "dist/cli.mjs")))("built bin", () => {
  const source = pathToFileURL(join(root, "src/")).href;
  const bin = join(root, "dist/cli.mjs");

  it("serves mcp from src/ inside the checkout", async () => {
    const loaded = await mcpLoads(bin);
    expect(loaded).toContain(`${source}mcp.ts`);
    expect(loaded).toContain(`${source}tools.ts`);
    expect(loadedBundle(loaded, root)).toBe(false);
  });

  it("keeps the bundle under SESSIONS_DIST=1", async () => {
    const loaded = await mcpLoads(bin, { SESSIONS_DIST: "1" });
    expect(loaded.filter((url) => url.startsWith(source))).toEqual([]);
    expect(loadedBundle(loaded, root)).toBe(true);
  });

  it("keeps the bundle in a copy under node_modules, where Node strips no types", async () => {
    const copy = copyOf(join(root, "node_modules/.cache"), ["dist", "src", "package.json"]);
    const loaded = await mcpLoads(join(copy, "dist/cli.mjs"));
    expect(loaded.filter((url) => url.startsWith(pathToFileURL(join(copy, "src/")).href))).toEqual(
      [],
    );
    expect(loadedBundle(loaded, copy)).toBe(true);
  });

  it("keeps the bundle when src/ is missing, as in the npm package", async () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      readonly files: readonly string[];
    };
    const copy = copyOf(tmpdir(), [...manifest.files, "package.json"]);
    symlinkSync(join(root, "node_modules"), join(copy, "node_modules"));
    const loaded = await mcpLoads(join(copy, "dist/cli.mjs"));
    expect(loadedBundle(loaded, copy)).toBe(true);
  });

  it("serves src/ in a checkout installed without devDependencies, which it never imports", async () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      readonly dependencies: Readonly<Record<string, string>>;
    };
    const copy = copyOf(tmpdir(), ["dist", "src", "package.json"]);
    for (const name of Object.keys(manifest.dependencies)) {
      mkdirSync(dirname(join(copy, "node_modules", name)), { recursive: true });
      symlinkSync(join(root, "node_modules", name), join(copy, "node_modules", name));
    }
    const loaded = await mcpLoads(join(copy, "dist/cli.mjs"));
    expect(loaded).toContain(pathToFileURL(join(copy, "src/mcp.ts")).href);
    expect(loadedBundle(loaded, copy)).toBe(false);
  });

  it.each([
    { from: "source", env: {} },
    { from: "bundle", env: { SESSIONS_DIST: "1" } },
  ])("lets a client pinned to 2026 list the tools, from the $from", async ({ env }) => {
    const client = await connect(env, { pin: "2026-07-28" });
    try {
      expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
      const subscription = await client.listen({ toolsListChanged: true });
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(toolNames);
      await subscription.close();
    } finally {
      await client.close();
    }
  });

  it.each([
    { from: "source", env: {} },
    { from: "bundle", env: { SESSIONS_DIST: "1" } },
  ])("still opens a 2025 client with initialize, from the $from", async ({ env }) => {
    const client = await connect(env, "legacy");
    try {
      expect(client.getNegotiatedProtocolVersion()).toMatch(/^2025-/u);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(toolNames);
    } finally {
      await client.close();
    }
  });

  it.each([
    { from: "source", env: {} },
    { from: "bundle", env: { SESSIONS_DIST: "1" } },
  ])("keeps Antigravity on 2026 past a bare notification, from the $from", async ({ env }) => {
    const result = await rawToolsList(env);
    expect(result["resultType"]).toBe("complete");
    expect((result["tools"] as readonly { name: string }[]).map((tool) => tool.name)).toEqual(
      toolNames,
    );
  });
});
