import { label, labelList } from "../lib/label";
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
      evidence: `${label(path)} scripts`,
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
      evidence: `${label(path)} scripts`,
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
      statement: `The package puts ${binNames.length} executable${binNames.length === 1 ? "" : "s"} on PATH: ${labelList(binNames)}.`,
      evidence: `${label(path)} bin`,
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
      statement: `The Python build backend is ${label(backend[1]!)}. A pip install runs this backend, which compiles or generates whatever the backend is configured to produce.`,
      evidence: `${label(path)} build-system`,
      method: "file",
    },
  ];
}

/**
 * The registry package a repository says it publishes, read from the root
 * manifest.
 *
 * A private package.json publishes nothing, so it names nothing. The name is
 * only a claim: anyone can write `"name": "react"` into a manifest, so the
 * caller must confirm the registry entry points back at this repository before
 * attributing anything the registry says about that name to it.
 */
export function declaredPackage(
  files: { path: string; text: string }[],
): { kind: "npm" | "pypi"; packageName: string } | null {
  const pkg = files.find((file) => file.path === "package.json");
  if (pkg) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(pkg.text);
    } catch {
      parsed = null;
    }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const { name, private: isPrivate } = parsed as { name?: unknown; private?: unknown };
      if (isPrivate !== true && typeof name === "string" && NPM_NAME.test(name)) {
        return { kind: "npm", packageName: name };
      }
    }
  }

  const pyproject = files.find((file) => file.path === "pyproject.toml");
  if (pyproject) {
    // Only the [project] table's own name, up to the next table header.
    const table = /^\[project\][^\S\n]*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(pyproject.text);
    const name = table ? /^name\s*=\s*["']([^"']+)["']/m.exec(table[1]!)?.[1] : undefined;
    if (name && PYPI_NAME.test(name)) return { kind: "pypi", packageName: name };
  }

  return null;
}

const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function truncate(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= 80 ? flat : `${flat.slice(0, 79)}…`;
}

