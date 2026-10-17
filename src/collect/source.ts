import { excerptLines, parseCitation } from "../lib/citation";
import type { Finding } from "../types";

/**
 * Attach a bounded excerpt of the cited code to each finding that cites a file
 * this analysis already read.
 *
 * Works only over `fetched`, the files the collectors downloaded inside the
 * fetch budget: nothing here reaches the network, so the excerpt costs no
 * request and widens no egress. A finding whose file was not read, or whose
 * citation names no line this can locate, gets no excerpt and the report page
 * shows the link alone.
 */
export function attachSources(
  findings: Finding[],
  fetched: { path: string; text: string }[],
): void {
  const byPath = new Map(fetched.map((file) => [file.path, file.text]));
  for (const finding of findings) {
    if (finding.method !== "file") continue;
    const files = parseCitation(finding.evidence).filter((s) => s.kind === "file");
    if (files.length !== 1) continue;
    const cited = files[0]!;
    const text = byPath.get(cited.path);
    if (text === undefined) continue;

    const lines = cited.lines.length > 0 ? cited.lines : locate(finding, text);
    if (lines.length === 0) continue;
    const excerpt = excerptLines(text, lines);
    if (excerpt.length === 0) continue;
    finding.source = { path: cited.path, lines, excerpt };
  }
}

/**
 * Lines for a citation that names a file but no line: a manifest field, or a
 * hook manifest whose finding quotes what it found. Matching what the finding
 * itself reports, never a guess at something nearby.
 */
function locate(finding: Finding, text: string): number[] {
  const all = text.split("\n");
  const where = (re: RegExp, from = 0, to = all.length - 1) =>
    all.flatMap((line, i) => (i >= from && i <= to && re.test(line) ? [i + 1] : [])).slice(0, 4);

  if (finding.evidence.endsWith(" scripts")) {
    // Lifecycle names are searched only inside the scripts object, so an
    // "install" key elsewhere in the manifest is not mistaken for one.
    const scripts = where(/"scripts"\s*:/).slice(0, 1);
    if (scripts.length === 0) return [];
    const from = scripts[0]! - 1;
    const lifecycle = where(/"(preinstall|install|postinstall|prepare)"\s*:/, from, objectEnd(all, from));
    return lifecycle.length > 0 ? lifecycle : scripts;
  }
  if (finding.evidence.endsWith(" bin")) return where(/"bin"\s*:/).slice(0, 1);
  if (finding.evidence.endsWith(" build-system")) return where(/build-backend\s*=/).slice(0, 1);

  const needle = finding.quote?.slice(0, 60);
  if (needle) {
    const at = all.findIndex((line) => line.includes(needle));
    if (at >= 0) return [at + 1];
  }
  return [];
}

/** Index of the line closing the first object opened on or after line `from`. */
function objectEnd(lines: string[], from: number): number {
  let depth = 0;
  let opened = false;
  let inString = false;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]!;
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (inString) {
        if (c === "\\") j++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") {
        depth++;
        opened = true;
      } else if (c === "}" && opened && --depth === 0) return i;
    }
  }
  return lines.length - 1;
}
