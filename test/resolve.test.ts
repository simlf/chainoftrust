import { describe, expect, it } from "vitest";
import { collect, resolveTarget, TargetNotFound } from "../src/collect";
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

  it("never sends a ref that would walk the API path", async () => {
    const f = fakeFetcher(repoRoute);

    await expect(
      resolveTarget(f as unknown as Fetcher, {
        kind: "github",
        owner: "o",
        name: "r",
        ref: "../../../../user",
      }),
    ).rejects.toBeInstanceOf(TargetNotFound);

    expect(f.seen.filter((u) => u.includes("/commits/"))).toEqual([]);
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

describe("a repository named by registry metadata", () => {
  const pypiDoc = (repository: string) => ({
    "https://pypi.org/pypi/evil/json": {
      info: { name: "evil", version: "1.0.0", project_urls: { Source: repository } },
      urls: [],
    },
  });

  it("refuses an owner that would walk out of the repos path", async () => {
    // github.com/../user resolves to owner "..", and api.github.com/repos/../user
    // normalises to a different endpoint on the same allowlisted host, reached
    // with the GitHub token attached.
    const f = fakeFetcher(pypiDoc("https://github.com/../user"));

    await expect(
      resolveTarget(f as unknown as Fetcher, {
        kind: "pypi",
        owner: "",
        name: "evil",
        ref: "",
      }),
    ).rejects.toBeInstanceOf(TargetNotFound);

    expect(f.seen.filter((u) => u.startsWith("https://api.github.com"))).toEqual([]);
  });

  it("refuses a repository name that is only dot segments", async () => {
    const f = fakeFetcher(pypiDoc("https://github.com/owner/.."));

    await expect(
      resolveTarget(f as unknown as Fetcher, {
        kind: "pypi",
        owner: "",
        name: "evil",
        ref: "",
      }),
    ).rejects.toBeInstanceOf(TargetNotFound);

    expect(f.seen.filter((u) => u.startsWith("https://api.github.com"))).toEqual([]);
  });

  it("refuses an owner carrying characters GitHub does not allow", async () => {
    for (const repository of [
      "https://github.com/own er/repo",
      "https://github.com/-/repo",
      "https://github.com/own%2Fer/repo",
    ]) {
      const f = fakeFetcher(pypiDoc(repository));
      await expect(
        resolveTarget(f as unknown as Fetcher, {
          kind: "pypi",
          owner: "",
          name: "evil",
          ref: "",
        }),
        repository,
      ).rejects.toBeInstanceOf(TargetNotFound);
    }
  });

  it("does not let a registry value choose how long the refusal is", async () => {
    // project_urls is publisher-controlled text up to the per-file byte cap, and
    // the refusal it produces is rendered on the home page.
    const f = fakeFetcher(
      pypiDoc(`https://github.com/own er/${"a".repeat(4000)}\nSecond line of prose.`),
    );

    let error = new Error("resolveTarget did not refuse");
    try {
      await resolveTarget(f as unknown as Fetcher, {
        kind: "pypi",
        owner: "",
        name: "evil",
        ref: "",
      });
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeInstanceOf(TargetNotFound);
    expect(error.message.length).toBeLessThan(256);
    expect(error.message).not.toContain("\n");
    expect(error.message).not.toContain("Second line of prose");
  });

  it("accepts an ordinary repository field", async () => {
    const f = fakeFetcher({
      ...pypiDoc("https://github.com/o/r"),
      ...repoRoute,
      "https://api.github.com/repos/o/r/commits/main": { sha: "abc123" },
    });

    const resolved = await resolveTarget(f as unknown as Fetcher, {
      kind: "pypi",
      owner: "",
      name: "evil",
      ref: "",
    });
    expect(resolved.target).toMatchObject({ owner: "o", name: "r", sha: "abc123" });
  });
});

describe("what a registry submission costs upstream", () => {
  it("reads the registry entry once across resolution and collection", async () => {
    // Resolution reads the entry to learn the repository and the provenance
    // check reads the same entry for the same package. The fetch budget and the
    // submission counter are both sized against real upstream requests.
    const npmUrl = "https://registry.npmjs.org/@example%2Fsdk";
    const f = fakeFetcher({
      ...repoRoute,
      "https://api.github.com/repos/o/r/commits/main": { sha: "abc123" },
      [npmUrl]: {
        name: "@example/sdk",
        "dist-tags": { latest: "1.0.0" },
        maintainers: [{ name: "one" }],
        repository: { url: "https://github.com/o/r.git" },
        versions: {
          "1.0.0": {
            version: "1.0.0",
            dist: { integrity: "sha512-abc", attestations: {} },
            _npmUser: { name: "publisher", email: "p@example.com" },
          },
        },
      },
    });

    const resolved = await resolveTarget(f as unknown as Fetcher, {
      kind: "npm",
      owner: "",
      name: "@example/sdk",
      ref: "",
    });
    const evidence = await collect(f as unknown as Fetcher, resolved);

    expect(f.seen.filter((u) => u === npmUrl)).toHaveLength(1);
    expect(
      evidence.findings.some((x) => x.concern === "registry-provenance:attestation"),
      "the provenance check still ran",
    ).toBe(true);
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
