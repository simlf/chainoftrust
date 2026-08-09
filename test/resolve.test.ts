import { describe, expect, it } from "vitest";
import { resolveTarget, TargetNotFound } from "../src/collect";
import type { Fetcher } from "../src/lib/fetcher";

/**
 * A stand-in for the network boundary. It answers the two endpoints
 * resolveTarget uses and records every URL, so a test can assert which refs
 * were attempted and in what shape.
 */
function fakeFetcher(routes: Record<string, unknown>) {
  const seen: string[] = [];
  const f = {
    seen,
    remaining: 30,
    budgetExhausted: false,
    async json<T>(url: string): Promise<T | null> {
      seen.push(url);
      this.remaining -= 1;
      return (routes[url] as T | undefined) ?? null;
    },
    async text(): Promise<string | null> {
      return null;
    },
  };
  return f;
}

const REPO = {
  full_name: "o/r",
  description: null,
  fork: false,
  archived: false,
  default_branch: "main",
  stargazers_count: 1,
  open_issues_count: 0,
  pushed_at: "2026-08-01T00:00:00Z",
  created_at: "2020-01-01T00:00:00Z",
  homepage: null,
  license: null,
};

const repoRoute = { "https://api.github.com/repos/o/r": REPO };

describe("pinning a submission to a commit", () => {
  it("keeps a branch name that contains a slash intact in the request", async () => {
    // GitHub's commits endpoint rejects a percent-encoded slash, so a ref such
    // as release/1.x only resolves when the slash stays a path separator.
    const f = fakeFetcher({
      ...repoRoute,
      "https://api.github.com/repos/o/r/commits/release/1.x": { sha: "deadbeef" },
    });

    const resolved = await resolveTarget(f as unknown as Fetcher, {
      kind: "github",
      owner: "o",
      name: "r",
      ref: "release/1.x",
    });

    expect(resolved.target.sha).toBe("deadbeef");
    expect(f.seen).toContain("https://api.github.com/repos/o/r/commits/release/1.x");
    expect(f.seen.join(" ")).not.toContain("%2F");
  });

  it("resolves a pasted subdirectory URL to its branch", async () => {
    // github.com/o/r/tree/main/docs parses to the ref "main/docs", because a
    // tree URL puts the branch and the path in the same place. That is a valid
    // URL and must not surface an error.
    const f = fakeFetcher({
      ...repoRoute,
      "https://api.github.com/repos/o/r/commits/main": { sha: "cafe1234" },
    });

    const resolved = await resolveTarget(f as unknown as Fetcher, {
      kind: "github",
      owner: "o",
      name: "r",
      ref: "main/docs",
    });

    expect(resolved.target.sha).toBe("cafe1234");
    expect(resolved.target.requestedRef).toBe("main");
  });

  it("still refuses a ref that resolves at no depth", async () => {
    const f = fakeFetcher(repoRoute);
    await expect(
      resolveTarget(f as unknown as Fetcher, {
        kind: "github",
        owner: "o",
        name: "r",
        ref: "no-such-branch",
      }),
    ).rejects.toBeInstanceOf(TargetNotFound);
  });

  it("bounds how many refs a deep path can cost", async () => {
    const f = fakeFetcher(repoRoute);
    await expect(
      resolveTarget(f as unknown as Fetcher, {
        kind: "github",
        owner: "o",
        name: "r",
        ref: "a/b/c/d/e/f/g/h",
      }),
    ).rejects.toBeInstanceOf(TargetNotFound);

    const commitCalls = f.seen.filter((u) => u.includes("/commits/"));
    expect(commitCalls.length).toBeLessThanOrEqual(5);
  });
});

describe("cache identity of a registry submission", () => {
  it("differs from the same commit submitted as a bare repository", async () => {
    const routes = {
      ...repoRoute,
      "https://api.github.com/repos/o/r/commits/main": { sha: "abc123" },
      "https://pypi.org/pypi/uv/json": {
        info: {
          name: "uv",
          version: "0.9.0",
          project_urls: { Source: "https://github.com/o/r" },
        },
        urls: [{ provenance: null }],
      },
    };

    const viaPypi = await resolveTarget(fakeFetcher(routes) as unknown as Fetcher, {
      kind: "pypi",
      owner: "",
      name: "uv",
      ref: "",
    });
    const viaRepo = await resolveTarget(fakeFetcher(routes) as unknown as Fetcher, {
      kind: "github",
      owner: "o",
      name: "r",
      ref: "",
    });

    expect(viaPypi.target.sha).toBe(viaRepo.target.sha);
    expect(viaPypi.target.cacheKey).not.toBe(viaRepo.target.cacheKey);
    expect(viaPypi.target.registry).toEqual({
      kind: "pypi",
      packageName: "uv",
      version: "0.9.0",
    });
  });
});
