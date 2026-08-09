import { describe, expect, it } from "vitest";
import {
  InvalidTarget,
  cacheKeyFor,
  isSafeRef,
  parseTarget,
  registryQualifier,
} from "../src/lib/target";

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

  it("refuses a ref that would walk the API path", () => {
    // A ref keeps its slashes as path separators, because GitHub rejects an
    // encoded one, so a dot segment inside it would select a different endpoint
    // on the allowlisted host once the URL parser normalises the path.
    const bad = [
      "https://github.com/o/r/tree/..%2f..%2f..%2f..%2fuser",
      "https://github.com/o/r/tree/main%2f..%2f..%2frate_limit",
      "https://github.com/o/r/tree/.%2fmain",
      "https://github.com/o/r/tree/main%2f%2fdocs",
      "https://github.com/o/r/tree/main%2f",
    ];
    for (const input of bad) {
      expect(() => parseTarget(input), input).toThrow(InvalidTarget);
    }
  });

  it("judges a ref by whether it can change the API path shape", () => {
    for (const ref of ["main", "release/1.x", "v0.32.6", "abc123", ""]) {
      expect(isSafeRef(ref), ref).toBe(true);
    }
    for (const ref of ["..", ".", "../../user", "main/../rate_limit", "main//docs", "/main", "main/"]) {
      expect(isSafeRef(ref), ref).toBe(false);
    }
  });

  it("still accepts a branch name that legitimately contains a slash", () => {
    expect(parseTarget("https://github.com/o/r/tree/release/1.x")).toMatchObject({
      ref: "release/1.x",
    });
    expect(parseTarget("https://github.com/o/r/tree/main/docs")).toMatchObject({
      ref: "main/docs",
    });
  });

  it("refuses a malformed percent escape rather than failing on it", () => {
    // decodeURIComponent throws on a bad escape. What a visitor pasted must not
    // be able to choose the response code, so this is an invalid target and not
    // a fault on our side.
    for (const bad of [
      "https://github.com/o/%E0%A4%A",
      "https://github.com/%/repo",
      "https://pypi.org/project/%ZZ",
    ]) {
      expect(() => parseTarget(bad), bad).toThrow(InvalidTarget);
    }
  });

  it("refuses a dot segment that a URL parser would resolve away", () => {
    // repos/owner/.. normalises to a different endpoint on the same host.
    for (const bad of [
      "https://github.com/owner/..",
      "https://github.com/owner/.",
      "owner/..",
    ]) {
      expect(() => parseTarget(bad), bad).toThrow(InvalidTarget);
    }
  });
});

describe("cache identity", () => {
  it("is the commit sha, case-folded on the repository", () => {
    expect(cacheKeyFor("Astral-SH", "UV", "abc")).toBe("github:astral-sh/uv@abc");
  });

  it("separates two commits of the same repository", () => {
    expect(cacheKeyFor("o", "r", "aaa")).not.toBe(cacheKeyFor("o", "r", "bbb"));
  });

  it("separates a registry submission from the repository at the same commit", () => {
    // A package submission runs the registry-provenance check and a bare
    // repository submission does not. Sharing a row serves the report without
    // that check to someone who asked for it, with nothing saying it was
    // skipped.
    const repo = cacheKeyFor("astral-sh", "uv", "abc");
    const pypi = cacheKeyFor("astral-sh", "uv", "abc", { kind: "pypi", packageName: "uv" });
    const npm = cacheKeyFor("astral-sh", "uv", "abc", { kind: "npm", packageName: "uv" });

    expect(new Set([repo, pypi, npm]).size).toBe(3);
    expect(pypi.startsWith(repo)).toBe(true);
  });

  it("case-folds the package name so one package is one row", () => {
    expect(cacheKeyFor("o", "r", "s", { kind: "npm", packageName: "UV" })).toBe(
      cacheKeyFor("o", "r", "s", { kind: "npm", packageName: "uv" }),
    );
  });

  it("separates two published versions that resolve to the same commit", () => {
    // A registry submission is pinned to the default-branch commit, not to the
    // version's tag, so a republish would otherwise be answered with the
    // previous release's provenance under the new version's name.
    const first = cacheKeyFor("o", "r", "abc", {
      kind: "npm",
      packageName: "uv",
      version: "1.0.0",
    });
    const second = cacheKeyFor("o", "r", "abc", {
      kind: "npm",
      packageName: "uv",
      version: "1.0.1",
    });
    expect(first).not.toBe(second);
  });
});

describe("registry qualifier carried in a verdict URL", () => {
  it("round-trips the kind and the package name", () => {
    expect(registryQualifier("npm:@playwright/mcp")).toEqual({
      kind: "npm",
      packageName: "@playwright/mcp",
    });
    expect(registryQualifier("pypi:aider-chat")).toEqual({
      kind: "pypi",
      packageName: "aider-chat",
    });
  });

  it("reads the version off a scoped and an unscoped name", () => {
    expect(registryQualifier("npm:@playwright/mcp@0.0.41")).toEqual({
      kind: "npm",
      packageName: "@playwright/mcp",
      version: "0.0.41",
    });
    expect(registryQualifier("pypi:aider-chat@0.86.1")).toEqual({
      kind: "pypi",
      packageName: "aider-chat",
      version: "0.86.1",
    });
  });

  it("builds the same cache key the analysis filed the report under", () => {
    const parsed = registryQualifier("npm:@playwright/mcp@0.0.41")!;
    expect(cacheKeyFor("microsoft", "playwright-mcp", "sha", parsed)).toBe(
      cacheKeyFor("microsoft", "playwright-mcp", "sha", {
        kind: "npm",
        packageName: "@playwright/mcp",
        version: "0.0.41",
      }),
    );
  });

  it("refuses anything that is not a package name", () => {
    for (const bad of ["", "npm:", "gem:rails", "npm:../../etc/passwd", "uv"]) {
      expect(registryQualifier(bad), bad).toBeNull();
    }
  });
});
