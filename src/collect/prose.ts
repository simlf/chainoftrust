import { label, labelList } from "../lib/label";
import type { Finding, NotChecked, ProseExcerpt } from "../types";

/**
 * Deliberate prose extraction.
 *
 * Binding adjustment 4 from the validation report: several of the highest-value
 * findings came from reading prose, not from parsing structured data. A
 * maintainer's own note admitting fabricated performance metrics. A
 * SECURITY.md explicitly disclaiming install-time tampering. A fork's README
 * correcting a claim about its archived parent. A hooks.json self-describing as
 * an unaudited shim.
 *
 * "A small model given a bundle that does not include those prose excerpts
 * would miss them entirely." So the collector goes looking, with a fixed
 * lexicon, and quotes what it finds verbatim with a path.
 *
 * Everything returned here is untrusted text from the target. It is quoted for
 * a human to read. It is never treated as an instruction, by this code or by
 * the write-up prompt that receives it.
 */

interface Probe {
  pattern: RegExp;
  reason: string;
  severity: Finding["severity"] | null;
}

const PROBES: Probe[] = [
  {
    // No trailing \b: several of these end on a deliberately truncated stem
    // ("vulnerabilit") so that they match both singular and plural, and a word
    // boundary after a stem can never match.
    pattern:
      /(is\s+not\s+a\s+security\s+boundary|not\s+considered\s+(a\s+)?vulnerabilit|out\s+of\s+scope\s+for\s+(our\s+)?security|do\s+not\s+consider\s+.{0,40}\s+a\s+vulnerability)/i,
    reason: "the project states a limit on what its security policy covers",
    severity: "warning",
  },
  {
    pattern: /\b(RCE[- ]equivalent|arbitrary\s+(code|javascript|shell)\s+execution|unsafe\b.{0,30}\bexecutes?)\b/i,
    reason: "the project describes a capability it ships as executing arbitrary code",
    severity: "warning",
  },
  {
    pattern: /\b(man[- ]in[- ]the[- ]middle|MITM)\b/i,
    reason: "the project's own documentation discusses download tampering",
    severity: "note",
  },
  {
    pattern:
      /(\bunmaintained|\bno\s+longer\s+maintained|\babandoned\b|\bdeprecated\s+project|\barchived\s+repositor|\bactively\s+maintained\s+fork|\bpicked\s+it\s+up\b)/i,
    reason: "the project makes a claim about its own maintenance status",
    severity: "note",
  },
  {
    pattern:
      /\b(fabricated|made[- ]up|not\s+actually\s+measured|pseudo[- ]?random|mock\s+(embeddings?|data)|placeholder\s+(metric|benchmark)|does\s+not\s+actually)\b/i,
    reason: "a maintainer note questions a claim the project makes elsewhere",
    severity: "warning",
  },
  {
    pattern:
      /\b(telemetry|analytics|usage\s+data|phone[s]?\s+home|opt[- ]out\s+of\s+(data|tracking))\b/i,
    reason: "the project documents data it sends somewhere",
    severity: "note",
  },
  {
    pattern:
      /\b(tell\s+your\s+(claude|agent|assistant)|let\s+(it|your\s+agent)\s+set\s+(it\s+)?up|llms?-install|install\s+this\s+MCP\s+from)\b/i,
    reason: "the project documents an install path meant to be followed by an agent, not a human",
    severity: "warning",
  },
  {
    // Requires an actual argument between the command and the pipe (a URL, a
    // flag, anything but bare whitespace) so a sentence that only names the
    // pattern as a category ("`curl | sh` installers") does not match: that is
    // a mention, not an instruction to run one.
    pattern: /\b(curl|wget|irm)\b\s+[^\s|][^\n]{2,80}\|\s*(sudo\s+)?(ba|z)?sh\b/i,
    reason: "the documentation advertises piping a downloaded script straight into a shell",
    severity: "warning",
  },
  {
    pattern: /\b(sudo\s+(bash|sh|install|cp|mv)|requires?\s+root|run\s+as\s+root)\b/i,
    reason: "the documentation says the install needs root",
    severity: "note",
  },
  {
    pattern: /\b(checksum|sha256sum|gpg\s+--verify|verify\s+the\s+signature|minisign|cosign)\b/i,
    reason: "the documentation discusses verifying what it downloads",
    severity: null,
  },
];

const MAX_EXCERPT_CHARS = 320;
const MAX_EXCERPTS_PER_FILE = 4;
const MAX_EXCERPTS_TOTAL = 12;

export interface ProseScan {
  excerpts: ProseExcerpt[];
  findings: Finding[];
  notChecked: NotChecked[];
}

/**
 * What the file listing said about prose, which is a different question from
 * what was read.
 *
 * `candidates` are the prose files the listing actually names, and `complete`
 * says whether that listing was read in full. Only an absence the listing
 * establishes can be stated as a finding: a file that exists but was not
 * fetched, because the per-analysis file cap or the fetch budget ran out first,
 * is a gap in this report and belongs in notChecked.
 */
export interface ProseListing {
  candidates: string[];
  complete: boolean;
}

/**
 * Files worth reading in full, in priority order. Fetching is capped upstream.
 *
 * CLAUDE.md and AGENTS.md are listed at both the repository root and nested
 * under .claude/, the project's Claude Code config directory: strudel-claude
 * kept its persona/instruction file at .claude/CLAUDE.md instead of root, and
 * this exact-match list missed it (agent-config.ts's presence check is a
 * regex and already covers any depth; this list is not, so each real location
 * needs its own entry).
 */
export const PROSE_CANDIDATES = [
  "SECURITY.md",
  "README.md",
  ".github/SECURITY.md",
  "docs/SECURITY.md",
  "CONTRIBUTING.md",
  "CLAUDE.md",
  "AGENTS.md",
  ".claude/CLAUDE.md",
  ".claude/AGENTS.md",
  "readme.md",
  "Readme.md",
  "README.rst",
  "README",
];

export function scanProse(
  files: { path: string; text: string }[],
  listing: ProseListing = { candidates: [], complete: false },
): ProseScan {
  const excerpts: ProseExcerpt[] = [];
  const findings: Finding[] = [];
  const notChecked: NotChecked[] = [];
  const seenReasons = new Set<string>();
  // A README that says the same sentence twice, as an install line repeated per
  // platform section does, would otherwise be quoted twice under the same
  // heading and twice in prose_excerpts.
  const seenExcerpts = new Set<string>();

  for (const file of files) {
    let perFile = 0;
    const sentences = splitSentences(file.text);

    for (const sentence of sentences) {
      if (perFile >= MAX_EXCERPTS_PER_FILE) break;
      if (excerpts.length >= MAX_EXCERPTS_TOTAL) break;

      for (const probe of PROBES) {
        if (!probe.pattern.test(sentence)) continue;

        const text = trim(sentence);
        const excerptKey = `${file.path}::${text}`;
        if (seenExcerpts.has(excerptKey)) break;
        seenExcerpts.add(excerptKey);
        excerpts.push({ path: file.path, reason: probe.reason, text });
        perFile++;

        const key = `${probe.reason}::${file.path}`;
        if (probe.severity && !seenReasons.has(key)) {
          seenReasons.add(key);
          findings.push({
            check: "prose",
            severity: probe.severity,
            concern: `prose:${probe.reason}`,
            statement: `${capitalise(probe.reason)}. The sentence it says that in is quoted verbatim, from ${label(file.path)}.`,
            evidence: label(file.path),
            method: "prose",
          });
        }
        break;
      }
    }
  }

  const read = files.map((file) => file.path);
  const unread = listing.candidates.filter((path) => !read.includes(path));

  // An absence is only a finding when the listing that establishes it was read
  // in full and names no prose file at all. Every other shape is a limit of
  // this report rather than a fact about the repository, and says which files
  // were read and which were not.
  if (read.length === 0 && unread.length === 0 && listing.complete) {
    findings.push({
      check: "prose",
      severity: "note",
      concern: "prose:absent",
      statement:
        "The file listing at the analysed commit names no README, security policy or contributing guide.",
      evidence: "file listing at the analysed commit",
      method: "prose",
    });
  } else if (unread.length > 0) {
    notChecked.push(
      read.length === 0
        ? `No prose was read at the analysed commit, so nothing any of it says was searched for. The file listing names ${labelList(unread)}, which this analysis did not read.`
        : `Prose was read from ${labelList(read)}. The file listing also names ${labelList(unread)}, which this analysis did not read, so nothing it says was searched for.`,
    );
  } else if (read.length === 0) {
    notChecked.push(
      "No README, security policy or contributing guide was read at the analysed commit, and the file listing that would say whether one is present was not read in full, so this report cannot say whether the project has one.",
    );
  }

  return { excerpts, findings, notChecked };
}

function splitSentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/\n/g, " "))
    .split(/(?<=[.!?:])\s+|\n{2,}|\n(?=[-*#|>])/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 20 && s.length <= 600)
    .filter((s) => !isLinkListEntry(s));
}

/**
 * A README's "integrations" or "community projects" list describes other
 * people's software. Reading "analytics and PII masking" out of a link to a
 * third-party observability tool and reporting it as this project's telemetry
 * is a false positive, and false positives attached to named public projects
 * are the thing that would destroy this product's credibility fastest.
 */
function isLinkListEntry(sentence: string): boolean {
  return /^[-*+]\s*\[[^\]]+\]\(\s*https?:\/\//.test(sentence);
}

function trim(s: string): string {
  return s.length <= MAX_EXCERPT_CHARS ? s : `${s.slice(0, MAX_EXCERPT_CHARS - 1)}…`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
