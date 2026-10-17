import type { ExcerptHunk } from "../types";

/**
 * A finding's evidence string, read back into the file citations it makes.
 *
 * Evidence is written by the collectors as prose for a reader ("install.sh:114,129",
 * "package.json scripts", "GitHub contributors API, first page"). The report page
 * links each file citation to the source at the pinned commit, and reports stored
 * before excerpts existed carry nothing but that string, so the citation has to be
 * recoverable from it alone. Parsing is deliberately conservative: anything that is
 * not plainly a repository path stays plain text, because a link to a file that is
 * not there is a citation a reader cannot check.
 *
 * Paths reach evidence through `label()`, so a name that had to be rewritten to
 * render carries a marker with spaces in it and never parses as a path here. That
 * is the right outcome: the rewritten spelling is not the file's real name.
 */
export type CitationSegment =
  | { kind: "text"; text: string }
  | { kind: "file"; path: string; lines: number[] };

/** Evidence naming an API field, a registry document or the listing, never a file. */
const NON_FILE = /^(release |registry\.|pypi\.org\/|GitHub |file listing)/;

/** The qualifiers collectors append after a path, kept as plain text. */
const SUFFIX = /(?:, whole file|, environment reads|, URL literals| scripts| bin| build-system|, and \d+ more)$/;

const PART = /^([A-Za-z0-9._@/+!~-]+?)(?::(\d+(?:,\d+)*))?$/;

export function parseCitation(evidence: string): CitationSegment[] {
  const plain: CitationSegment[] = [{ kind: "text", text: evidence }];
  if (NON_FILE.test(evidence)) return plain;

  const tail = SUFFIX.exec(evidence)?.[0] ?? "";
  const head = evidence.slice(0, evidence.length - tail.length);
  const parts = head.split(", ");

  const segments: CitationSegment[] = [];
  for (const [i, part] of parts.entries()) {
    const m = PART.exec(part);
    if (!m || !isRepoPath(m[1]!)) return plain;
    if (i > 0) segments.push({ kind: "text", text: ", " });
    segments.push({
      kind: "file",
      path: m[1]!,
      lines: m[2] ? m[2].split(",").map(Number) : [],
    });
  }
  if (tail) segments.push({ kind: "text", text: tail });
  return segments;
}

function isRepoPath(path: string): boolean {
  if (path.startsWith("/") || path.endsWith("/")) return false;
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return false;
  // A bare word with neither a directory nor an extension is more likely a
  // name than a file, and a wrong link is worse than no link.
  return path.includes("/") || path.includes(".");
}

/** The file at the report's pinned commit on GitHub, anchored to its lines. */
export function sourceUrl(
  owner: string,
  name: string,
  sha: string,
  path: string,
  lines: number[] = [],
): string {
  const base = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/blob/${encodeURIComponent(sha)}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  if (lines.length === 0) return base;
  const lo = Math.min(...lines);
  const hi = Math.max(...lines);
  return lo === hi ? `${base}#L${lo}` : `${base}#L${lo}-L${hi}`;
}

/**
 * Bounds on what a report stores of the target's own bytes. An excerpt is a
 * reading aid next to a citation, not a mirror of the file: the link is where
 * the whole file lives.
 */
export const EXCERPT_CONTEXT = 2;
export const EXCERPT_MAX_LINES = 24;
export const EXCERPT_MAX_LINE_CHARS = 200;

// C0 controls other than tab, DEL, and the bidirectional overrides that can
// make code read differently from what it does (the "Trojan Source" shape).
// Replaced with a visible mark rather than dropped, so the excerpt never looks
// cleaner than the file.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f‎‏‪-‮⁦-⁩]/g;

/**
 * The cited lines with a little context, merged where they overlap and capped.
 * Text only, never interpreted: it is escaped at render time like any other
 * repository bytes.
 */
export function excerptLines(text: string, cited: number[]): ExcerptHunk[] {
  const all = text.split("\n");
  const wanted = [...new Set(cited)]
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= all.length)
    .sort((a, b) => a - b);

  const ranges: [number, number][] = [];
  for (const n of wanted) {
    const lo = Math.max(1, n - EXCERPT_CONTEXT);
    const hi = Math.min(all.length, n + EXCERPT_CONTEXT);
    const last = ranges[ranges.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else ranges.push([lo, hi]);
  }

  const hunks: ExcerptHunk[] = [];
  let budget = EXCERPT_MAX_LINES;
  for (const [lo, hi] of ranges) {
    if (budget <= 0) break;
    const end = Math.min(hi, lo + budget - 1);
    hunks.push({ start: lo, lines: all.slice(lo - 1, end).map(clean) });
    budget -= end - lo + 1;
  }
  return hunks;
}

function clean(line: string): string {
  const flat = line.replace(/\r$/, "").replace(HIDDEN, "�");
  return flat.length <= EXCERPT_MAX_LINE_CHARS
    ? flat
    : `${flat.slice(0, EXCERPT_MAX_LINE_CHARS - 1)}…`;
}
