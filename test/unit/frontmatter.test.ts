import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "../../src/core/frontmatter.ts";

describe("parseFrontmatter", () => {
  it("parses standard key-value pairs", () => {
    const input = `---
name: test
type: user
---
Body text here`;

    const { meta, body } = parseFrontmatter(input);
    expect(meta).toEqual({ name: "test", type: "user" });
    expect(body).toBe("Body text here");
  });

  it("returns raw content when no frontmatter block", () => {
    const input = "Just plain text";
    const { meta, body } = parseFrontmatter(input);
    expect(meta).toEqual({});
    expect(body).toBe("Just plain text");
  });

  it("handles hyphenated keys", () => {
    const input = `---
created-at: 2026-03-29
last-modified: 2026-03-30
---
Content`;

    const { meta } = parseFrontmatter(input);
    expect(meta["created-at"]).toBe("2026-03-29");
    expect(meta["last-modified"]).toBe("2026-03-30");
  });

  it("strips double-quoted values", () => {
    const input = `---
name: "My Project"
description: "A tool for testing"
---
Body`;

    const { meta } = parseFrontmatter(input);
    expect(meta.name).toBe("My Project");
    expect(meta.description).toBe("A tool for testing");
  });

  it("strips single-quoted values", () => {
    const input = `---
name: 'Single Quoted'
---
Body`;

    const { meta } = parseFrontmatter(input);
    expect(meta.name).toBe("Single Quoted");
  });

  it("preserves unquoted values with special characters", () => {
    const input = `---
path: /home/user/.config/app
url: https://example.com
---
Body`;

    const { meta } = parseFrontmatter(input);
    expect(meta.path).toBe("/home/user/.config/app");
    expect(meta.url).toBe("https://example.com");
  });

  it("skips lines that are not key-value pairs", () => {
    const input = `---
name: valid
  indented: line
- list item
---
Body`;

    const { meta } = parseFrontmatter(input);
    expect(meta).toEqual({ name: "valid" });
  });

  it("handles empty body after frontmatter", () => {
    const input = `---
name: test
---`;

    const { meta, body } = parseFrontmatter(input);
    expect(meta.name).toBe("test");
    expect(body).toBe("");
  });

  it("does not strip mismatched quotes", () => {
    const input = `---
name: "half quoted
---
Body`;

    const { meta } = parseFrontmatter(input);
    expect(meta.name).toBe('"half quoted');
  });
});
