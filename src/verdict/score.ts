import type { Evidence, Report, Severity, Verdict } from "../types";

const WEIGHT: Record<Severity, number> = {
  clean: 0,
  note: 0,
  warning: 1,
  critical: 3,
};

/**
 * The verdict is arithmetic over distinct concerns, not a judgement call, so
 * the same commit always produces the same tier and anyone can recompute it.
 *
 *   0        clean
 *   1 to 8   warnings
 *   9+       do not install
 *
 * Scoring counts each concern once at its highest severity, not once per
 * finding. Ollama ships install.sh and install.ps1, and a per-finding score
 * counted "downloads without verifying", "ignores its own published checksums"
 * and "pipes into a shell" twice each, which pushed a 178,000-star mainstream
 * project over the do-not-install line on nothing but platform coverage. The
 * question the tier answers is how many distinct things are wrong, not how many
 * files exhibit them.
 *
 * The threshold is deliberately hard to reach. All eight targets in the
 * validation landed on clean or warnings, including the one whose maintainers
 * had admitted fabricating a marketed metric. A tier that fires easily is a
 * tier nobody believes, and a wrong "do not install" attached to a named public
 * project is the failure this product cannot afford.
 */
export function scoreVerdict(findings: Evidence["findings"]): Verdict {
  const worst = new Map<string, Severity>();
  for (const f of findings) {
    const key = f.concern ?? f.check;
    const current = worst.get(key);
    if (current === undefined || WEIGHT[f.severity] > WEIGHT[current]) {
      worst.set(key, f.severity);
    }
  }

  let score = 0;
  for (const severity of worst.values()) score += WEIGHT[severity];

  if (score === 0) return "clean";
  if (score < 9) return "warnings";
  return "do-not-install";
}

export function buildReport(evidence: Evidence, now: Date): Report {
  return {
    target: evidence.target,
    verdict: scoreVerdict(evidence.findings),
    findings: dedupe(evidence.findings).sort(
      (a, b) => rank(b.severity) - rank(a.severity),
    ),
    notChecked: evidence.notChecked,
    proseExcerpts: evidence.proseExcerpts,
    stats: evidence.stats,
    ...(evidence.scorecard ? { scorecard: evidence.scorecard } : {}),
    generatedAt: now.toISOString(),
  };
}

function rank(s: Severity): number {
  return { critical: 3, warning: 2, note: 1, clean: 0 }[s];
}

/**
 * Two hook manifests in one repository produce the same sentence twice. Keep
 * the first and fold the second's citation into it, so the reader sees one
 * statement with both sources rather than the same paragraph repeated.
 */
function dedupe(findings: Evidence["findings"]): Evidence["findings"] {
  const byStatement = new Map<string, Evidence["findings"][number]>();
  for (const f of findings) {
    const existing = byStatement.get(f.statement);
    if (!existing) {
      byStatement.set(f.statement, { ...f });
      continue;
    }
    if (!existing.evidence.includes(f.evidence)) {
      existing.evidence = `${existing.evidence}, ${f.evidence}`;
    }
  }
  return [...byStatement.values()];
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  clean: "Clean",
  warnings: "Warnings",
  "do-not-install": "Do not install",
};

export const VERDICT_SUMMARY: Record<Verdict, string> = {
  clean: "Nothing in the install path or the agent-configuration surface stood out.",
  warnings: "Some of what installing this would do is worth reading before you agree to it.",
  "do-not-install":
    "Several install-time behaviours here are worth refusing until they are explained.",
};
