import { describe, expect, it } from "vitest";
import { cacheKeyFor, registryQualifier } from "../src/lib/target";
import type { Report } from "../src/types";
import { verdictJsonPath, verdictPath } from "../src/ui/pages";

const report = (registry?: Report["target"]["registry"]): Report => ({
  target: {
    cacheKey: "k",
    host: "github",
    owner: "astral-sh",
    name: "uv",
    requestedRef: "",
    sha: "abc123",
    defaultBranch: "main",
    ...(registry ? { registry } : {}),
  },
  verdict: "warnings",
  findings: [],
  notChecked: [],
  proseExcerpts: [],
  stats: {
    filesInTree: 1,
    totalBytes: 1,
    opaqueBytes: 0,
    filesFetched: 1,
    fetchBudgetExhausted: false,
  },
  generatedAt: "2026-08-10T00:00:00.000Z",
});

describe("a report's own address", () => {
  it("keeps the /r/github/:owner/:name/:sha shape", () => {
    expect(verdictPath(report())).toBe("/r/github/astral-sh/uv/abc123");
  });

  it("carries the registry qualifier back to the cache key it came from", () => {
    const registry = { kind: "pypi" as const, packageName: "uv", version: "0.9.0" };
    const url = new URL(`https://chainoftrust.dev${verdictPath(report(registry))}`);

    expect(url.pathname).toBe("/r/github/astral-sh/uv/abc123");

    const qualifier = registryQualifier(url.searchParams.get("pkg") ?? "");
    expect(qualifier).toEqual({ kind: "pypi", packageName: "uv", version: "0.9.0" });
    expect(cacheKeyFor("astral-sh", "uv", "abc123", qualifier!)).toBe(
      cacheKeyFor("astral-sh", "uv", "abc123", registry),
    );
  });

  it("appends the JSON format parameter to either shape", () => {
    expect(verdictJsonPath(report())).toContain("?format=json");
    const withPkg = verdictJsonPath(
      report({ kind: "npm", packageName: "@playwright/mcp", version: "1.0.0" }),
    );
    const params = new URL(`https://chainoftrust.dev${withPkg}`).searchParams;
    expect(params.get("format")).toBe("json");
    expect(params.get("pkg")).toBe("npm:@playwright/mcp@1.0.0");
  });
});
