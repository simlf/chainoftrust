import type { Finding } from "../types";

/**
 * Package-manifest lifecycle scripts.
 *
 * Adjustment 1 from the validation report: this was negative on seven of eight
 * targets and the one positive is Socket's best-covered signal. It is demoted
 * to a single cheap field inside the install path rather than a named pillar
 * with its own verdict paragraph. It stays because the one positive was real.
 */

const LIFECYCLE = ["preinstall", "install", "postinstall", "prepare"] as const;

export function analysePackageJson(path: string, source: string): Finding[] {
  // Target content is untrusted input, and a manifest holding the four bytes
  // null parses without throwing. Nothing a repository ships may decide the
  // response code, so anything that is not an object yields no findings.
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];

  const pkg = parsed as {
    scripts?: Record<string, string>;
    bin?: Record<string, string> | string;
  };

  const findings: Finding[] = [];
  const scripts = pkg.scripts ?? {};
  const present = LIFECYCLE.filter((name) => typeof scripts[name] === "string");

  if (present.length > 0) {
    findings.push({
      check: "install-path",
      severity: "warning",
      concern: "install-path:lifecycle-scripts",
      statement: `Installing this package runs ${present.length} lifecycle script${present.length === 1 ? "" : "s"} automatically: ${present.join(", ")}. What they run is quoted verbatim.`,
      evidence: `${path} scripts`,
      method: "file",
      quote: present.map((n) => `${n}: ${truncate(scripts[n]!)}`).join("; "),
    });
  } else {
    findings.push({
      check: "install-path",
      severity: "clean",
      concern: "install-path:lifecycle-scripts",
      statement:
        "The package manifest declares no preinstall, install, postinstall or prepare script, so a package manager install does not execute code from this package.",
      evidence: `${path} scripts`,
      method: "file",
    });
  }

  const bin = pkg.bin;
  const binNames = typeof bin === "string" ? ["(package name)"] : Object.keys(bin ?? {});
  if (binNames.length > 0) {
    findings.push({
      check: "install-path",
      severity: "note",
      concern: "install-path:executables",
      statement: `The package puts ${binNames.length} executable${binNames.length === 1 ? "" : "s"} on PATH: ${binNames.join(", ")}.`,
      evidence: `${path} bin`,
      method: "file",
    });
  }

  return findings;
}

/** Python packaging: the analogous question is whether the build is declarative. */
export function analysePyproject(path: string, source: string): Finding[] {
  const backend = /build-backend\s*=\s*["']([^"']+)["']/.exec(source);
  if (!backend) return [];
  return [
    {
      check: "install-path",
      severity: "note",
      concern: "install-path:build-backend",
      statement: `The Python build backend is ${backend[1]}. A pip install runs this backend, which compiles or generates whatever the backend is configured to produce.`,
      evidence: `${path} build-system`,
      method: "file",
    },
  ];
}

function truncate(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= 80 ? flat : `${flat.slice(0, 79)}…`;
}

