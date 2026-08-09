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

export interface ManifestFacts {
  findings: Finding[];
  hasLifecycleScript: boolean;
  /** Entry points worth reading for the blast-radius pass. */
  entryPoints: string[];
  dependencies: string[];
}

export function analysePackageJson(path: string, source: string): ManifestFacts {
  let pkg: {
    scripts?: Record<string, string>;
    bin?: Record<string, string> | string;
    main?: string;
    dependencies?: Record<string, string>;
  };
  try {
    pkg = JSON.parse(source);
  } catch {
    return { findings: [], hasLifecycleScript: false, entryPoints: [], dependencies: [] };
  }

  const findings: Finding[] = [];
  const scripts = pkg.scripts ?? {};
  const present = LIFECYCLE.filter((name) => typeof scripts[name] === "string");

  if (present.length > 0) {
    findings.push({
      check: "install-path",
      severity: "warning",
      concern: "install-path:lifecycle-scripts",
      statement: `Installing this package runs ${present.length} lifecycle script${present.length === 1 ? "" : "s"} automatically: ${present.map((n) => `${n} (${truncate(scripts[n]!)})`).join("; ")}.`,
      evidence: `${path} scripts`,
      method: "file",
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

  const entryPoints: string[] = [];
  if (typeof pkg.main === "string") entryPoints.push(normalise(pkg.main));
  if (typeof bin === "string") entryPoints.push(normalise(bin));
  else for (const target of Object.values(bin ?? {})) entryPoints.push(normalise(target));
  for (const name of present) {
    const referenced = /(?:^|\s)([\w./-]+\.(?:js|mjs|cjs|ts|sh))/.exec(scripts[name]!);
    if (referenced) entryPoints.push(normalise(referenced[1]!));
  }

  return {
    findings,
    hasLifecycleScript: present.length > 0,
    entryPoints: [...new Set(entryPoints)].slice(0, 3),
    dependencies: Object.keys(pkg.dependencies ?? {}),
  };
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

function normalise(p: string): string {
  return p.replace(/^\.\//, "");
}
