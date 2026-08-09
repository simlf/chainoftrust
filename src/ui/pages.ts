import { registryQualifierFor } from "../lib/target";
import type { Report, StoredVerdict } from "../types";
import { VERDICT_LABEL, VERDICT_SUMMARY } from "../verdict/score";
import { esc, page } from "./layout";

export function homePage(opts: {
  contact: string;
  error?: string;
  prefill?: string;
  status?: number;
}): Response {
  const body = `
<p class="eyebrow">Install-time trust reports</p>
<h1>Should I let my agent install this?</h1>
<p class="lede">Paste a repository URL. You get a report on what installing it would actually do: what the install path executes, whether published checksums are ever verified, what gets written into your agent's configuration, and where a package's provenance does not match its claims.</p>
${opts.error ? `<div class="error">${esc(opts.error)}</div>` : ""}
<form method="post" action="/analyse">
  <label>
    <input type="text" name="target" inputmode="url" autocomplete="off" spellcheck="false"
      placeholder="https://github.com/owner/repo"
      value="${esc(opts.prefill ?? "")}" required autofocus>
  </label>
  <button type="submit">Check this repository</button>
</form>
<p class="reassure">Free, no account required</p>
<hr>
<p class="examples">Accepts a GitHub repository URL, <code>owner/repo</code>, a commit or branch URL, an npm package (<code>npm:name</code>) or a PyPI project (<code>pypi:name</code>).</p>
<h2>What this checks</h2>
<ul>
<li><strong>The install path.</strong> Whether an installer exists, whether the release publishes checksums or signatures, and whether the verification code can actually run. A verification branch that is never reachable is the defect this was built to find.</li>
<li><strong>Agent configuration.</strong> Whether the repository ships hooks, skills, MCP registrations or plugin manifests. These can reach an agent's harness from a cloned working tree, before any install step runs.</li>
<li><strong>Registry provenance.</strong> For npm and PyPI packages with no installer to read, whether the registry entry binds the published files to the build that produced them.</li>
<li><strong>Blast radius, trust root, and what cannot be read.</strong> Which environment variables and hosts the install path touches, how concentrated publishing rights are, and how much of what you would receive is compiled or generated.</li>
</ul>
<h2>What this is not</h2>
<p>Not a vulnerability scanner. Where an existing tool is authoritative it is cited rather than duplicated: OpenSSF Scorecard for maintenance hygiene, Socket for registry package alerts. The question here is what a piece of software asks permission to do when you install it.</p>`;

  return page({ title: "chainoftrust.dev", body, contact: opts.contact, ...(opts.status ? { status: opts.status } : {}) });
}

export function verdictPage(stored: StoredVerdict, contact: string): Response {
  const r = stored.report;
  const t = r.target;
  const repo = `${t.owner}/${t.name}`;

  const body = `
<p class="eyebrow"><a href="/">chainoftrust.dev</a> &middot; install-time trust report</p>
<p class="verdict-band"><span class="tier tier-${esc(r.verdict)}">${esc(VERDICT_LABEL[r.verdict])}</span></p>
<h1>${esc(repo)}</h1>
<p class="target">github.com/${esc(repo)} at ${esc(t.sha)}${
    t.registry
      ? ` &middot; ${esc(t.registry.kind)} ${esc(t.registry.packageName)}@${esc(t.registry.version)}`
      : ""
  }</p>

${
  stored.writeup
    ? `<p class="summary">${esc(stored.writeup)}</p>`
    : `<p class="summary">${esc(VERDICT_SUMMARY[r.verdict])}</p>
       <div class="note-box">The written summary was skipped for this report. The findings below are the analysis; the summary is only prose over them.</div>`
}

<h2>Findings</h2>
${r.findings.map(finding).join("\n")}

<h2>What was not checked</h2>
<ul>${r.notChecked.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>

${
  r.proseExcerpts.length > 0
    ? `<h2>What the project says about itself</h2>
       <p>Quoted verbatim from the repository at this commit. These are the project's own words, reproduced so you can weigh them.</p>
       ${r.proseExcerpts
         .map(
           (e) =>
             `<blockquote>${esc(e.text)}<span class="src">${esc(e.path)} &middot; ${esc(e.reason)}</span></blockquote>`,
         )
         .join("")}`
    : ""
}

<h2>How this was produced</h2>
<ul>
<li>${esc(r.stats.filesInTree)} files listed, ${esc(r.stats.filesFetched)} read.</li>
<li>Nothing was cloned, extracted, installed or executed. Files were read one at a time over HTTPS.</li>
${r.scorecard ? `<li>OpenSSF Scorecard: ${esc(r.scorecard.score)}/10, published ${esc(r.scorecard.date)}. Cited, not recomputed.</li>` : ""}
<li>Pinned to commit ${esc(t.sha)}. Generated ${esc(r.generatedAt.slice(0, 19).replace("T", " "))} UTC${stored.cached ? " and served from cache" : ""}.</li>
${stored.writeupModel ? `<li>Summary written by ${esc(stored.writeupModel)} over the findings above. It was given no other input.</li>` : ""}
</ul>

<p><a href="${esc(verdictJsonPath(r))}">This report as JSON</a> &middot; <a href="/">Check another repository</a></p>`;

  return page({ title: `${repo} - chainoftrust.dev`, body, contact, wide: true });
}

function finding(f: Report["findings"][number]): string {
  return `<div class="finding">
<span class="sev ${esc(f.severity)}">${esc(f.severity)} &middot; ${esc(f.check)}</span>
<p>${esc(f.statement)}</p>
<p class="cite">${esc(f.evidence)}</p>
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
}): Response {
  const body = `
<p class="eyebrow"><a href="/">chainoftrust.dev</a></p>
<h1>${esc(opts.heading)}</h1>
<p class="lede">${esc(opts.message)}</p>
<p><a href="/">Back to the start</a></p>`;
  return page({ title: opts.title, body, contact: opts.contact, status: opts.status });
}
