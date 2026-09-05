import { describe, expect, it } from "vitest";
import type { Finding, Report } from "../src/types";
import { elevationSchematic } from "../src/ui/elevation";
import { scoreVerdict } from "../src/verdict/score";

function report(findings: Finding[], notChecked: string[] = []): Report {
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
    notChecked,
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

const sudoClean: Finding = {
  check: "install-path",
  severity: "clean",
  concern: "install-path:sudo",
  statement: "install.sh never asks for root.",
  evidence: "install.sh, whole file",
  method: "file",
};

describe("the install-path elevation schematic", () => {
  it("renders nothing when there is no installer to draw", () => {
    const svg = elevationSchematic(report([]));
    expect(svg).toBe("");
  });

  it("draws all four stages for a full, clean install path", () => {
    const findings: Finding[] = [
      sudoClean,
      {
        check: "install-path",
        severity: "clean",
        concern: "install-path:verification",
        statement: "install.sh verifies the file it downloaded and stops on a mismatch.",
        evidence: "install.sh:12",
        method: "file",
      },
    ];
    const svg = elevationSchematic(report(findings));
    expect(svg).toContain("<svg");
    expect(svg).toContain("RELEASE");
    expect(svg).toContain("INSTALLER");
    expect(svg).toContain("BINARY");
    expect(svg).toContain("DAEMON");
    expect(svg).toContain("checksum path intact");
    expect(svg).not.toContain("stroke-dasharray");
    expect(svg).not.toContain("NOT CHECKED");
    expect(svg).not.toContain("—");
  });

  it("severs the checksum path and cites the finding's own annotation number", () => {
    const findings: Finding[] = [
      sudoClean,
      {
        check: "install-path",
        severity: "critical",
        concern: "install-path:verification-unreachable",
        statement: "install.sh contains checksum-verification code that cannot run.",
        evidence: "install.sh:20",
        method: "file",
      },
    ];
    const r = report(findings);
    const svg = elevationSchematic(r);
    expect(svg).toContain("checksum path severed");
    // The broken-link glyph, not a plain dashed line, at critical severity.
    expect(svg).toContain("A 14 14 0 0 0");
    // Index 2 (1-based) is the unreachable finding's position in r.findings.
    const calloutIndex = r.findings.indexOf(findings[1]!) + 1;
    expect(calloutIndex).toBe(2);
    expect(svg).toContain(`>${calloutIndex}<`);
    expect(svg).not.toContain("—");
  });

  it("dashes rather than breaks a non-critical severed checksum path", () => {
    const findings: Finding[] = [
      sudoClean,
      {
        check: "install-path",
        severity: "warning",
        concern: "install-path:unused-integrity-assets",
        statement: "The latest release publishes checksums.txt, and install.sh never references it.",
        evidence: "release v1, install.sh",
        method: "api",
      },
    ];
    const svg = elevationSchematic(report(findings));
    expect(svg).toContain("checksum path severed");
    expect(svg).toContain("stroke-dasharray");
    expect(svg).not.toContain("A 14 14 0 0 0");
  });

  it("hatches the release stage when no release was found, without fabricating a finding", () => {
    const svg = elevationSchematic(
      report([sudoClean], [
        "This repository publishes no GitHub release, so there were no release assets to compare the install path against.",
      ]),
    );
    expect(svg).toContain("elev-hatch");
    expect(svg).toContain("NOT CHECKED");
    expect(svg).toContain("release not checked");
  });

  it("flags root use, execution of the download and daemon residency", () => {
    const findings: Finding[] = [
      {
        ...sudoClean,
        severity: "warning",
        statement: "install.sh runs 1 command with elevated privileges.",
      },
      {
        check: "install-path",
        severity: "warning",
        concern: "install-path:executes-download",
        statement: "install.sh runs the artefact it just downloaded.",
        evidence: "install.sh:30",
        method: "file",
      },
      {
        check: "install-path",
        severity: "warning",
        concern: "install-path:residency",
        statement: "install.sh registers a service that starts on its own.",
        evidence: "install.sh:35",
        method: "file",
      },
    ];
    const svg = elevationSchematic(report(findings));
    expect(svg).toContain("ROOT");
    expect(svg).toContain("EXECUTES");
    expect(svg).toContain("RESIDENT");
    expect(svg).toContain("runs as root");
    expect(svg).toContain("installer runs the download");
    expect(svg).toContain("daemon left resident");
  });

  it("escapes nothing target-controlled into raw markup (statements never reach this SVG)", () => {
    const findings: Finding[] = [
      sudoClean,
      {
        check: "install-path",
        severity: "warning",
        concern: "install-path:verification-skippable",
        statement: `<script>alert(1)</script>`,
        evidence: "install.sh:5",
        method: "file",
      },
    ];
    const svg = elevationSchematic(report(findings));
    expect(svg).not.toContain("<script>alert");
  });
});
