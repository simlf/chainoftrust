import { describe, expect, it } from "vitest";
import { collect } from "../src/collect/index";
import { cacheKeyFor } from "../src/lib/target";
import type { RegistryRef, RepoMeta } from "../src/types";

/**
 * A statement that states a count has to agree with the names it lists.
 *
 * npm packages routinely carry more publishing accounts than a statement can
 * reasonably print, and the display limit used to drop the remainder in
 * silence: @modelcontextprotocol/sdk rendered "6 npm accounts can publish this
 * package" beside five names. Findings are verifiable facts, and a reader who
 * counts the names is doing the verifying.
 */
const meta: RepoMeta = {
  fullName: "example/pkg",
  description: null,
  isFork: false,
  parentFullName: null,
  parentArchived: null,
  archived: false,
  stars: 10,
  openIssues: 0,
  pushedAt: "2026-01-01T00:00:00Z",
  createdAt: "2020-01-01T00:00:00Z",
  homepage: null,
  license: "MIT",
};

/**
 * Answers only registry.npmjs.org, which is all this check reads. Everything
 * else reads as absent, so the report is the registry findings alone.
 */
function fakeFetcher(maintainers: string[]) {
  const doc = {
    name: "@example/sdk",
    "dist-tags": { latest: "1.30.0" },
    maintainers: maintainers.map((name) => ({ name })),
    versions: {
      "1.30.0": {
        version: "1.30.0",
        dist: { integrity: "sha512-abc", attestations: {} },
        _npmUser: { name: "publisher", email: "p@example.com" },
      },
    },
  };
  return {
    remaining: 30,
    budgetExhausted: false,
    async json<T>(url: string): Promise<T | null> {
      return url.startsWith("https://registry.npmjs.org/") ? (doc as T) : null;
    },
    async text(): Promise<string | null> {
      return null;
    },
  };
}

async function publishRightsStatement(maintainers: string[]): Promise<string> {
  const registry: RegistryRef = {
    kind: "npm",
    packageName: "@example/sdk",
    version: "1.30.0",
  };
  const evidence = await collect(fakeFetcher(maintainers) as never, {
    target: {
      cacheKey: cacheKeyFor("example", "pkg", "abc123", registry),
      host: "github",
      owner: "example",
      name: "pkg",
      requestedRef: "",
      sha: "abc123",
      defaultBranch: "main",
      registry,
    },
    meta,
  });

  const finding = evidence.findings.find((f) => f.concern === "trust-root:publish-rights");
  expect(finding, "the publish-rights finding was produced").toBeDefined();
  return finding!.statement;
}

/** Names as the statement renders them, plus whatever remainder it declares. */
function accountedFor(statement: string): { stated: number; listed: number } {
  const stated = Number(/^(\d+) npm accounts/.exec(statement)?.[1]);
  const list = /: (.+)\.$/.exec(statement)?.[1] ?? "";
  const parts = list.split(", ");
  const more = /^and (\d+) more$/.exec(parts[parts.length - 1] ?? "");
  const named = more ? parts.length - 1 : parts.length;
  return { stated, listed: named + (more ? Number(more[1]) : 0) };
}

describe("who can publish an npm package", () => {
  it("accounts for every maintainer it counted when the list is cut short", async () => {
    const six = [
      "jspahrsummers",
      "pcarleton",
      "fweinberger",
      "thedsp",
      "ashwin-ant",
      "ochafik-ant",
    ];
    const statement = await publishRightsStatement(six);

    expect(statement).toContain("6 npm accounts");
    expect(statement).toContain("and 1 more");
    expect(accountedFor(statement)).toEqual({ stated: 6, listed: 6 });
  });

  it("says nothing about a remainder when every account is named", async () => {
    const statement = await publishRightsStatement(["one", "two", "three"]);

    expect(statement).not.toContain("more");
    expect(accountedFor(statement)).toEqual({ stated: 3, listed: 3 });
  });
});
