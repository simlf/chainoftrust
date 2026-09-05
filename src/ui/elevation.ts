import type { Finding, Report, Severity } from "../types";
import { esc } from "./layout";

/**
 * The install-path elevation: the direction D mock's report centerpiece,
 * deferred out of the initial port (see the comment near chainOfTrust in
 * ./pages.ts). The mock drew a surveyed engineering elevation: release,
 * installer, binary, daemon, with the checksum path severed where it dies
 * and "not checked" as a hatched region.
 *
 * Report carries no shaped install-path type (source, installer, targets,
 * severed verification paths), so this derives the four stages from the
 * same install-path findings the annotation list already renders, keyed by
 * concern id, exactly the way chainOfTrust derives its six-check chain from
 * severities rather than from a purpose-built shape.
 *
 * index.ts's installPathFindings pushes concern "install-path:sudo" exactly
 * once per install script it reads, clean or not, unconditionally, so its
 * mere presence is the anchor for "an installer exists to draw at all".
 * Every other per-script concern used here (verification, execution,
 * residency) is computed the same unconditional way over the same script
 * text, so a concern's absence given that anchor is a true "checked, found
 * nothing" rather than "not established" — the collectors do not skip a
 * script once one is found, they analyse the whole thing every time. That
 * is what lets this module treat a missing warning as clean instead of
 * dashing it as unmeasured.
 */

const SEVERITY_RANK: Record<Severity, number> = { clean: 0, note: 1, warning: 2, critical: 3 };

const COLORS = {
  ok: "#9ff0c8",
  warn: "#ffd27a",
  crit: "#ff9d8a",
  dim: "#9dc0da",
};

function colorFor(sev: Severity): string {
  if (sev === "critical") return COLORS.crit;
  if (sev === "warning") return COLORS.warn;
  return COLORS.ok;
}

const CHECKSUM_CONCERNS = [
  "install-path:verification",
  "install-path:verification-absent",
  "install-path:verification-unreachable",
  "install-path:verification-skippable",
  "install-path:unused-integrity-assets",
];
const EXECUTION_CONCERNS = ["install-path:executes-download", "install-path:pipe-to-shell"];
const RESIDENCY_CONCERNS = ["install-path:residency"];
const SUDO_CONCERN = "install-path:sudo";
const NO_RELEASE = /publishes no GitHub release/;

interface Slot {
  severity: Severity;
  /** 1-based position in Report.findings, matching the annotation list's own numbering. */
  index?: number;
}

function worstSlot(findings: Finding[], concerns: string[]): Slot {
  let best: Finding | undefined;
  for (const f of findings) {
    if (f.check !== "install-path" || !f.concern || !concerns.includes(f.concern)) continue;
    if (!best || SEVERITY_RANK[f.severity] > SEVERITY_RANK[best.severity]) best = f;
  }
  if (!best) return { severity: "clean" };
  return { severity: best.severity, index: findings.indexOf(best) + 1 };
}

function calloutGlyph(x: number, y: number, slot: Slot): string {
  if (slot.severity === "clean" || slot.index === undefined) return "";
  const color = colorFor(slot.severity);
  return `<circle cx="${x}" cy="${y}" r="9" fill="none" stroke="${color}"/><text x="${x}" y="${y + 3}" text-anchor="middle" fill="${color}" stroke="none" font-size="9" font-weight="700">${slot.index}</text>`;
}

/** The same broken-chain-link metaphor chainOfTrust draws, at the point the checksum path dies. */
function brokenLinkGlyph(cx: number, cy: number, color: string): string {
  return `<g stroke="${color}">
<path d="M ${cx - 22} ${cy - 14} H ${cx - 43} A 14 14 0 0 0 ${cx - 43} ${cy + 14} H ${cx - 24}"/>
<path d="M ${cx - 14} ${cy - 14} H ${cx + 7} A 14 14 0 0 1 ${cx + 7} ${cy + 14} H ${cx - 12}"/>
<line x1="${cx - 18}" y1="${cy - 8}" x2="${cx - 12}" y2="${cy - 12}"/>
<line x1="${cx - 17}" y1="${cy + 8}" x2="${cx - 11}" y2="${cy + 12}"/>
</g>`;
}

const STAGE_X = [20, 240, 460, 680];
const STAGE_W = 140;
const STAGE_H = 56;
const STAGE_Y = 76;
const MID_Y = STAGE_Y + STAGE_H / 2;

function stageBox(x: number, label: string, sub: string, color: string, hatched: boolean): string {
  const fill = hatched ? "url(#elev-hatch)" : "none";
  return `<rect x="${x}" y="${STAGE_Y}" width="${STAGE_W}" height="${STAGE_H}" fill="${fill}" stroke="${color}"/>
<text x="${x + STAGE_W / 2}" y="${STAGE_Y + 22}" text-anchor="middle" fill="${color}" font-size="10" font-weight="700" letter-spacing="1">${esc(label)}</text>
${sub ? `<text x="${x + STAGE_W / 2}" y="${STAGE_Y + 38}" text-anchor="middle" fill="${color}" font-size="8" letter-spacing="1" opacity=".85">${esc(sub)}</text>` : ""}`;
}

export function elevationSchematic(r: Report): string {
  const findings = r.findings;
  const hasInstaller = findings.some(
    (f) => f.check === "install-path" && f.concern === SUDO_CONCERN,
  );
  // Nothing to draw an installer against. Per the D fallback: the report
  // renders without this panel, never with an empty frame.
  if (!hasInstaller) return "";

  const releaseExists = !r.notChecked.some((n) => NO_RELEASE.test(n));
  const checksum = worstSlot(findings, CHECKSUM_CONCERNS);
  const execution = worstSlot(findings, EXECUTION_CONCERNS);
  const residency = worstSlot(findings, RESIDENCY_CONCERNS);
  const sudo = worstSlot(findings, [SUDO_CONCERN]);

  const checksumSevered = checksum.severity !== "clean";

  const releaseColor = COLORS.dim;
  const installerColor = colorFor(sudo.severity);
  const binaryColor = colorFor(execution.severity);
  const daemonColor = colorFor(residency.severity);

  const edgeMidX = [
    (STAGE_X[0]! + STAGE_W + STAGE_X[1]!) / 2,
    (STAGE_X[1]! + STAGE_W + STAGE_X[2]!) / 2,
    (STAGE_X[2]! + STAGE_W + STAGE_X[3]!) / 2,
  ];

  const checksumEdgeColor = checksumSevered ? colorFor(checksum.severity) : COLORS.ok;
  const checksumEdge = checksum.severity === "critical"
    ? brokenLinkGlyph(edgeMidX[0]!, MID_Y, checksumEdgeColor)
    : `<line x1="${STAGE_X[0]! + STAGE_W}" y1="${MID_Y}" x2="${STAGE_X[1]}" y2="${MID_Y}" stroke="${checksumEdgeColor}"${checksumSevered ? ` stroke-dasharray="6 5"` : ""}/>`;

  const executionEdge = `<line x1="${STAGE_X[1]! + STAGE_W}" y1="${MID_Y}" x2="${STAGE_X[2]}" y2="${MID_Y}" stroke="${colorFor(execution.severity)}"/>`;
  const residencyEdge = `<line x1="${STAGE_X[2]! + STAGE_W}" y1="${MID_Y}" x2="${STAGE_X[3]}" y2="${MID_Y}" stroke="${colorFor(residency.severity)}"/>`;

  const sudoBadgeX = STAGE_X[1]! + STAGE_W - 10;
  const sudoBadgeY = STAGE_Y - 6;
  const sudoBadge = sudo.severity === "clean" ? "" : calloutGlyph(sudoBadgeX, sudoBadgeY, sudo);

  const parts: string[] = [];
  if (!releaseExists) parts.push("release not checked");
  parts.push(checksumSevered ? "checksum path severed" : "checksum path intact");
  if (execution.severity !== "clean") parts.push("installer runs the download");
  if (residency.severity !== "clean") parts.push("daemon left resident");
  if (sudo.severity !== "clean") parts.push("runs as root");
  const caption = `Install path elevation: release, installer, binary, daemon · ${parts.join(" · ")}`;

  const svg = `<svg viewBox="0 0 820 180" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(caption)}">
<defs>
<pattern id="elev-hatch" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
<line x1="0" y1="0" x2="0" y2="8" stroke="${COLORS.dim}" stroke-width="2" stroke-opacity=".4"/>
</pattern>
</defs>
<g fill="none" stroke-width="1.6" font-family="Space Mono, monospace">
${stageBox(STAGE_X[0]!, "RELEASE", releaseExists ? "" : "NOT CHECKED", releaseColor, !releaseExists)}
${stageBox(STAGE_X[1]!, "INSTALLER", sudo.severity !== "clean" ? "ROOT" : "", installerColor, false)}
${stageBox(STAGE_X[2]!, "BINARY", execution.severity !== "clean" ? "EXECUTES" : "", binaryColor, false)}
${stageBox(STAGE_X[3]!, "DAEMON", residency.severity !== "clean" ? "RESIDENT" : "", daemonColor, false)}
${checksumEdge}
${executionEdge}
${residencyEdge}
${calloutGlyph(edgeMidX[0]!, MID_Y - 26, checksum)}
${calloutGlyph(edgeMidX[1]!, MID_Y - 26, execution)}
${calloutGlyph(edgeMidX[2]!, MID_Y - 26, residency)}
${sudoBadge}
</g>
</svg>`;

  return `<div class="chainwrap">
${svg}
<p class="chaincap">${esc(caption)}</p>
</div>`;
}
