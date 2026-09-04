import { describe, expect, it } from "vitest";
import type { Finding, Report, StoredVerdict } from "../src/types";
import { verdictPage } from "../src/ui/pages";
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
