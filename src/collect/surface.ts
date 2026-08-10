import { label, labelList } from "../lib/label";
import type { Finding, TreeEntry } from "../types";

const BINARY_EXT =
  /\.(exe|dll|so|dylib|a|o|node|wasm|bin|class|jar|pyd|pyc|whl|zip|tar|tgz|gz|xz|zst|7z|dmg|pkg|msi|deb|rpm|apk|jpg|jpeg|png|gif|webp|ico|pdf|woff2?|ttf|otf|mp4|mp3)$/i;

const EXECUTABLE_BINARY =
  /\.(exe|dll|so|dylib|a|o|node|wasm|bin|class|jar|pyd|whl|dmg|pkg|msi|deb|rpm|apk)$/i;

/**
 * A middle category the binary-or-not framing does not have: a single very
 * large generated JavaScript file. playwright-core's coreBundle.js is 3.4MB of
 * plain text flattened from hundreds of modules. Technically readable,
 * practically un-diffable against source without a build toolchain.
 */
const BUNDLE_HINT = /(^|\/)(dist|build|lib|out|bundle|vendor)\/.*\.(js|mjs|cjs)$/i;
const BUNDLE_MIN_BYTES = 512 * 1024;

export interface SurfaceCensus {
  findings: Finding[];
  totalBytes: number;
  opaqueBytes: number;
}

/**
 * Byte census of what a user would actually receive.
 *
 * The report is explicit that this rarely moves a verdict tier on its own and
 * should be budgeted as a disclosure line rather than a scored dimension. It is
 * nearly free to compute from the file listing, and it is the difference
 * between a report that says "clean" and one that says what it could not read.
 */
export function censusSurface(entries: TreeEntry[], treeTruncated: boolean): SurfaceCensus {
  const findings: Finding[] = [];
  let totalBytes = 0;
  let opaqueBytes = 0;
  let binaryCount = 0;
  const executables: string[] = [];
  const bundles: TreeEntry[] = [];

  for (const entry of entries) {
    totalBytes += entry.size;
    if (BINARY_EXT.test(entry.path)) {
      opaqueBytes += entry.size;
      binaryCount++;
      if (EXECUTABLE_BINARY.test(entry.path)) executables.push(entry.path);
    } else if (BUNDLE_HINT.test(entry.path) && entry.size >= BUNDLE_MIN_BYTES) {
      opaqueBytes += entry.size;
      bundles.push(entry);
    }
  }

  const pct = totalBytes > 0 ? Math.round((opaqueBytes / totalBytes) * 100) : 0;

  if (executables.length > 0) {
    findings.push({
      check: "unauditable-surface",
      severity: "note",
      concern: "unauditable-surface:committed-binaries",
      statement: `${executables.length} compiled or packaged artefact${executables.length === 1 ? " is" : "s are"} committed to the repository. Reading the source does not tell you what these contain.`,
      evidence: labelList(executables, 3),
      method: "tree",
    });
  }

  for (const bundle of bundles.slice(0, 2)) {
    findings.push({
      check: "unauditable-surface",
      severity: "note",
      concern: "unauditable-surface:generated-bundle",
      statement: `${label(bundle.path)} is a ${Math.round(bundle.size / 1024)} KB generated JavaScript file. It is plain text but cannot be matched line for line against its sources without running the project's own build.`,
      evidence: label(bundle.path),
      method: "tree",
    });
  }

  findings.push({
    check: "unauditable-surface",
    severity: pct >= 50 ? "note" : "clean",
    concern: "unauditable-surface:census",
    statement:
      opaqueBytes === 0
        ? `Every one of the ${entries.length} files in the repository is readable text.`
        : `${pct}% of the repository by size (${binaryCount + bundles.length} of ${entries.length} files) is binary or generated and cannot be reviewed by reading.`,
    evidence: `file listing at the analysed commit${treeTruncated ? ", truncated by GitHub" : ""}`,
    method: "tree",
  });

  return { findings, totalBytes, opaqueBytes };
}
