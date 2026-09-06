import { describe, expect, it } from "vitest";
import type { Finding, Report, StoredVerdict } from "../src/types";
import { homePage, SHOWCASE, shareIntentUrl, verdictPage } from "../src/ui/pages";
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

function stored(
  findings: Finding[],
  overrides: Partial<StoredVerdict> = {},
): StoredVerdict {
  return {
    report: report(findings),
    writeup: null,
    writeupModel: null,
    writeupDegradedReason: null,
    cached: false,
    createdAt: 0,
    ...overrides,
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

describe("shareIntentUrl", () => {
  it("builds an X intent URL carrying repo, verdict and report URL", () => {
    const url = shareIntentUrl("owner/repo", "Clean", "https://chainoftrust.dev/r/owner/repo/abc1234");
    expect(url.startsWith("https://twitter.com/intent/tweet?")).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get("url")).toBe("https://chainoftrust.dev/r/owner/repo/abc1234");
    expect(params.get("text")).toBe(
      "owner/repo: Clean - https://chainoftrust.dev/r/owner/repo/abc1234",
    );
  });

  it("percent-encodes special characters in the repo name and text", () => {
    const url = shareIntentUrl("owner/repo & co", "Do not install", "https://chainoftrust.dev/x");
    expect(url).not.toContain("&co");
    expect(url).not.toMatch(/text=[^&]*&(?!$)co/);
    const params = new URL(url).searchParams;
    expect(params.get("text")).toBe("owner/repo & co: Do not install - https://chainoftrust.dev/x");
  });

  it("never emits an em dash", () => {
    const url = shareIntentUrl("owner/repo", "Warnings", "https://chainoftrust.dev/x");
    expect(url).not.toContain("—");
  });
});

describe("the share-on-X affordance", () => {
  it("renders a pure anchor pointing at the X intent endpoint, no inline JS", async () => {
    const page = await html([f({ severity: "clean" })]);
    expect(page).toContain("Share on X");
    expect(page).toMatch(/<a href="https:\/\/twitter\.com\/intent\/tweet\?[^"]*" target="_blank"/);
    expect(page).not.toContain("onclick");
  });
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

describe("honest wording when there is no written summary", () => {
  async function bodyFor(reason: StoredVerdict["writeupDegradedReason"]): Promise<string> {
    return await verdictPage(
      stored([f({})], { writeupDegradedReason: reason }),
      "test@example.com",
    ).text();
  }

  it("says no provider was ever configured, distinct from a failure, when the reason is no-key", async () => {
    const body = await bodyFor("no-key");
    expect(body).toContain("No summary provider is configured for this deployment");
    expect(body).not.toContain("temporarily unavailable");
  });

  it("says the summary is temporarily unavailable when a configured provider hit its budget ceiling", async () => {
    const body = await bodyFor("budget");
    expect(body).toContain("temporarily unavailable");
    expect(body).toContain("deterministic findings below are complete and unaffected");
    expect(body).not.toContain("No summary provider is configured");
  });

  it("says the summary is temporarily unavailable when a configured provider failed", async () => {
    const body = await bodyFor("error");
    expect(body).toContain("temporarily unavailable");
    expect(body).toContain("deterministic findings below are complete and unaffected");
    expect(body).not.toContain("No summary provider is configured");
  });

  it("never invents a reason for a report stored before this field existed", async () => {
    const body = await bodyFor(null);
    expect(body).toContain("The written summary was skipped for this report");
    expect(body).not.toContain("temporarily unavailable");
    expect(body).not.toContain("No summary provider is configured");
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

describe("the curated showcase on the homepage", () => {
  it("holds a handful of entries, never zero and never a sprawling index", () => {
    expect(SHOWCASE.length).toBeGreaterThanOrEqual(3);
    expect(SHOWCASE.length).toBeLessThanOrEqual(6);
  });

  it("names a distinct repository per entry, each pinned to a full commit sha", () => {
    const keys = SHOWCASE.map((s) => `${s.owner}/${s.name}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of SHOWCASE) {
      expect(s.sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("includes the site's own self-analysis now that the repository is public", () => {
    const self = SHOWCASE.find((s) => s.owner === "simlf" && s.name === "chainoftrust");
    expect(self).toBeDefined();
    expect(self!.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("frames the list as curated examples, never as a complete or live index", async () => {
    const body = await homePage({ contact: "test@example.com" }).text();
    expect(body).toContain("Example reports, not an index");
    expect(body).toContain("Not everything analysed");
    expect(body).not.toContain("—");
  });

  it("links every entry to its real, sha-pinned report page", async () => {
    const body = await homePage({ contact: "test@example.com" }).text();
    for (const s of SHOWCASE) {
      expect(body).toContain(`href="/r/github/${s.owner}/${s.name}/${s.sha}"`);
    }
  });

  it("carries no timestamp or count that would misread as an activity feed", async () => {
    const body = await homePage({ contact: "test@example.com" }).text();
    // The showcase section itself must not print a generated-at date or a
    // "N repositories analysed" style count; the wording it does carry is
    // asserted above. This just guards against reintroducing either shape.
    expect(body).not.toMatch(/\d+ repositories analysed/i);
    expect(body).not.toMatch(/analysed \d+ (minutes|hours|days) ago/i);
  });
});
