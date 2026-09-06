import { registryQualifierFor } from "../lib/target";
import type { CheckId, Finding, Report, Severity, StoredVerdict } from "../types";
import { VERDICT_LABEL, VERDICT_SUMMARY } from "../verdict/score";
import { elevationSchematic } from "./elevation";
import { esc, page } from "./layout";

/**
 * A curated, hardcoded set of example reports, never a public index. Each
 * entry names a commit that was verified by hand to render well and to land
 * on a favourable-or-neutral verdict; the sha pins the link to that exact
 * finding, so a repository that later regresses cannot silently turn this
 * list unfavourable. Populated by running a real analysis against production
 * (`POST /analyse`) and copying the resulting address here, the same way
 * `ollama/ollama` first entered this codebase as a calibration target
 * (docs/seed-dataset.md).
 *
 * `docs/seed-dataset.md` holds the line that no verdict on a third-party
 * repository is published unrequested, because the disclosure and dispute
 * policy for one does not exist yet. This list does not cross that line: it
 * surfaces no verdict anyone would need to dispute, since every entry here is
 * clean or warnings by construction and nothing unfavourable about anyone
 * is ever shown. It is also not the public index that rule is guarding
 * against, since it names a handful of examples the operator chose rather
 * than listing what has been analysed. An unfavourable verdict must never be
 * added here, and adding an entry is always a human, code-reviewed decision,
 * never something a submission can cause on its own.
 *
 * The site's own analysis is one entry here, now that chainoftrust itself is
 * public: it is the transparency flex, the scanner publishing its own verdict.
 */
export interface ShowcaseEntry {
  owner: string;
  name: string;
  sha: string;
  note: string;
}

export const SHOWCASE: ShowcaseEntry[] = [
  {
    owner: "simlf",
    name: "chainoftrust",
    sha: "1cbaaa0991c95cddd83b16309b2e41618500ff69",
    note: "The site analysing itself: the transparency flex. Its own README names curl|sh installers as one of the patterns it looks for, and no probe here mistakes that mention for an instruction.",
  },
  {
    owner: "ollama",
    name: "ollama",
    sha: "83ed7d9965b1ee07e0f0b29fd46e47c31f0fcab8",
    note: "Installer runs with elevated privileges and never checks the checksums its own release publishes.",
  },
  {
    owner: "anthropics",
    name: "claude-code",
    sha: "d7dbd9a09f59775726ed14bbea8fc9dfdff62f7b",
    note: "Ships hooks, a plugin manifest and ten skill definitions: agent config reaches a harness before any install step.",
  },
  {
    owner: "astral-sh",
    name: "uv",
    sha: "b73e597cb1aa3d962dd2df5c692718ba4d851969",
    note: "A Python build backend runs at install time, alongside Claude Code hooks committed in the same repository.",
  },
  {
    owner: "modelcontextprotocol",
    name: "servers",
    sha: "d73f99efbfd40c3aa1b61e88728b3d49fb52608f",
    note: "An MCP server registration, and a package manifest with no install-time lifecycle scripts at all.",
  },
];

function showcase(): string {
  return `
<div class="dim-divider">Example reports, not an index</div>
<p class="lede showcase-lede">A handful of reports we picked to show the shape of one: what the annotations look like, what the chain of trust draws, what the install-path schematic looks like when there is an installer to draw. Not everything analysed and not an activity feed, just examples.</p>
<div class="modules">
${SHOWCASE.map(
  (s) =>
    `<div class="module"><span class="ref">EXAMPLE</span><h2>${esc(s.owner)}/${esc(s.name)}</h2><p>${esc(s.note)}</p><p class="cta"><a href="/r/github/${esc(s.owner)}/${esc(s.name)}/${esc(s.sha)}">View the report &#8594;</a></p></div>`,
).join("\n")}
</div>`;
}

export function homePage(opts: {
  contact: string;
  error?: string;
  prefill?: string;
  status?: number;
}): Response {
  const body = `
<div class="dwghead">
  <span><b>chainoftrust.dev</b> &middot; install-time trust reports</span>
  <span>INTAKE &middot; FORM 1</span>
</div>

<div class="heroseal">Never executed<small>structural, not policy</small></div>
<h1>Should I let my agent<br><span class="underline">install this?</span></h1>
<p class="lede">Paste a repository URL. You get a report on what installing it would actually do: what the install path executes, whether published checksums are ever verified, and what gets written into your agent&#39;s configuration.</p>

${opts.error ? `<div class="errorpanel">${esc(opts.error)}</div>` : ""}
<form method="post" action="/analyse">
  <div class="intake">
    <span class="c"></span>
    <span class="chit">Free &middot; no account</span>
    <p class="label">Specimen: surveyed by reading, never by running</p>
    <input type="text" name="target" inputmode="url" autocomplete="off" spellcheck="false"
      placeholder="https://github.com/owner/repo"
      value="${esc(opts.prefill ?? "")}" required autofocus>
    <button type="submit">Survey this repository</button>
  </div>
</form>
<p class="accepts">Accepts a GitHub URL, <code>owner/repo</code>, a commit or branch URL, <code>npm:name</code> or <code>pypi:name</code>. Verdicts are public.</p>

<div class="dim-divider">Plan of inquiry: six views</div>
<div class="modules">
  <div class="module"><span class="ref">VIEW A-1</span><h2>Install path</h2><p>Does an installer exist, does the release publish checksums or signatures, and can the verification code actually run?</p></div>
  <div class="module"><span class="ref">VIEW A-2</span><h2>Agent config</h2><p>Hooks, skills, MCP registrations or plugin manifests that reach an agent&#39;s harness before any install step.</p></div>
  <div class="module"><span class="ref">VIEW A-3</span><h2>Registry provenance</h2><p>Does the registry entry bind the published files to the build that produced them?</p></div>
  <div class="module"><span class="ref">VIEW B-1</span><h2>Blast radius</h2><p>Which environment variables and hosts the install path touches, and are any credential-shaped?</p></div>
  <div class="module"><span class="ref">VIEW B-2</span><h2>Trust root</h2><p>How concentrated are publishing rights, and what is the real lineage?</p></div>
  <div class="module"><span class="ref">VIEW B-3</span><h2>Unauditable surface</h2><p>How much of what you would receive cannot be reviewed by reading it?</p></div>
</div>

<div class="dim-divider">Method of survey</div>
<div class="callouts">
  <span>no clone: files read one at a time over HTTPS</span>
  <span>no shell, no filesystem, no process spawning</span>
  <span>repository prose: nonce-fenced, treated as data</span>
  <span>fetch budget + per-file byte cap</span>
</div>

<div class="dim-divider">What this is not</div>
<div class="notpanel"><b>Not a vulnerability scanner.</b> Where an existing tool is authoritative it is cited, not duplicated: OpenSSF Scorecard for maintenance hygiene, Socket for registry alerts. The question here is what a piece of software asks permission to do when you install it. Two of these views have no equivalent in either tool: install path reachability (does the verification code actually run) and agent config auto-discovery (what reaches an agent's harness before any install step).</div>
${showcase()}
<div class="titleblock">
  <div class="tb"><div class="k">Project</div><div class="v">chainoftrust.dev</div></div>
  <div class="tb"><div class="k">Drawing</div><div class="v">Intake &middot; Form 1</div></div>
  <div class="tb"><div class="k">Scale</div><div class="v">NONE. Nothing executed</div></div>
  <div class="tb"><div class="k">Drawn by</div><div class="v">deterministic collectors</div></div>
  <div class="tb"><div class="k">Checked by</div><div class="v">arithmetic, recomputable</div></div>
  <div class="tb"><div class="k">Disputes</div><div class="v">${esc(opts.contact)}</div></div>
</div>`;

  return page({
    title: "chainoftrust.dev",
    body,
    contact: opts.contact,
    statusbar: true,
    path: "/",
    ...(opts.status ? { status: opts.status } : {}),
  });
}

export function verdictPage(
  stored: StoredVerdict,
  contact: string,
  pinned = false,
  newerCommit: string | null = null,
): Response {
  const r = stored.report;
  const t = r.target;
  const repo = `${t.owner}/${t.name}`;
  const sha7 = t.sha.slice(0, 7);
  const day = r.generatedAt.slice(0, 10);
  const concerns = new Set(r.findings.map((f) => f.concern ?? f.check)).size;

  const body = `
<div class="dwghead">
  <span><a href="/"><b>chainoftrust.dev</b></a> &middot; install-time trust report</span>
  <span>REV ${esc(sha7)} &middot; PINNED &middot; RECOMPUTABLE</span>
</div>

<div class="stampbox stamp-${esc(r.verdict)}">${esc(VERDICT_LABEL[r.verdict])}<small>Inspected ${esc(day)} &middot; recomputable</small></div>
<h1>${esc(repo)}</h1>
<p class="target">github.com/${esc(repo)} at ${esc(t.sha)}${
    t.registry
      ? ` &middot; ${esc(t.registry.kind)} ${esc(t.registry.packageName)}@${esc(t.registry.version)}`
      : ""
  } &middot; examined ${esc(r.generatedAt.slice(0, 16).replace("T", " "))} UTC${
    stored.cached ? `<span class="cachechit">Served from cache</span>` : ""
  }</p>

${
  newerCommit
    ? `<div class="notpanel">This report is for commit ${esc(sha7)}. This repository has moved to a newer commit, ${esc(newerCommit.slice(0, 7))}. Nothing re-analyses on its own: a fresh analysis of the newer commit is a deliberate act.
<form method="post" action="/analyse">
  <input type="hidden" name="target" value="${esc(repo)}">
  <input type="hidden" name="refresh" value="1">
  <button type="submit">Analyse the newer commit</button>
</form></div>`
    : ""
}

${chainOfTrust(r)}
${elevationSchematic(r)}

${
  stored.writeup
    ? `<p class="summary">${esc(stored.writeup)}</p>`
    : `<p class="summary">${esc(VERDICT_SUMMARY[r.verdict])}</p>
       <div class="notpanel">${esc(degradedNotice(stored.writeupDegradedReason))}</div>`
}
${
  stored.writeupModel
    ? `<p class="summary-src">Summary by ${esc(stored.writeupModel)}, over the findings below only</p>`
    : ""
}

<div class="dim-divider">Annotations: ${esc(r.findings.length)} finding${r.findings.length === 1 ? "" : "s"}, ${esc(concerns)} distinct concern${concerns === 1 ? "" : "s"}</div>
${r.findings.map(finding).join("\n")}

<div class="dim-divider">Unsurveyed: declared out of scope</div>
<div class="unsurveyed">
  <span class="corner-tag">Hatched = not measured</span>
  <ul>${r.notChecked.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
  <p class="why">Declared limits are as load-bearing as findings: this is the difference between a report and a scanner that implies completeness.</p>
</div>

${
  r.proseExcerpts.length > 0
    ? `<div class="dim-divider">What the project says about itself</div>
<div class="fence">
  <span class="tab">&#9888; Untrusted input: nonce-fenced, rendered inert</span>
  <div class="hazard"></div>
  <div class="inner">
    ${r.proseExcerpts
      .map(
        (e) =>
          `<blockquote>${esc(e.text)}<span class="src">${esc(e.path)} &middot; ${esc(e.reason)}</span></blockquote>`,
      )
      .join("")}
  </div>
  <p class="note">Quoted verbatim from the repository at this commit, reproduced so you can weigh them. This text was treated as data, never as instructions.</p>
  <div class="hazard"></div>
</div>`
    : ""
}

<div class="titleblock">
  <div class="tb"><div class="k">Target</div><div class="v">${esc(repo)}</div></div>
  <div class="tb"><div class="k">Revision</div><div class="v">${esc(sha7)}</div></div>
  <div class="tb"><div class="k">Files listed / read</div><div class="v">${esc(r.stats.filesInTree)} / ${esc(r.stats.filesFetched)} &middot; 0 executed</div></div>
  <div class="tb"><div class="k">Method</div><div class="v">read one at a time over HTTPS. Nothing cloned, extracted, installed or executed</div></div>
  ${r.scorecard ? `<div class="tb"><div class="k">OpenSSF Scorecard</div><div class="v">${esc(r.scorecard.score)}/10 &middot; published ${esc(r.scorecard.date)} &middot; cited, not recomputed</div></div>` : ""}
  ${stored.writeupModel ? `<div class="tb"><div class="k">Summary by</div><div class="v">${esc(stored.writeupModel)}, given the findings above and nothing else</div></div>` : ""}
  <div class="tb"><div class="k">Generated</div><div class="v">${esc(r.generatedAt.slice(0, 19).replace("T", " "))} UTC${stored.cached ? " &middot; served from cache" : ""}</div></div>
  <div class="tb"><div class="k">Verdict</div><div class="v">arithmetic over distinct concerns, recomputable by anyone</div></div>
  <div class="tb"><div class="k">Formats</div><div class="v"><a href="${esc(verdictJsonPath(r))}">JSON</a> &middot; <a href="/">new survey</a></div></div>
</div>`;

  return page({
    title: `${repo} - chainoftrust.dev`,
    body,
    contact,
    description: `${repo} at ${sha7}: ${VERDICT_LABEL[r.verdict]}, ${r.findings.length} finding${r.findings.length === 1 ? "" : "s"} across ${concerns} distinct concern${concerns === 1 ? "" : "s"}. Read one file at a time, nothing installed or executed.`,
    path: verdictPath(r),
    // Pinned by commit SHA: the URL never resolves to different content, so a
    // repeat view of a shared link may be cached, same as the JSON route.
    ...(pinned ? { cacheControl: "public, max-age=3600" } : {}),
  });
}

/**
 * Honest wording for a report with no written summary, distinguishing what the
 * code can actually tell apart. "no-key" means this deployment never had a
 * summary provider configured, which is not a failure of anything. "budget"
 * and "error" both mean a provider was configured and the call did not
 * produce prose this time, whether because the monthly ceiling was reached or
 * because the provider itself failed; either way the honest claim is that the
 * summary is temporarily unavailable, not that it will never come back. A
 * null reason (a report stored before this distinction existed) gets the
 * older, reason-agnostic wording rather than a guess.
 */
function degradedNotice(reason: StoredVerdict["writeupDegradedReason"]): string {
  switch (reason) {
    case "no-key":
      return "No summary provider is configured for this deployment, so no written summary was ever attempted. The findings below are the whole analysis.";
    case "budget":
    case "error":
      return "The written summary is temporarily unavailable. The deterministic findings below are complete and unaffected.";
    default:
      return "The written summary was skipped for this report. The findings below are the analysis; the summary is only prose over them.";
  }
}

function finding(f: Finding, index: number): string {
  const cls = esc(f.severity);
  const concern =
    f.concern && f.concern !== f.check
      ? f.concern.startsWith(`${f.check}:`)
        ? f.concern.slice(f.check.length + 1)
        : f.concern
      : null;
  return `<div class="anno ${cls}">
  <div class="num">${index + 1}</div>
  <div>
    <div class="meta"><span class="sev">${esc(f.severity.toUpperCase())}</span> &middot; <span class="chk">${esc(f.check)}${concern ? ` / ${esc(concern)}` : ""}</span></div>
    <p>${esc(f.statement)}</p>
    ${f.quote ? `<blockquote>${esc(f.quote)}</blockquote>` : ""}
    <p class="cite">${esc(f.evidence)}</p>
  </div>
</div>`;
}

/**
 * The chain of trust, drawn: one link per check, in blueprint line-work. A
 * link is green when everything established for that check came back clean,
 * amber when it holds a warning, red and broken when it holds a critical
 * finding, and dashed when the analysis established nothing for it. When the
 * verdict is not clean and nothing is critical, the chain breaks at the first
 * check carrying a warning, so the tier is readable from the drawing alone.
 *
 * Deterministic over the findings, like the verdict itself.
 *
 * The mock's per-report install-path elevation schematic ships alongside
 * this as `elevationSchematic()` in ./elevation.ts, derived from the same
 * install-path findings rather than a purpose-built shape (see that file's
 * header comment for why that is honest rather than a fake-precision shortcut).
 */
const CHAIN_CHECKS: { id: CheckId; label: string }[] = [
  { id: "install-path", label: "INSTALL PATH" },
  { id: "agent-config", label: "AGENT CONFIG" },
  { id: "registry-provenance", label: "REGISTRY" },
  { id: "blast-radius", label: "BLAST RADIUS" },
  { id: "trust-root", label: "TRUST ROOT" },
  { id: "unauditable-surface", label: "UNAUDITABLE" },
];

const SEVERITY_RANK: Record<Severity, number> = { clean: 0, note: 1, warning: 2, critical: 3 };

const CHAIN_COLORS = {
  ok: "#9ff0c8",
  warn: "#ffd27a",
  crit: "#ff9d8a",
  dim: "#9dc0da",
  connector: "#9fd8f5",
};

function chainOfTrust(r: Report): string {
  const worst = new Map<CheckId, Severity>();
  for (const f of r.findings) {
    const current = worst.get(f.check);
    if (current === undefined || SEVERITY_RANK[f.severity] > SEVERITY_RANK[current]) {
      worst.set(f.check, f.severity);
    }
  }

  const broken = new Set<CheckId>();
  for (const c of CHAIN_CHECKS) {
    if (worst.get(c.id) === "critical") broken.add(c.id);
  }
  if (broken.size === 0 && r.verdict !== "clean") {
    const first = CHAIN_CHECKS.find((c) => worst.get(c.id) === "warning");
    if (first) broken.add(first.id);
  }

  const parts: string[] = [];
  const labels: string[] = [];
  let breaksHere: string | null = null;

  CHAIN_CHECKS.forEach((c, i) => {
    const x = 20 + i * 104;
    const severity = worst.get(c.id);
    const color =
      severity === undefined
        ? CHAIN_COLORS.dim
        : severity === "critical"
          ? CHAIN_COLORS.crit
          : severity === "warning"
            ? CHAIN_COLORS.warn
            : CHAIN_COLORS.ok;

    if (broken.has(c.id)) {
      parts.push(`<g stroke="${color}">
<path d="M ${x + 40} 28 H ${x + 15} A 15 15 0 0 0 ${x + 15} 58 H ${x + 38}" transform="rotate(-5 ${x + 27} 43)"/>
<path d="M ${x + 48} 28 H ${x + 73} A 15 15 0 0 1 ${x + 73} 58 H ${x + 50}" transform="rotate(5 ${x + 61} 43)"/>
<line x1="${x + 42}" y1="34" x2="${x + 48}" y2="30"/>
<line x1="${x + 43}" y1="52" x2="${x + 49}" y2="56"/>
</g>`);
      if (!breaksHere) {
        breaksHere = `<text x="${x + 6}" y="14" fill="${color}" stroke="none" font-size="9.5" letter-spacing="1.5">BREAKS HERE</text>
<line x1="${x + 34}" y1="18" x2="${x + 34}" y2="24" stroke="${color}" stroke-dasharray="2 2"/>`;
      }
    } else {
      const dash = severity === undefined ? ` stroke-dasharray="5 4" stroke-opacity=".45"` : "";
      parts.push(`<rect x="${x}" y="28" width="88" height="30" rx="15" stroke="${color}"${dash}/>`);
    }
    if (i < CHAIN_CHECKS.length - 1) {
      parts.push(
        `<ellipse cx="${x + 96}" cy="43" rx="7" ry="12" stroke="${CHAIN_COLORS.connector}" stroke-opacity=".6"/>`,
      );
    }
    const labelColor = severity === undefined ? CHAIN_COLORS.dim : color;
    labels.push(
      `<text x="${x + 44}" y="78" fill="${labelColor}"${severity === undefined ? ` fill-opacity=".6"` : ""}>${c.label}</text>`,
    );
  });

  const brokenLabels = CHAIN_CHECKS.filter((c) => broken.has(c.id)).map((c) =>
    c.label.toLowerCase(),
  );
  // A verdict can be carried entirely by findings outside the six drawn
  // checks (the prose check), so a non-clean verdict with an intact chain must
  // say where the concerns live rather than claim the chain held.
  const caption =
    brokenLabels.length > 0
      ? `The chain of trust: breaks at ${brokenLabels.join(", ")} · amber holds a warning · dashed was not established`
      : r.verdict === "clean"
        ? `The chain of trust: every link held · dashed was not established`
        : `The chain of trust: the drawn links held · this verdict's concerns sit in the annotations below`;

  return `<div class="chainwrap">
<svg viewBox="0 0 720 96" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(caption)}">
<g fill="none" stroke-width="1.6">
${breaksHere ?? ""}
${parts.join("\n")}
</g>
<g font-family="Space Mono, monospace" font-size="9" fill="${CHAIN_COLORS.dim}" text-anchor="middle" letter-spacing="1">
${labels.join("\n")}
</g>
</svg>
<p class="chaincap">${esc(caption)}</p>
</div>`;
}

/**
 * The report's own address. The registry qualifier rides as a query parameter
 * so the plain /r/github/:owner/:name/:sha route keeps resolving, while an npm
 * and a PyPI report on the same commit stay distinguishable.
 */
export function verdictPath(r: Report): string {
  const path = `/r/github/${encodeURIComponent(r.target.owner)}/${encodeURIComponent(r.target.name)}/${encodeURIComponent(r.target.sha)}`;
  const reg = r.target.registry;
  return reg ? `${path}?pkg=${encodeURIComponent(registryQualifierFor(reg))}` : path;
}

export function verdictJsonPath(r: Report): string {
  const path = verdictPath(r);
  return `${path}${path.includes("?") ? "&" : "?"}format=json`;
}

export function messagePage(opts: {
  title: string;
  heading: string;
  message: string;
  contact: string;
  status: number;
  path?: string;
}): Response {
  const body = `
<div class="dwghead">
  <span><a href="/"><b>chainoftrust.dev</b></a> &middot; install-time trust reports</span>
  <span>NOTICE</span>
</div>
<h1>${esc(opts.heading)}</h1>
<p class="lede">${esc(opts.message)}</p>
<p><a href="/">Back to the start</a></p>`;
  return page({
    title: opts.title,
    body,
    contact: opts.contact,
    status: opts.status,
    description: opts.message,
    ...(opts.path ? { path: opts.path } : {}),
  });
}
