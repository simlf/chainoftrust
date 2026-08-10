import type { Fetcher } from "./fetcher";

export interface NpmPackageInfo {
  name: string;
  version: string;
  /** npm Trusted Publishing leaves a SLSA provenance statement here. */
  hasAttestations: boolean;
  /**
   * The publishing account, name and email kept apart.
   *
   * `GitHub Actions <npm-oidc-no-reply@github.com>` means OIDC, not a PAT.
   * Both halves are target-chosen names that get clamped separately where they
   * are stated: formatting them into one `name <email>` string first would make
   * the clamp strip the angle brackets and the space, and the citation a reader
   * is meant to match against registry.npmjs.org would arrive run together.
   */
  publishedBy: { name: string; email: string | null } | null;
  maintainers: string[];
  repositoryUrl: string | null;
  hasIntegrity: boolean;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  binNames: string[];
}

interface NpmDoc {
  name: string;
  "dist-tags"?: { latest?: string };
  versions?: Record<string, NpmVersionDoc>;
  maintainers?: { name: string }[];
  repository?: { url?: string } | string;
}

interface NpmVersionDoc {
  version: string;
  dist?: { integrity?: string; attestations?: unknown };
  _npmUser?: { name?: string; email?: string };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  bin?: Record<string, string> | string;
  repository?: { url?: string } | string;
}

export async function fetchNpm(
  f: Fetcher,
  packageName: string,
): Promise<NpmPackageInfo | null> {
  const encoded = packageName.startsWith("@")
    ? `@${encodeURIComponent(packageName.slice(1))}`
    : encodeURIComponent(packageName);
  const doc = await f.json<NpmDoc>(`https://registry.npmjs.org/${encoded}`);
  if (!doc) return null;

  const latest = doc["dist-tags"]?.latest;
  const v = latest ? doc.versions?.[latest] : undefined;
  if (!latest || !v) return null;

  const user = v._npmUser;
  const bin = v.bin;

  return {
    name: doc.name,
    version: latest,
    hasAttestations: Boolean(v.dist?.attestations),
    publishedBy: user?.name ? { name: user.name, email: user.email ?? null } : null,
    maintainers: (doc.maintainers ?? []).map((m) => m.name),
    repositoryUrl: repoUrl(v.repository) ?? repoUrl(doc.repository),
    hasIntegrity: Boolean(v.dist?.integrity),
    scripts: v.scripts ?? {},
    dependencies: v.dependencies ?? {},
    binNames: typeof bin === "string" ? [doc.name] : Object.keys(bin ?? {}),
  };
}

export interface PypiPackageInfo {
  name: string;
  version: string;
  /** PEP 740 attestation, the PyPI analogue of npm provenance. */
  hasProvenance: boolean;
  /** Legacy PGP signature. False on every file is the common modern case. */
  hasSignature: boolean;
  repositoryUrl: string | null;
}

interface PypiDoc {
  info: {
    name: string;
    version: string;
    project_urls?: Record<string, string>;
    home_page?: string;
  };
  urls?: { has_sig?: boolean; provenance?: string | null }[];
}

export async function fetchPypi(
  f: Fetcher,
  packageName: string,
): Promise<PypiPackageInfo | null> {
  const doc = await f.json<PypiDoc>(
    `https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`,
  );
  if (!doc?.info) return null;

  const files = doc.urls ?? [];
  const urls = doc.info.project_urls ?? {};
  const repo =
    Object.entries(urls).find(([k]) => /source|repo|code|github/i.test(k))?.[1] ??
    doc.info.home_page ??
    null;

  return {
    name: doc.info.name,
    version: doc.info.version,
    hasProvenance: files.some((u) => Boolean(u.provenance)),
    hasSignature: files.some((u) => u.has_sig === true),
    repositoryUrl: repo && /github\.com/i.test(repo) ? repo : null,
  };
}

/**
 * OpenSSF Scorecard is cited, never recomputed. It measures maintenance
 * hygiene, which is a different question from install-time blast radius, and
 * the draft is explicit that we should not rebuild what it already publishes.
 */
export async function fetchScorecard(
  f: Fetcher,
  owner: string,
  name: string,
): Promise<{ score: number; date: string } | null> {
  const r = await f.json<{ score: number; date: string }>(
    `https://api.securityscorecards.dev/projects/github.com/${owner}/${name}`,
  );
  if (!r || typeof r.score !== "number") return null;
  return { score: r.score, date: r.date };
}

function repoUrl(field: { url?: string } | string | undefined): string | null {
  if (!field) return null;
  const raw = typeof field === "string" ? field : field.url;
  if (!raw) return null;
  const m = /github\.com[:/]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[#?].*)?$/.exec(raw);
  return m ? `${m[1]}/${m[2]}` : null;
}
