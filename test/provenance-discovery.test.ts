import { describe, expect, it } from "vitest";
import { collect } from "../src/collect/index";
import { cacheKeyFor } from "../src/lib/target";
import type { Evidence, RegistryRef, RepoMeta } from "../src/types";
import { REA_AGENTS, REA_AGENTS_TOKEN_PUBLISHED } from "./fixtures/registry";

/**
 * Registry provenance for a repository submission.
 *
 * morluto/rea at 3460ceac publishes rea-agents@6.5.0 with SLSA provenance
 * through npm trusted publishing, and its report said nothing about either: a
 * pasted GitHub URL carries no registry reference, so the check never ran. The
 * repository also ships an install.sh, which is the shape here, so the
 * installer path and the registry path have to coexist.
 */

const OWNER = "morluto";
const NAME = "rea";
const SHA = "3460ceac3f5dc93c767b1e7c39a511f026b41baa";

const meta: RepoMeta = {
  fullName: `${OWNER}/${NAME}`,
  description: null,
  isFork: false,
  parentFullName: null,
  parentArchived: null,
  archived: false,
  stars: 10,
  openIssues: 0,
  pushedAt: "2026-10-17T00:00:00Z",
  createdAt: "2025-01-01T00:00:00Z",
  homepage: null,
  license: "MIT",
};

const INSTALL_SH = "#!/usr/bin/env bash\nset -euo pipefail\nnpm install --global rea-agents\n";

function fakeFetcher(files: Record<string, string>, registry: Record<string, unknown>) {
  const seen: string[] = [];
  return {
    seen,
    remaining: 30,
    budgetExhausted: false,
    async json<T>(url: string): Promise<T | null> {
      seen.push(url);
      if (url === `https://api.github.com/repos/${OWNER}/${NAME}/git/trees/${SHA}?recursive=1`) {
        return {
          tree: Object.keys(files).map((path) => ({ path, type: "blob", size: 100 })),
          truncated: false,
        } as T;
      }
      for (const [name, doc] of Object.entries(registry)) {
        if (url === `https://registry.npmjs.org/${name}`) return doc as T;
        if (url === `https://pypi.org/pypi/${name}/json`) return doc as T;
      }
      return null;
    },
    async text(url: string): Promise<string | null> {
      seen.push(url);
      for (const [path, text] of Object.entries(files)) {
        if (url === `https://raw.githubusercontent.com/${OWNER}/${NAME}/${SHA}/${path}`) return text;
      }
      return null;
    },
  };
}

async function collectRepo(
  f: ReturnType<typeof fakeFetcher>,
  registry?: RegistryRef,
): Promise<Evidence> {
  return collect(f as never, {
    target: {
      cacheKey: cacheKeyFor(OWNER, NAME, SHA, registry),
      host: "github",
      owner: OWNER,
      name: NAME,
      requestedRef: "",
      sha: SHA,
      defaultBranch: "main",
      ...(registry ? { registry } : {}),
    },
    meta,
  });
}

const REA_FILES = {
  "package.json": JSON.stringify({ name: "rea-agents", version: "6.5.0" }),
  "install.sh": INSTALL_SH,
};

function finding(evidence: Evidence, concern: string) {
  return evidence.findings.find((f) => f.concern === concern);
}

describe("registry provenance on a repository submission", () => {
  it("reports rea-agents' SLSA provenance and trusted publishing as clean, citing the registry fields", async () => {
    const evidence = await collectRepo(fakeFetcher(REA_FILES, { "rea-agents": REA_AGENTS }));

    // The installer is still read: the registry check runs beside it, not instead.
    expect(finding(evidence, "install-path:sudo")).toBeDefined();

    const attestation = finding(evidence, "registry-provenance:attestation");
    expect(attestation?.severity).toBe("clean");
    expect(attestation?.statement).toContain("rea-agents@6.5.0");
    expect(attestation?.statement).toContain("https://slsa.dev/provenance/v1");
    expect(attestation?.evidence).toBe(
      "registry.npmjs.org/rea-agents dist.attestations.provenance.predicateType",
    );

    const publisher = finding(evidence, "registry-provenance:publisher");
    expect(publisher?.severity).toBe("clean");
    expect(publisher?.statement).toContain("npm trusted publishing");
    expect(publisher?.statement).toContain("trusted publisher github");
    expect(publisher?.evidence).toBe("registry.npmjs.org/rea-agents _npmUser.trustedPublisher");
  });

  /**
   * Most published packages carry no provenance. A repository submission gains
   * the positive signal when it is there, but its absence must not turn a
   * clean repository's verdict into warnings.
   */
  it("reports absence as a note, so no repository's verdict gets worse", async () => {
    const evidence = await collectRepo(
      fakeFetcher(REA_FILES, { "rea-agents": REA_AGENTS_TOKEN_PUBLISHED }),
    );

    const attestation = finding(evidence, "registry-provenance:attestation");
    expect(attestation?.severity).toBe("note");
    expect(attestation?.statement).toContain("carries no provenance attestation");
    expect(attestation?.evidence).toBe("registry.npmjs.org/rea-agents dist.attestations");

    const publisher = finding(evidence, "registry-provenance:publisher");
    expect(publisher?.severity).toBe("note");
    expect(publisher?.statement).toContain("long-lived publish token");
    expect(publisher?.evidence).toBe("registry.npmjs.org/rea-agents _npmUser");
  });

  it("still scores absence as a warning when the submission named the package", async () => {
    const evidence = await collectRepo(
      fakeFetcher({}, { "rea-agents": REA_AGENTS_TOKEN_PUBLISHED }),
      { kind: "npm", packageName: "rea-agents", version: "6.5.0" },
    );

    const attestation = finding(evidence, "registry-provenance:attestation");
    expect(attestation?.severity).toBe("warning");
    expect(attestation?.statement).toContain("carries no provenance attestation");
  });

  /**
   * The report is pinned to a commit; the registry's provenance is for its
   * latest version, which may have been built from a different one.
   */
  it("says the latest published version was not matched to this commit", async () => {
    const evidence = await collectRepo(fakeFetcher(REA_FILES, { "rea-agents": REA_AGENTS }));

    expect(evidence.notChecked.join("\n")).toContain(
      "latest published version of rea-agents (6.5.0) was built from this commit was not verified",
    );
  });

  /**
   * A manifest name is a claim anyone can write. A fork, or a repository
   * squatting on a popular name, must not borrow the real package's provenance.
   */
  it("attributes nothing when the registry entry points at a different repository", async () => {
    const elsewhere = {
      ...REA_AGENTS,
      repository: { url: "git+https://github.com/someone/else.git" },
      versions: {
        "6.5.0": {
          ...REA_AGENTS.versions["6.5.0"],
          repository: { url: "git+https://github.com/someone/else.git" },
        },
      },
    };
    const evidence = await collectRepo(fakeFetcher(REA_FILES, { "rea-agents": elsewhere }));

    expect(evidence.findings.filter((f) => f.check === "registry-provenance")).toEqual([]);
    expect(finding(evidence, "trust-root:publish-rights")).toBeUndefined();
    expect(evidence.notChecked.join("\n")).toContain(
      "A package named rea-agents exists on npm but does not point back at this repository",
    );
  });

  it("does not look a private package up at all", async () => {
    const f = fakeFetcher(
      { "package.json": JSON.stringify({ name: "rea-agents", private: true }) },
      { "rea-agents": REA_AGENTS },
    );
    const evidence = await collectRepo(f);

    expect(f.seen.some((url) => url.startsWith("https://registry.npmjs.org/"))).toBe(false);
    expect(evidence.findings.filter((f) => f.check === "registry-provenance")).toEqual([]);
  });

  it("reads a PyPI package name from pyproject.toml's [project] table", async () => {
    const pyproject = [
      "[build-system]",
      'requires = ["hatchling"]',
      'build-backend = "hatchling.build"',
      "",
      "[project]",
      'name = "rea-py"',
      'version = "1.0.0"',
      "",
      "[tool.other]",
      'name = "not-this-one"',
    ].join("\n");
    const pypi = {
      info: {
        name: "rea-py",
        version: "1.0.0",
        project_urls: { Source: `https://github.com/${OWNER}/${NAME}` },
      },
      urls: [{ has_sig: false, provenance: "https://pypi.org/integrity/rea-py/1.0.0/x/provenance" }],
    };
    const evidence = await collectRepo(fakeFetcher({ "pyproject.toml": pyproject }, { "rea-py": pypi }));

    const attestation = finding(evidence, "registry-provenance:attestation");
    expect(attestation?.severity).toBe("clean");
    expect(attestation?.evidence).toBe("pypi.org/pypi/rea-py/json urls[].provenance");

    const unattested = await collectRepo(
      fakeFetcher(
        { "pyproject.toml": pyproject },
        { "rea-py": { ...pypi, urls: [{ has_sig: false, provenance: null }] } },
      ),
    );
    expect(finding(unattested, "registry-provenance:attestation")?.severity).toBe("note");
  });
});
