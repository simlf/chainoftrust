import { describe, expect, it } from "vitest";
import { PROSE_CANDIDATES, scanProse } from "../src/collect/prose";

/**
 * Binding adjustment 4: several of the highest-value findings in the validation
 * came from reading prose, not structured data. Each case below is one of them.
 * A collector that only parses manifests scores zero on this file.
 */
describe("prose collection", () => {
  it("carries a security policy that disclaims install-time tampering", () => {
    // puppeteer's SECURITY.md, which reframes the missing-checksum finding as a
    // documented stance rather than an oversight.
    const scan = scanProse([
      {
        path: "SECURITY.md",
        text: "Specifically, Man-in-the-Middle (MITM) attacks and the manipulation of Puppeteer or browser downloads via local access are not considered vulnerabilities.",
      },
    ]);
    expect(scan.excerpts.length).toBeGreaterThan(0);
    expect(scan.findings.some((f) => f.severity === "warning")).toBe(true);
    expect(scan.excerpts[0]!.text).toContain("not considered vulnerabilities");
  });

  it("carries a maintainer calling their own shipped tool RCE-equivalent", () => {
    const scan = scanProse([
      {
        path: "README.md",
        text: "Run a Playwright code snippet. Unsafe: executes arbitrary JavaScript in the Playwright server process and is RCE-equivalent.",
      },
    ]);
    expect(scan.findings.some((f) => /RCE|arbitrary/i.test(f.statement))).toBe(true);
  });

  it("carries a fork's own claim about its archived parent", () => {
    const scan = scanProse([
      {
        path: "README.md",
        text: "This is an actively maintained fork of GongRzhe/Gmail-MCP-Server. The original repository has been unmaintained since August 2025.",
      },
    ]);
    expect(scan.excerpts.some((e) => /actively maintained fork/.test(e.text))).toBe(true);
  });

  it("carries a maintainer note that undercuts a marketed number", () => {
    const scan = scanProse([
      {
        path: "CLAUDE.md",
        text: "The 2.49x-7.47x Flash Attention speedup figure was computed with a pseudo-random number generator rather than measured on hardware.",
      },
    ]);
    expect(scan.findings.some((f) => f.severity === "warning")).toBe(true);
  });

  it("carries an install path written for an agent to follow", () => {
    const scan = scanProse([
      {
        path: "README.md",
        text: "Just tell your Claude to install the MCP from this repo and let it set up everything for you.",
      },
    ]);
    expect(scan.findings.some((f) => /agent, not a human/.test(f.statement))).toBe(true);
  });

  it("stays quiet on prose with nothing to report", () => {
    const scan = scanProse([
      { path: "README.md", text: "A fast Python package installer written in Rust. Install with your package manager of choice and run it." },
    ]);
    expect(scan.findings).toEqual([]);
  });

  it("states an absence only when the listing it was read from establishes one", () => {
    const scan = scanProse([], { candidates: [], complete: true });
    expect(scan.findings[0]!.concern).toBe("prose:absent");
    expect(scan.findings[0]!.statement).toMatch(/names no README/);
    expect(scan.notChecked).toEqual([]);
  });

  it("does not call a README absent when it was listed but never read", () => {
    const scan = scanProse([], { candidates: ["README.md"], complete: true });
    expect(scan.findings).toEqual([]);
    expect(scan.notChecked).toHaveLength(1);
    expect(scan.notChecked[0]!).toContain("README.md");
    expect(scan.notChecked[0]!).toMatch(/did not read/);
  });

  it("names what was read and what was not when only some prose was reached", () => {
    const scan = scanProse(
      [{ path: "README.md", text: "A fast package installer. Install it and run it." }],
      { candidates: ["README.md", "SECURITY.md"], complete: true },
    );
    expect(scan.findings).toEqual([]);
    expect(scan.notChecked[0]!).toContain("README.md");
    expect(scan.notChecked[0]!).toContain("SECURITY.md");
  });

  it("claims nothing about prose when the listing itself was not read", () => {
    const scan = scanProse([], { candidates: [], complete: false });
    expect(scan.findings).toEqual([]);
    expect(scan.notChecked[0]!).toMatch(/cannot say whether the project has one/);
  });

  it("bounds how much of any one file it carries", () => {
    const scan = scanProse([
      {
        path: "README.md",
        text: Array.from(
          { length: 40 },
          (_, i) => `Item ${i}: this project requires root and you must run as root to proceed.`,
        ).join("\n\n"),
      },
    ]);
    expect(scan.excerpts.length).toBeLessThanOrEqual(4);
    for (const e of scan.excerpts) expect(e.text.length).toBeLessThanOrEqual(320);
  });
});

describe("nested agent instruction files", () => {
  // strudel-claude keeps its persona/instruction file at .claude/CLAUDE.md,
  // not at the repository root; both nested candidates are exact-match
  // entries because this list, unlike agent-config.ts's presence regex, does
  // not match on depth.
  it("lists the .claude/-nested CLAUDE.md and AGENTS.md locations as candidates", () => {
    expect(PROSE_CANDIDATES).toContain(".claude/CLAUDE.md");
    expect(PROSE_CANDIDATES).toContain(".claude/AGENTS.md");
  });

  it("reads and searches a nested CLAUDE.md the same as a root one", () => {
    const scan = scanProse([
      {
        path: ".claude/CLAUDE.md",
        text: "This persona is unmaintained and no longer maintained by the original author.",
      },
    ]);
    expect(scan.findings.some((f) => f.evidence.includes(".claude/CLAUDE.md"))).toBe(true);
  });
});

describe("false positives worth refusing", () => {
  it("does not read a third-party integration link as this project's telemetry", () => {
    // Found by running the pipeline against ollama/ollama: its README links to
    // an observability vendor, and the word "analytics" in that link was being
    // reported as if the project itself sent data somewhere.
    const scan = scanProse([
      {
        path: "README.md",
        text: "- [Lunary](https://lunary.ai/docs/integrations/ollama) - LLM observability with analytics and PII masking\n\n- [Other](https://example.test/x) - telemetry and usage data dashboards",
      },
    ]);
    expect(scan.findings).toEqual([]);
    expect(scan.excerpts).toEqual([]);
  });

  it("quotes a sentence a README repeats only once", () => {
    // ollama/ollama documents the same curl-into-shell install line in two
    // sections, and the verdict page printed the identical quote twice.
    const line = "```shell curl -fsSL https://ollama.com/install.sh | sh ```";
    const scan = scanProse([
      { path: "README.md", text: `Linux\n\n${line}\n\nWSL2\n\n${line}` },
    ]);
    expect(scan.excerpts.filter((e) => e.text.includes("install.sh | sh"))).toHaveLength(1);
    expect(new Set(scan.excerpts.map((e) => `${e.path}::${e.text}`)).size).toBe(
      scan.excerpts.length,
    );
  });

  it("still reports telemetry the project describes in its own prose", () => {
    const scan = scanProse([
      {
        path: "README.md",
        text: "This tool sends anonymous usage data to our analytics endpoint unless you opt out of tracking.",
      },
    ]);
    expect(scan.findings.length).toBeGreaterThan(0);
  });
});
