export type Severity = "clean" | "note" | "warning" | "critical";

export type Verdict = "clean" | "warnings" | "do-not-install";

export type CheckId =
  | "install-path"
  | "agent-config"
  | "registry-provenance"
  | "blast-radius"
  | "trust-root"
  | "unauditable-surface"
  | "prose";

/**
 * A single fact about how the target is distributed.
 *
 * Publication policy (DRAFT.md, "the disclosure split"): a finding states a
 * verifiable fact and cites where it came from. It never carries a judgement
 * adjective. "The installer does not read the checksums.txt its release
 * publishes" is a finding; "this repo looks shady" is not.
 */
export interface Finding {
  check: CheckId;
  severity: Severity;
  /**
   * Stable identity for the underlying concern, independent of how many files
   * exhibit it. A project shipping install.sh and install.ps1 states the same
   * defect twice; the verdict must count it once. Defaults to the check id.
   */
  concern?: string;
  /** The fact, stated so that a reader can disprove it. */
  statement: string;
  /**
   * Verbatim text from the target that the finding is about.
   *
   * Kept out of the statement on purpose. A statement is ours and travels in
   * the trusted part of the write-up prompt, so target bytes inside one would
   * be repository text speaking where the model is told the sender speaks. The
   * quote reaches the model only inside the nonce-fenced untrusted block, and
   * reaches the reader escaped on the verdict page.
   */
  quote?: string;
  /** Where the fact came from: a path, a path with a line, or an API field. */
  evidence: string;
  /**
   * How the fact was established, so the write-up model can be told not to
   * embellish a grep hit into a conclusion.
   */
  method: "file" | "api" | "registry" | "tree" | "prose";
}

/** Something the analysis deliberately did not establish. */
export type NotChecked = string;

export interface TargetRef {
  /** Canonical cache identity, e.g. `github:astral-sh/uv@<sha>`. */
  cacheKey: string;
  host: "github";
  owner: string;
  name: string;
  /** The ref as submitted (branch, tag, sha, or "" for the default branch). */
  requestedRef: string;
  /** The resolved commit SHA. This is what the verdict is pinned to. */
  sha: string;
  defaultBranch: string;
  /** npm or PyPI package this repository publishes, when one was identified. */
  registry?: RegistryRef;
}

export interface RegistryRef {
  kind: "npm" | "pypi";
  packageName: string;
  version: string;
}

export interface RepoMeta {
  fullName: string;
  description: string | null;
  isFork: boolean;
  parentFullName: string | null;
  parentArchived: boolean | null;
  archived: boolean;
  stars: number;
  openIssues: number;
  pushedAt: string;
  createdAt: string;
  homepage: string | null;
  license: string | null;
}

export interface TreeEntry {
  path: string;
  size: number;
}

export interface ReleaseAsset {
  name: string;
  size: number;
}

export interface ReleaseInfo {
  tag: string;
  assets: ReleaseAsset[];
}

/**
 * Everything the deterministic collectors established, plus the prose excerpts
 * they deliberately pulled in. This is the only thing the model ever sees.
 */
export interface Evidence {
  target: TargetRef;
  meta: RepoMeta;
  findings: Finding[];
  notChecked: NotChecked[];
  /**
   * Verbatim excerpts from READMEs, security policies and maintainer notes.
   * Untrusted input: quoted for the reader, never followed as instructions.
   */
  proseExcerpts: ProseExcerpt[];
  scorecard?: { score: number; date: string };
  stats: {
    filesInTree: number;
    totalBytes: number;
    opaqueBytes: number;
    filesFetched: number;
    fetchBudgetExhausted: boolean;
  };
}

export interface ProseExcerpt {
  path: string;
  /** Why the collector decided this passage was worth carrying. */
  reason: string;
  text: string;
}

export interface Report {
  target: TargetRef;
  verdict: Verdict;
  findings: Finding[];
  notChecked: NotChecked[];
  proseExcerpts: ProseExcerpt[];
  stats: Evidence["stats"];
  scorecard?: { score: number; date: string };
  generatedAt: string;
}

export interface StoredVerdict {
  report: Report;
  writeup: string | null;
  writeupModel: string | null;
  cached: boolean;
  createdAt: number;
}
