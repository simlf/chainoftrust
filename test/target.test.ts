import { describe, expect, it } from "vitest";
import { InvalidTarget, cacheKeyFor, parseTarget } from "../src/lib/target";

describe("target parsing", () => {
  it("accepts the shapes a person actually pastes", () => {
    const cases: [string, { kind: string; owner: string; name: string; ref: string }][] = [
      ["https://github.com/astral-sh/uv", { kind: "github", owner: "astral-sh", name: "uv", ref: "" }],
      ["https://github.com/astral-sh/uv/", { kind: "github", owner: "astral-sh", name: "uv", ref: "" }],
      ["github.com/astral-sh/uv", { kind: "github", owner: "astral-sh", name: "uv", ref: "" }],
      ["astral-sh/uv", { kind: "github", owner: "astral-sh", name: "uv", ref: "" }],
      ["git@github.com:astral-sh/uv.git", { kind: "github", owner: "astral-sh", name: "uv", ref: "" }],
      ["https://github.com/astral-sh/uv.git", { kind: "github", owner: "astral-sh", name: "uv", ref: "" }],
      ["  https://github.com/astral-sh/uv  ", { kind: "github", owner: "astral-sh", name: "uv", ref: "" }],
    ];
    for (const [input, expected] of cases) {
      expect(parseTarget(input), input).toMatchObject(expected);
    }
  });

  it("pins to a ref when the URL carries one", () => {
    expect(parseTarget("https://github.com/ollama/ollama/tree/v0.32.6")).toMatchObject({
      ref: "v0.32.6",
    });
    expect(parseTarget("https://github.com/ollama/ollama/commit/abc123")).toMatchObject({
      ref: "abc123",
    });
    expect(parseTarget("https://github.com/o/r/tree/release/1.x")).toMatchObject({
      ref: "release/1.x",
    });
  });

  it("accepts registry packages, scoped and unscoped", () => {
    expect(parseTarget("npm:@playwright/mcp")).toMatchObject({
      kind: "npm",
      name: "@playwright/mcp",
    });
    expect(parseTarget("https://www.npmjs.com/package/@playwright/mcp")).toMatchObject({
      kind: "npm",
      name: "@playwright/mcp",
    });
    expect(parseTarget("https://pypi.org/project/aider-chat/")).toMatchObject({
      kind: "pypi",
      name: "aider-chat",
    });
    expect(parseTarget("pypi:aider-chat")).toMatchObject({ kind: "pypi", name: "aider-chat" });
  });

  it("refuses anything it cannot vouch for", () => {
    const bad = [
      "",
      "   ",
      "not a url",
      "https://gitlab.com/owner/repo",
      "https://github.com/onlyowner",
      "https://evil.test/github.com/owner/repo",
      "file:///etc/passwd",
      `https://github.com/${"a".repeat(500)}/repo`,
      // Resolves to /owner/, which is one segment short of a repository.
      "https://github.com/owner/repo/tree/../../..",
    ];
    for (const input of bad) {
      expect(() => parseTarget(input), JSON.stringify(input)).toThrow(InvalidTarget);
    }
  });

  it("lets no traversal survive into the values used to build URLs", () => {
    // These values are interpolated into api.github.com paths, so a `..` must
    // never reach them. The URL parser resolves traversal before we see it, so
    // each input either normalises to an ordinary owner/repo pair or loses a
    // segment and is refused. Both outcomes are fine; a surviving `..` is not.
    for (const input of [
      "https://github.com/../../etc/passwd",
      "https://github.com/owner/../../repo",
      "https://github.com/owner/repo/tree/../../..",
      "https://github.com/./owner/./repo",
    ]) {
      let parsed;
      try {
        parsed = parseTarget(input);
      } catch (err) {
        expect(err, input).toBeInstanceOf(InvalidTarget);
        continue;
      }
      expect(parsed.owner, input).toMatch(/^[A-Za-z0-9][A-Za-z0-9-]*$/);
      expect(parsed.name, input).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(`${parsed.owner}/${parsed.name}/${parsed.ref}`, input).not.toContain("..");
    }
  });

  it("refuses an owner that would smuggle a path segment", () => {
    expect(() => parseTarget("own%2Fer/repo")).toThrow(InvalidTarget);
    expect(() => parseTarget("npm:../../etc/passwd")).toThrow(InvalidTarget);
  });
});

describe("cache identity", () => {
  it("is the commit sha, case-folded on the repository", () => {
    expect(cacheKeyFor("Astral-SH", "UV", "abc")).toBe("github:astral-sh/uv@abc");
  });

  it("separates two commits of the same repository", () => {
    expect(cacheKeyFor("o", "r", "aaa")).not.toBe(cacheKeyFor("o", "r", "bbb"));
  });
});
