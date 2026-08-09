export interface ParsedInput {
  kind: "github" | "npm" | "pypi";
  owner: string;
  name: string;
  ref: string;
}

export class InvalidTarget extends Error {}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const REF = /^[A-Za-z0-9._\/-]{0,255}$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,100}\/)?[a-z0-9][a-z0-9._-]{0,100}$/;
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,100})$/;

/**
 * Turn whatever a human pasted into a target we are willing to fetch.
 *
 * Deliberately strict. Anything not matched here is refused rather than
 * normalised, because the parsed values are interpolated into URLs and a
 * permissive parser is how an allowlist gets bypassed.
 */
export function parseTarget(raw: string): ParsedInput {
  const input = raw.trim();
  if (!input) throw new InvalidTarget("Enter a repository or package URL.");
  if (input.length > 400) throw new InvalidTarget("That URL is too long.");

  // npm:pkg / pypi:pkg shorthands
  const scheme = /^(npm|pypi):(.+)$/i.exec(input);
  if (scheme) {
    const kind = scheme[1]!.toLowerCase() as "npm" | "pypi";
    return packageTarget(kind, scheme[2]!.trim());
  }

  // owner/repo shorthand, with no scheme and no dots in the owner
  const short = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(input);
  if (short && !input.includes(":")) {
    return githubTarget(short[1]!, short[2]!, "");
  }

  // git@github.com:owner/repo.git
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(input);
  if (ssh) return githubTarget(ssh[1]!, ssh[2]!, "");

  let url: URL;
  try {
    url = new URL(input.includes("://") ? input : `https://${input}`);
  } catch {
    throw new InvalidTarget("That does not look like a URL.");
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (host === "github.com") {
    if (segments.length < 2) {
      throw new InvalidTarget("A GitHub URL needs an owner and a repository.");
    }
    const owner = segments[0]!;
    const name = segments[1]!.replace(/\.git$/, "");
    // .../tree/<ref> and .../commit/<sha> both pin the analysis.
    let ref = "";
    if ((segments[2] === "tree" || segments[2] === "commit") && segments[3]) {
      ref = segments.slice(3).join("/");
    }
    return githubTarget(owner, name, ref);
  }

  if (host === "npmjs.com") {
    const idx = segments.indexOf("package");
    if (idx === -1 || !segments[idx + 1]) {
      throw new InvalidTarget("That npm URL does not name a package.");
    }
    return packageTarget("npm", segments.slice(idx + 1).join("/"));
  }

  if (host === "pypi.org") {
    const idx = segments.indexOf("project");
    if (idx === -1 || !segments[idx + 1]) {
      throw new InvalidTarget("That PyPI URL does not name a project.");
    }
    return packageTarget("pypi", segments[idx + 1]!);
  }

  throw new InvalidTarget(
    "Only github.com repositories and npm or PyPI packages can be analysed.",
  );
}

function githubTarget(owner: string, name: string, ref: string): ParsedInput {
  if (!OWNER.test(owner)) throw new InvalidTarget("That owner name is not valid.");
  if (!REPO.test(name)) throw new InvalidTarget("That repository name is not valid.");
  if (!REF.test(ref)) throw new InvalidTarget("That ref is not valid.");
  return { kind: "github", owner, name, ref };
}

function packageTarget(kind: "npm" | "pypi", rawName: string): ParsedInput {
  const name = rawName.replace(/\/$/, "");
  const pattern = kind === "npm" ? NPM_NAME : PYPI_NAME;
  if (!pattern.test(name)) throw new InvalidTarget("That package name is not valid.");
  return { kind, owner: "", name, ref: "" };
}

/**
 * Canonical, URL-safe identity used as the D1 primary key.
 *
 * A registry submission is a different analysis from a bare repository
 * submission at the same commit: only the former runs the registry-provenance
 * check. They therefore occupy distinct rows, or the first one analysed would
 * silently be served for the other with a check missing and nothing saying so.
 */
export function cacheKeyFor(
  owner: string,
  name: string,
  sha: string,
  registry?: { kind: "npm" | "pypi"; packageName: string },
): string {
  const base = `github:${owner.toLowerCase()}/${name.toLowerCase()}@${sha}`;
  return registry ? `${base}#${registry.kind}:${registry.packageName.toLowerCase()}` : base;
}

/** The `#npm:pkg` suffix of a cache key, as carried in a verdict URL. */
export function registryQualifier(raw: string): { kind: "npm" | "pypi"; packageName: string } | null {
  const m = /^(npm|pypi):(.+)$/i.exec(raw.trim());
  if (!m) return null;
  const kind = m[1]!.toLowerCase() as "npm" | "pypi";
  const name = m[2]!;
  const pattern = kind === "npm" ? NPM_NAME : PYPI_NAME;
  if (!pattern.test(name.toLowerCase())) return null;
  return { kind, packageName: name };
}
