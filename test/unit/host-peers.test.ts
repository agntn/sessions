import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import manifest from "../../package.json" with { type: "json" };

const root = fileURLToPath(new URL("../..", import.meta.url));

/** Packages Pi supplies to extensions, per `HOST_PROVIDED_EXTENSION_PACKAGES` in Pi 0.99. */
const hostProvidedPackages = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "@mariozechner/pi-agent-core",
  "@mariozechner/pi-ai",
  "@mariozechner/pi-coding-agent",
  "@mariozechner/pi-tui",
  "@sinclair/typebox",
  "typebox",
];

/** A static, bare or dynamic import of `typebox` or one of its subpaths. */
const typeboxImport = /\b(?:from|import)\s*\(?\s*["']typebox(?:\/[^"']*)?["']/u;

describe("packages the host supplies", () => {
  it("stay out of dependencies, so Pi loads the package without a warning", () => {
    expect(
      Object.keys(manifest.dependencies).filter((name) => hostProvidedPackages.includes(name)),
    ).toEqual([]);
  });

  it("leave typebox an optional peer with the range Pi asks for", () => {
    expect(manifest.peerDependencies.typebox).toBe("*");
    expect(manifest.peerDependenciesMeta.typebox).toEqual({ optional: true });
  });

  it.skipIf(!existsSync(join(root, "dist")))("leave dist carrying its own typebox", () => {
    const files = readdirSync(join(root, "dist"), { recursive: true, encoding: "utf8" }).filter(
      (file) => file.endsWith(".mjs"),
    );
    expect(files.length).toBeGreaterThan(0);
    expect(
      files.filter((file) => typeboxImport.test(readFileSync(join(root, "dist", file), "utf8"))),
    ).toEqual([]);
  });
});
