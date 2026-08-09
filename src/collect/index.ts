import type { Fetcher } from "../lib/fetcher";
import {
  fetchContributors,
  fetchLatestRelease,
  fetchRepo,
  fetchTree,
  rawUrl,
  resolveSha,
} from "../lib/github";
import { fetchNpm, fetchPypi, fetchScorecard } from "../lib/registry";
import type { ParsedInput } from "../lib/target";
import { cacheKeyFor } from "../lib/target";
import type { Evidence, Finding, NotChecked, TargetRef, TreeEntry } from "../types";
import { analyseHookManifest, scanAgentConfig } from "./agent-config";
import { analysePackageJson, analysePyproject } from "./manifest";
import { PROSE_CANDIDATES, scanProse } from "./prose";
import { analyseShell, credentialShaped } from "./shell";
import { censusSurface } from "./surface";

export class TargetNotFound extends Error {}

const INSTALL_SCRIPT = /^(?:|docs\/|scripts\/|script\/|bin\/|install\/|tools\/)(install|setup|get|bootstrap)\.(sh|ps1|bash)$/;

// Integrity assets are named a dozen ways in practice. Anchoring the whole
// name misses the commonest form of all: ollama publishes `sha256sum.txt`, and
// requiring the name to end at "sha256sum" silently dropped the single
// sharpest finding in the validation. Match the token, not the whole filename.
export const CHECKSUM_ASSET =
  /(^|[._-])(checksums?|sha256sums?|sha512sums?|shasums?|digests?)([._-]|$)|\.(sha256|sha512|sig|asc|minisig|sigstore|pem|intoto\.jsonl)$/i;

const MAX_FILES = 12;

export interface Resolved {
  target: TargetRef;
  meta: Evidence["meta"];
}

/**
 * Pin the submission to a commit.
 *
 * Kept separate from collection so the cache can be consulted before any real
 * work happens. Two API calls buy us the SHA, and a hit means we never touch
 * the rest of the pipeline or the rate limiter.
 */
export async function resolveTarget(f: Fetcher, input: ParsedInput): Promise<Resolved> {
  const resolved = await resolveRepository(f, input);
  const { owner, name, requestedRef } = resolved;

  const repo = await fetchRepo(f, owner, name);
  if (!repo) {
    throw new TargetNotFound(
      `No public repository at github.com/${owner}/${name}, or GitHub declined the request.`,
    );
  }

  const ref = requestedRef || repo.defaultBranch;
  const sha = await resolveSha(f, owner, name, ref);
  if (!sha) throw new TargetNotFound(`No commit found for ref "${ref}".`);

  return {
    meta: repo.meta,
    target: {
      cacheKey: cacheKeyFor(owner, name, sha),
      host: "github",
      owner,
      name,
      requestedRef,
      sha,
      defaultBranch: repo.defaultBranch,
      ...(resolved.registry ? { registry: resolved.registry } : {}),
    },
  };
}

/**
 * Assemble the evidence bundle.
 *
 * Everything here is deterministic: a fetch, a parse, a grep, a size sum. The
 * model never runs at this stage and never decides what to look for. Measured
 * bundles in the validation ran 560 to 4,500 tokens per target, which is what
 * makes a small model viable for the write-up.
 */
export async function collect(f: Fetcher, resolvedTarget: Resolved): Promise<Evidence> {
  const { target, meta } = resolvedTarget;
  const { owner, name, sha } = target;
  const repo = { meta };

  const findings: Finding[] = [];
  const notChecked: NotChecked[] = [];

  const tree = await fetchTree(f, owner, name, sha);
  const entries: TreeEntry[] = tree?.entries ?? [];
  if (!tree) {
    notChecked.push(
      "The repository file listing could not be read, so the agent-config and unauditable-surface checks did not run.",
    );
  } else if (tree.truncated) {
    notChecked.push(
      "GitHub truncated the file listing for this repository, so the file-presence checks cover only part of the tree.",
    );
  }

  // Free, listing-only checks first. These are the ones that need no download,
  // which is also why they are safe: nothing is fetched, so nothing can
  // register itself anywhere.
  const agentScan = scanAgentConfig(entries);
  findings.push(...agentScan.findings);

  const census = censusSurface(entries, Boolean(tree?.truncated));
  findings.push(...census.findings);

  // Bounded set of files worth reading, in priority order.
  const wanted = selectFiles(entries, agentScan.hookManifests);
  const fetched: { path: string; text: string }[] = [];
  for (const path of wanted) {
    if (fetched.length >= MAX_FILES || f.remaining <= 6) break;
    const text = await f.text(rawUrl(owner, name, sha, path));
    if (text !== null) fetched.push({ path, text });
  }

  const installScripts = fetched.filter((file) => INSTALL_SCRIPT.test(file.path));
  const release = await fetchLatestRelease(f, owner, name);
  findings.push(...installPathFindings(installScripts, release, notChecked));

  for (const file of fetched) {
    if (file.path.endsWith("package.json")) {
      findings.push(...analysePackageJson(file.path, file.text).findings);
    } else if (file.path.endsWith("pyproject.toml")) {
      findings.push(...analysePyproject(file.path, file.text));
    } else if (agentScan.hookManifests.includes(file.path)) {
      findings.push(...analyseHookManifest(file.path, file.text));
    }
  }

  const prose = scanProse(
    fetched.filter((file) => PROSE_CANDIDATES.includes(file.path)),
  );
  findings.push(...prose.findings);

  findings.push(...(await provenanceFindings(f, target, notChecked)));
  findings.push(...(await trustRootFindings(f, owner, name, repo.meta)));

  const scorecard = await fetchScorecard(f, owner, name);
  if (!scorecard) {
    notChecked.push(
      "OpenSSF Scorecard has no published result for this repository, so its maintenance-hygiene score is not shown.",
    );
  }

  notChecked.push(
    "Nothing was executed. The installer was not run, the package was not installed, and no binary was launched, so every statement here is about what the code says it does rather than what it did.",
  );
  if (census.opaqueBytes > 0) {
    notChecked.push(
      "The contents of compiled and generated files were not reviewed. They can only be read by running the project's own build or by disassembly.",
    );
  }
  if (f.budgetExhausted) {
    notChecked.push(
      "The per-analysis network budget ran out before every candidate file was read, so this report covers fewer files than usual.",
    );
  }
  if (installScripts.length === 0) {
    notChecked.push(
      "Install scripts hosted outside this repository were not fetched. Only scripts committed to the repository itself are read.",
    );
  }

  return {
    target,
    meta: repo.meta,
    findings,
    notChecked,
    proseExcerpts: prose.excerpts,
    ...(scorecard ? { scorecard } : {}),
    stats: {
      filesInTree: entries.length,
      totalBytes: census.totalBytes,
      opaqueBytes: census.opaqueBytes,
      filesFetched: fetched.length,
      fetchBudgetExhausted: f.budgetExhausted,
    },
  };
}

/** npm and PyPI inputs are resolved to the repository they point at. */
async function resolveRepository(
  f: Fetcher,
  input: ParsedInput,
): Promise<{
  owner: string;
  name: string;
  requestedRef: string;
  registry?: TargetRef["registry"];
}> {
  if (input.kind === "github") {
    return { owner: input.owner, name: input.name, requestedRef: input.ref };
  }

  const info =
    input.kind === "npm" ? await fetchNpm(f, input.name) : await fetchPypi(f, input.name);
  if (!info) {
    throw new TargetNotFound(`No ${input.kind} package named "${input.name}".`);
  }
  if (!info.repositoryUrl) {
    throw new TargetNotFound(
      `The ${input.kind} package "${input.name}" does not declare a GitHub repository, so there is no source to read.`,
    );
  }
  const [owner, name] = info.repositoryUrl.replace(/^https?:\/\/github\.com\//, "").split("/");
  if (!owner || !name) {
    throw new TargetNotFound(`Could not read a repository out of "${info.repositoryUrl}".`);
  }
  return {
    owner,
    name: name.replace(/\.git$/, ""),
    requestedRef: "",
    registry: { kind: input.kind, packageName: info.name, version: info.version },
  };
}

function selectFiles(entries: TreeEntry[], hookManifests: string[]): string[] {
  const paths = new Set(entries.map((e) => e.path));
  const wanted: string[] = [];

  const push = (p: string) => {
    if (paths.has(p) && !wanted.includes(p)) wanted.push(p);
  };

  for (const entry of entries) {
    if (INSTALL_SCRIPT.test(entry.path)) push(entry.path);
  }
  push("package.json");
  push("pyproject.toml");
  for (const manifest of hookManifests) push(manifest);
  for (const candidate of PROSE_CANDIDATES) push(candidate);

  return wanted.slice(0, MAX_FILES);
}

function installPathFindings(
  scripts: { path: string; text: string }[],
  release: Awaited<ReturnType<typeof fetchLatestRelease>>,
  notChecked: NotChecked[],
): Finding[] {
  const findings: Finding[] = [];
  const checksumAssets = (release?.assets ?? [])
    .map((a) => a.name)
    .filter((n) => CHECKSUM_ASSET.test(n));

  if (scripts.length === 0) {
    if (checksumAssets.length > 0) {
      findings.push({
        check: "install-path",
        severity: "clean",
        concern: "install-path:verification",
        statement: `The latest release publishes integrity files (${checksumAssets.slice(0, 3).join(", ")}). No install script is committed to the repository, so how they are consumed depends on the instructions you follow.`,
        evidence: `release ${release?.tag}`,
        method: "api",
      });
    }
    return findings;
  }

  for (const script of scripts) {
    const a = analyseShell(script.text);
    const v = a.verification;
    const cite = (lines: { n: number }[]) =>
      `${script.path}:${lines.slice(0, 3).map((l) => l.n).join(",")}`;

    switch (v.state) {
      case "absent":
        findings.push({
          check: "install-path",
          severity: a.downloads.length > 0 ? "warning" : "note",
          concern: "install-path:verification-absent",
          statement:
            a.downloads.length > 0
              ? `${script.path} downloads a file and never verifies it. No hashing or signature tool is invoked anywhere in its ${a.lineCount} lines.`
              : `${script.path} invokes no hashing or signature tool.`,
          evidence:
            a.downloads.length > 0 ? cite(a.downloads) : `${script.path}, whole file`,
          method: "file",
        });
        break;
      case "unreachable":
        findings.push({
          check: "install-path",
          severity: "critical",
          concern: "install-path:verification-unreachable",
          statement: `${script.path} contains checksum-verification code that cannot run. It reads ${v.unassignedVars.join(", ")}, and nothing in the script ever assigns ${v.unassignedVars.length === 1 ? "that variable" : "those variables"}, so the comparison always takes the branch that skips verification.`,
          evidence: cite(v.tooling.length > 0 ? v.tooling : a.downloads),
          method: "file",
        });
        break;
      case "can-skip-silently":
        // Two different situations share this state and they are not equally
        // bad. A script that aborts on mismatch but skips when the hashing tool
        // is missing (uv's shape) still verifies whenever it can. A script with
        // no abort path at all never enforces anything.
        findings.push({
          check: "install-path",
          severity: v.abortSites.length > 0 ? "note" : "warning",
          concern: "install-path:verification-skippable",
          statement:
            v.abortSites.length > 0
              ? `${script.path} verifies its download and stops on a mismatch, but has a path that continues without verifying, so on a machine that takes that path the download is not checked.`
              : `${script.path} can complete without verifying what it downloaded. Its hash comparison is not followed by anything that stops the script on a mismatch.`,
          evidence: cite(v.skipPaths.length > 0 ? v.skipPaths : v.tooling),
          method: "file",
        });
        break;
      case "enforced":
        findings.push({
          check: "install-path",
          severity: "clean",
          concern: "install-path:verification",
          statement: `${script.path} verifies the file it downloaded and stops on a mismatch.`,
          evidence: cite(v.abortSites.length > 0 ? v.abortSites : v.tooling),
          method: "file",
        });
        break;
    }

    // The Ollama shape: the release ships the checksums, the installer never
    // names them. Reproducible by grepping one script against one asset list.
    if (checksumAssets.length > 0 && v.state !== "enforced") {
      const named = checksumAssets.some((asset) => script.text.includes(asset));
      if (!named) {
        findings.push({
          check: "install-path",
          severity: "warning",
          concern: "install-path:unused-integrity-assets",
          statement: `The latest release publishes ${checksumAssets.slice(0, 3).join(", ")}, and ${script.path} never references ${checksumAssets.length === 1 ? "it" : "any of them"}. The integrity files exist and this install path does not use them.`,
          evidence: `release ${release?.tag} assets, ${script.path}`,
          method: "api",
        });
      }
    }

    if (a.pipeToShell.length > 0) {
      findings.push({
        check: "install-path",
        severity: "note",
        concern: "install-path:pipe-to-shell",
        statement: `${script.path} pipes downloaded content directly into a shell.`,
        evidence: cite(a.pipeToShell),
        method: "file",
      });
    }

    if (a.sudo.length > 0) {
      findings.push({
        check: "install-path",
        severity: "warning",
        concern: "install-path:sudo",
        statement: `${script.path} runs ${a.sudo.length} command${a.sudo.length === 1 ? "" : "s"} with elevated privileges. What it installs is not confined to your home directory.`,
        evidence: cite(a.sudo),
        method: "file",
      });
    } else {
      findings.push({
        check: "install-path",
        severity: "clean",
        concern: "install-path:sudo",
        statement: `${script.path} never asks for root.`,
        evidence: `${script.path}, whole file`,
        method: "file",
      });
    }

    if (a.executesDownload.length > 0) {
      findings.push({
        check: "install-path",
        severity: "warning",
        concern: "install-path:executes-download",
        statement: `${script.path} runs the artefact it just downloaded, rather than only placing it on PATH.`,
        evidence: cite(a.executesDownload),
        method: "file",
      });
    }

    if (a.residency.length > 0) {
      findings.push({
        check: "install-path",
        severity: "warning",
        concern: "install-path:residency",
        statement: `${script.path} leaves something running after it exits: it registers a service or background agent that starts on its own.`,
        evidence: cite(a.residency),
        method: "file",
      });
    }

    if (a.agentConfigWrites.length > 0) {
      findings.push({
        check: "agent-config",
        severity: "critical",
        concern: "agent-config:installer-writes",
        statement: `${script.path} writes to agent configuration paths. Installing this changes how your agent behaves in every later session, not just this one.`,
        evidence: cite(a.agentConfigWrites),
        method: "file",
      });
    }

    const creds = credentialShaped(a.envVars);
    if (creds.length > 0) {
      findings.push({
        check: "blast-radius",
        severity: "note",
        concern: "blast-radius:credentials",
        statement: `${script.path} reads ${creds.length} credential-shaped environment variable${creds.length === 1 ? "" : "s"}: ${creds.join(", ")}. Whether that is benign depends on the surrounding code path, which this report does not judge.`,
        evidence: `${script.path}, environment reads`,
        method: "file",
      });
    }

    if (a.outboundHosts.length > 0) {
      findings.push({
        check: "blast-radius",
        severity: a.outboundHosts.length > 4 ? "note" : "clean",
        concern: "blast-radius:hosts",
        statement: `${script.path} contacts ${a.outboundHosts.length} host${a.outboundHosts.length === 1 ? "" : "s"}: ${a.outboundHosts.slice(0, 6).join(", ")}.`,
        evidence: `${script.path}, URL literals`,
        method: "file",
      });
    }
  }

  if (!release) {
    notChecked.push(
      "This repository publishes no GitHub release, so there were no release assets to compare the install path against.",
    );
  }

  return findings;
}

/**
 * Registry provenance: adjustment 3 from the validation report. For a target
 * with no installer to read, "does the registry entry bind this tarball to a
 * specific CI run" is the correct analogue of "does the installer check the
 * checksum". It cleanly separated @playwright/mcp from its typosquat.
 */
async function provenanceFindings(
  f: Fetcher,
  target: TargetRef,
  notChecked: NotChecked[],
): Promise<Finding[]> {
  const registry = target.registry;
  if (!registry) return [];
  const findings: Finding[] = [];

  if (registry.kind === "npm") {
    const info = await fetchNpm(f, registry.packageName);
    if (!info) return [];

    findings.push({
      check: "registry-provenance",
      severity: info.hasAttestations ? "clean" : "warning",
      concern: "registry-provenance:attestation",
      statement: info.hasAttestations
        ? `The npm entry for ${info.name}@${info.version} carries a provenance attestation, which ties the published tarball to the CI run that built it.`
        : `The npm entry for ${info.name}@${info.version} carries no provenance attestation. Nothing published alongside the tarball ties it to a specific build.`,
      evidence: `registry.npmjs.org/${info.name} dist.attestations`,
      method: "registry",
    });

    const viaOidc = /github actions|npm-oidc-no-reply/i.test(info.publishedBy ?? "");
    findings.push({
      check: "registry-provenance",
      severity: viaOidc ? "clean" : "note",
      concern: "registry-provenance:publisher",
      statement: viaOidc
        ? `The package was published by CI over OIDC rather than with a long-lived personal token.`
        : `The package was published by ${info.publishedBy ?? "an account the registry does not name"}, which indicates a long-lived publish token rather than CI over OIDC.`,
      evidence: `registry.npmjs.org/${info.name} _npmUser`,
      method: "registry",
    });

    // Trust-root concentration across the lineage, not a contributor count.
    // The insight the report kept: the shared maintainer set across
    // @playwright/mcp, playwright and playwright-core is what no single-package
    // scan produces.
    if (info.maintainers.length > 0) {
      findings.push({
        check: "trust-root",
        severity: info.maintainers.length === 1 ? "note" : "clean",
        concern: "trust-root:publish-rights",
        statement:
          info.maintainers.length === 1
            ? `One npm account can publish this package: ${info.maintainers[0]}. A single compromised publish token reaches every version.`
            : `${info.maintainers.length} npm accounts can publish this package: ${info.maintainers.slice(0, 5).join(", ")}.`,
        evidence: `registry.npmjs.org/${info.name} maintainers`,
        method: "registry",
      });
    }

    // Name-confusion neighbour, one extra call: the scoped/unscoped pair is
    // exactly the @playwright/mcp versus playwright-mcp case.
    const neighbour = neighbourName(info.name);
    if (neighbour && f.remaining > 4) {
      const other = await fetchNpm(f, neighbour);
      if (other) {
        findings.push({
          check: "registry-provenance",
          severity: "note",
          concern: "registry-provenance:name-confusion",
          statement: `A separate npm package named ${neighbour} also exists, published by ${other.maintainers.join(", ") || "an unnamed account"}${other.hasAttestations ? "" : " with no provenance attestation"}. Nothing in the name distinguishes which one you meant.`,
          evidence: `registry.npmjs.org/${neighbour}`,
          method: "registry",
        });
      }
    }
  } else {
    const info = await fetchPypi(f, registry.packageName);
    if (!info) return [];
    findings.push({
      check: "registry-provenance",
      severity: info.hasProvenance ? "clean" : "warning",
      concern: "registry-provenance:attestation",
      statement: info.hasProvenance
        ? `The PyPI entry for ${info.name} ${info.version} carries a PEP 740 attestation binding the files to the workflow that published them.`
        : `The PyPI entry for ${info.name} ${info.version} carries no PEP 740 attestation and no signature. Nothing binds the published files to a specific build.`,
      evidence: `pypi.org/pypi/${info.name}/json urls[].provenance`,
      method: "registry",
    });
    notChecked.push(
      "Whether the published package contents match this repository at this commit was not verified. That requires downloading and comparing the artefact.",
    );
  }

  return findings;
}

function neighbourName(name: string): string | null {
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    return slash === -1 ? null : name.slice(slash + 1);
  }
  return null;
}

async function trustRootFindings(
  f: Fetcher,
  owner: string,
  name: string,
  meta: Evidence["meta"],
): Promise<Finding[]> {
  const findings: Finding[] = [];

  // Ground truth about lineage, from the repository's own fields. The
  // validation report's premise correction: a secondary source described the
  // archived parent as if it were the fork.
  if (meta.archived) {
    findings.push({
      check: "trust-root",
      severity: "warning",
      concern: "trust-root:archived",
      statement: "This repository is archived. It is read-only and receives no fixes.",
      evidence: "GitHub repository archived field",
      method: "api",
    });
  }
  if (meta.isFork && meta.parentFullName) {
    findings.push({
      check: "trust-root",
      severity: "note",
      concern: "trust-root:lineage",
      statement: `This is a fork of ${meta.parentFullName}${meta.parentArchived ? ", which is itself archived" : ""}. Claims about the upstream project do not automatically describe this fork, and the reverse is also true.`,
      evidence: "GitHub repository fork and parent fields",
      method: "api",
    });
  }

  const days = Math.round((Date.now() - Date.parse(meta.pushedAt)) / 86_400_000);
  findings.push({
    check: "trust-root",
    severity: days > 365 ? "warning" : days > 180 ? "note" : "clean",
    concern: "trust-root:activity",
    statement: `The last push was ${days} day${days === 1 ? "" : "s"} ago (${meta.pushedAt.slice(0, 10)}).`,
    evidence: "GitHub repository pushed_at field",
    method: "api",
  });

  const contributors = await fetchContributors(f, owner, name);
  if (contributors) {
    const share = Math.round(contributors.topShare * 100);
    findings.push({
      check: "trust-root",
      severity: share >= 90 ? "note" : "clean",
      concern: "trust-root:concentration",
      statement:
        share >= 90
          ? `One account, ${contributors.topLogin}, accounts for about ${share}% of commits among the ${contributors.total} most active contributors. The trust root is effectively one person.`
          : `Among the ${contributors.total} most active contributors, the busiest (${contributors.topLogin}) accounts for about ${share}% of commits.`,
      evidence: "GitHub contributors API, first page",
      method: "api",
    });
  }

  return findings;
}
