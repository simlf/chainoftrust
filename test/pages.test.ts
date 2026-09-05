import { describe, expect, it } from "vitest";
import type { Finding, Report, StoredVerdict } from "../src/types";
import { homePage, verdictPage } from "../src/ui/pages";
import { scoreVerdict } from "../src/verdict/score";

function report(findings: Finding[]): Report {
  return {
    target: {
      cacheKey: "github:owner/repo@abc1234",
      host: "github",
      owner: "owner",
      name: "repo",
      requestedRef: "",
      sha: "abc1234abc1234abc1234abc1234abc1234abc12",
      defaultBranch: "main",
    },
    verdict: scoreVerdict(findings),
    findings,
    notChecked: ["The compiled binaries in the release."],
    proseExcerpts: [],
    stats: {
      filesInTree: 10,
      totalBytes: 1000,
      opaqueBytes: 0,
      filesFetched: 3,
      fetchBudgetExhausted: false,
    },
    generatedAt: "2026-09-05T00:00:00.000Z",
  };
}

function stored(findings: Finding[]): StoredVerdict {
  return {
    report: report(findings),
    writeup: null,
    writeupModel: null,
    cached: false,
    createdAt: 0,
  };
}

async function html(findings: Finding[]): Promise<string> {
  return await verdictPage(stored(findings), "test@example.com").text();
}

const f = (over: Partial<Finding>): Finding => ({
  check: "install-path",
  severity: "warning",
  statement: "The installer does a thing.",
  evidence: "install.sh:1",
  method: "file",
  ...over,
});

describe("the chain of trust drawing", () => {
  it("holds every link on a clean verdict", async () => {
    const page = await html([f({ severity: "clean" })]);
    expect(page).toContain("every link held");
    expect(page).not.toContain("BREAKS HERE");
  });

  it("breaks at the first warning check when the verdict is not clean", async () => {
    const page = await html([
      f({ severity: "warning", check: "agent-config" }),
      f({ severity: "warning", check: "trust-root" }),
    ]);
    expect(page).toContain("breaks at agent config");
    expect(page).not.toContain("breaks at agent config, trust root");
    expect(page).toContain("BREAKS HERE");
  });

  it("breaks every critical check", async () => {
    const page = await html([
      f({ severity: "critical", check: "install-path", concern: "a" }),
      f({ severity: "critical", check: "install-path", concern: "b" }),
      f({ severity: "critical", check: "blast-radius", concern: "c" }),
    ]);
    expect(page).toContain("breaks at install path, blast radius");
  });

  it("never claims the chain held when prose findings alone carry the verdict", async () => {
    const page = await html([f({ severity: "warning", check: "prose" })]);
    expect(page).not.toContain("every link held");
    expect(page).toContain("concerns sit in the annotations below");
  });

  it("escapes target text everywhere it appears", async () => {
    const page = await html([
      f({ quote: `<script>alert("x")</script>`, statement: "Quote carried." }),
    ]);
    expect(page).not.toContain(`<script>alert`);
    expect(page).toContain("&lt;script&gt;");
  });

  it("ships no em dashes", async () => {
    const page = await html([f({})]);
    expect(page).not.toContain("—");
  });
});

describe("Open Graph and Twitter Card meta", () => {
  it("carries title, description and url on the homepage", async () => {
    const res = homePage({ contact: "test@example.com" });
    const body = await res.text();
    expect(body).toContain('<meta property="og:title" content="chainoftrust.dev">');
    expect(body).toMatch(/<meta property="og:description" content="[^"]+">/);
    expect(body).toContain('<meta property="og:url" content="https://chainoftrust.dev/">');
    expect(body).toContain('<meta name="twitter:card" content="summary">');
    expect(body).toMatch(/<meta name="twitter:title" content="[^"]+">/);
  });

  it("carries a report-specific title, description and url on a verdict page", async () => {
    const res = verdictPage(stored([f({})]), "test@example.com");
    const body = await res.text();
    expect(body).toContain('<meta property="og:title" content="owner/repo - chainoftrust.dev">');
    expect(body).toContain(
      '<meta property="og:url" content="https://chainoftrust.dev/r/github/owner/repo/abc1234abc1234abc1234abc1234abc1234abc12">',
    );
    expect(body).toMatch(/<meta property="og:description" content="owner\/repo at abc1234[^"]+">/);
  });
});

describe("Cache-Control on the SHA-pinned report page", () => {
  it("is set to match the JSON route only when the page is pinned by commit sha", () => {
    const pinned = verdictPage(stored([f({})]), "test@example.com", true);
    expect(pinned.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("is absent when the page resolves to the latest report, not a pinned one", () => {
    const unpinned = verdictPage(stored([f({})]), "test@example.com", false);
    expect(unpinned.headers.get("cache-control")).toBeNull();
  });

  it("is absent on the landing page", () => {
    const res = homePage({ contact: "test@example.com" });
    expect(res.headers.get("cache-control")).toBeNull();
  });
});

describe("competitive positioning on the homepage", () => {
  it("states the two checks that have no Scorecard or Socket equivalent", async () => {
    const body = await homePage({ contact: "test@example.com" }).text();
    expect(body).toContain("no equivalent in either tool");
    expect(body).toContain("install path reachability");
    expect(body).toContain("agent config auto-discovery");
    expect(body).not.toContain("—");
  });
});
