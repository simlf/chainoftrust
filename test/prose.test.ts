import { describe, expect, it } from "vitest";
import { scanProse } from "../src/collect/prose";

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

  it("says so when there was no prose to read at all", () => {
    const scan = scanProse([]);
    expect(scan.findings[0]!.statement).toMatch(/No README, security policy/);
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
