/** Escape everything that reaches the page. Target text is untrusted input. */
export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Direction D, "Containment Blueprint": the site is drawn as a Prussian-blue
 * engineering sheet, and the sandbox's guarantees are rendered as design
 * elements rather than decoration. Chosen by the captain from four mocked
 * directions on 2026-09-04; the approved mock is the contract for this CSS.
 *
 * Fonts are self-hosted Worker static assets (public/fonts), so the page still
 * makes zero third-party requests and the CSP below can stay closed.
 */
const STYLES = `
@font-face {
  font-family: "Space Mono";
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(/fonts/space-mono-400.woff2) format("woff2");
}
@font-face {
  font-family: "Space Mono";
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url(/fonts/space-mono-700.woff2) format("woff2");
}
@font-face {
  font-family: "Archivo";
  font-style: normal;
  font-weight: 400 700;
  font-display: swap;
  src: url(/fonts/archivo-400-700.woff2) format("woff2");
}
* { box-sizing: border-box; min-width: 0; }
:root {
  --blue-deep: #0a2942;
  --blue: #0e3a5e;
  --blue-panel: rgba(255,255,255,.045);
  --frame: rgba(220,238,252,.85);
  --line: rgba(190,220,245,.34);
  --line-faint: rgba(190,220,245,.16);
  --text: #e8f2fb;
  --dim: #9dc0da;
  --ice: #9fd8f5;
  --warn: #ffd27a;
  --crit: #ff9d8a;
  --ok: #9ff0c8;
  --mono: "Space Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --sans: "Archivo", system-ui, -apple-system, sans-serif;
}
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background:
    linear-gradient(rgba(190,220,245,.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(190,220,245,.05) 1px, transparent 1px),
    radial-gradient(ellipse at 30% 0%, var(--blue) 0%, var(--blue-deep) 75%);
  background-size: 28px 28px, 28px 28px, auto;
  background-attachment: fixed;
  color: var(--text);
  font-family: var(--sans);
  font-size: 16px;
  line-height: 1.6;
}
a { color: var(--ice); }
code { font-family: var(--mono); font-size: 0.85em; }

.statusbar {
  display: flex; flex-wrap: wrap; gap: 0.3rem 1.3rem; justify-content: center;
  font-family: var(--mono); font-size: 0.58rem; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--dim);
  border-bottom: 1px solid var(--line);
  background: rgba(5,23,38,.5);
  padding: 0.45rem 1rem;
  margin-bottom: 1.6rem;
}
.statusbar b { font-weight: 700; color: var(--ok); }

.sheet {
  max-width: 52rem;
  margin: 1.6rem auto 3rem;
  border: 1.5px solid var(--frame);
  outline: 1px solid var(--line);
  outline-offset: 5px;
  padding: clamp(1.2rem, 4.5vw, 2.6rem);
  background: rgba(8, 33, 54, 0.35);
  margin-left: max(0.9rem, calc(50vw - 26rem));
  margin-right: max(0.9rem, calc(50vw - 26rem));
}

.dwghead {
  display: flex; justify-content: space-between; gap: 0.4rem 1rem; flex-wrap: wrap;
  font-family: var(--mono); font-size: 0.62rem; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--dim);
  border-bottom: 1px solid var(--line);
  padding-bottom: 0.8rem; margin-bottom: 2.2rem;
}
.dwghead b { color: var(--text); font-weight: 400; }
.dwghead a { color: inherit; text-decoration: none; }
.dwghead a b { border-bottom: 1px solid var(--line); }

h1 {
  font-family: var(--mono);
  font-size: clamp(1.6rem, 5.6vw, 2.8rem);
  line-height: 1.15; font-weight: 700; text-transform: uppercase; letter-spacing: 0.015em;
  margin: 0 0 1.2rem; color: #f2f9ff;
  overflow-wrap: anywhere;
}
h1 .underline { border-bottom: 3px solid var(--ice); }
.lede { font-size: 0.98rem; color: var(--dim); max-width: 38rem; margin: 0 0 2.2rem; }

.dim-divider {
  display: flex; align-items: center; gap: 0.7rem;
  font-family: var(--mono); font-size: 0.6rem; letter-spacing: 0.22em; text-transform: uppercase;
  color: var(--ice); margin: 2.5rem 0 1.2rem;
}
.dim-divider::before, .dim-divider::after { content: ""; flex: 1; border-top: 1px solid var(--line); }

.errorpanel {
  border: 1px solid var(--warn);
  background: rgba(255,210,122,.07);
  color: var(--text);
  padding: 0.9rem 1.1rem;
  font-size: 0.92rem;
  margin: 0 0 1.4rem;
}

.intake {
  border: 1px solid var(--frame);
  padding: 1.5rem clamp(1rem, 4vw, 1.7rem);
  position: relative;
  background: var(--blue-panel);
  margin-bottom: 1rem;
}
.intake::before, .intake::after, .intake .c::before, .intake .c::after {
  content: ""; position: absolute; width: 13px; height: 13px; border: 2px solid var(--ok);
}
.intake::before { top: -2px; left: -2px; border-right: 0; border-bottom: 0; }
.intake::after { top: -2px; right: -2px; border-left: 0; border-bottom: 0; }
.intake .c::before { bottom: -2px; left: -2px; border-right: 0; border-top: 0; }
.intake .c::after { bottom: -2px; right: -2px; border-left: 0; border-top: 0; }
.intake .label {
  font-family: var(--mono); font-size: 0.6rem; letter-spacing: 0.24em; text-transform: uppercase;
  color: var(--ice); margin: 0 0 0.85rem;
}
.intake input {
  width: 100%; padding: 0.95rem 1rem;
  font-family: var(--mono); font-size: 0.85rem;
  color: var(--text); background: rgba(5,23,38,.75);
  border: 1px solid var(--line); border-radius: 0;
}
.intake input::placeholder { color: rgba(157,192,218,.5); }
.intake input:focus { outline: 1.5px solid var(--ice); outline-offset: 1px; }
.intake button {
  margin-top: 0.9rem; padding: 0.9rem 2rem;
  font-family: var(--mono); font-size: 0.78rem; letter-spacing: 0.2em; text-transform: uppercase; font-weight: 700;
  color: var(--blue-deep); background: var(--ice); border: 0; border-radius: 0; cursor: pointer;
}
.intake button:hover { background: #c2e7fb; }
.chit {
  position: absolute; right: clamp(0.6rem, 3vw, 1.4rem); top: -0.95rem;
  font-family: var(--mono); font-size: 0.56rem; letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--warn); border: 1.5px solid var(--warn); padding: 0.3rem 0.6rem;
  transform: rotate(2.5deg); background: var(--blue-deep);
}
.accepts { font-size: 0.82rem; color: var(--dim); margin: 1rem 0 0; }
.accepts code { font-size: 0.74rem; border: 1px solid var(--line-faint); padding: 0.05rem 0.35rem; color: var(--text); }

.heroseal {
  float: right;
  font-family: var(--mono); text-transform: uppercase; text-align: center;
  color: var(--ok); border: 3px double var(--ok);
  padding: 0.5rem 0.95rem; letter-spacing: 0.24em; font-weight: 700;
  transform: rotate(-3deg);
  margin: 0.2rem 0 0.8rem 1rem;
  font-size: clamp(0.66rem, 2vw, 0.85rem);
  opacity: 0.9;
}
.heroseal small { display: block; font-weight: 400; font-size: 0.5rem; letter-spacing: 0.18em; margin-top: 0.25rem; color: rgba(159,240,200,.75); }

.modules { display: grid; grid-template-columns: repeat(auto-fit, minmax(14.5rem, 1fr)); gap: 0.9rem; }
.module { border: 1px solid var(--line); padding: 1rem 1.05rem; position: relative; background: var(--blue-panel); }
.module .ref { position: absolute; top: -0.62rem; left: 0.8rem; font-family: var(--mono); font-size: 0.58rem; letter-spacing: 0.16em; color: var(--ice); background: var(--blue-deep); padding: 0 0.45rem; border: 1px solid var(--line); }
.module:nth-child(4) .ref { transform: rotate(-1.6deg); }
.module h2 { margin: 0.1rem 0 0.35rem; font-family: var(--mono); font-size: 0.78rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #f2f9ff; }
.module p { margin: 0; font-size: 0.8rem; color: var(--dim); }

.callouts { font-family: var(--mono); font-size: 0.72rem; color: var(--dim); display: flex; flex-wrap: wrap; gap: 0.5rem 1.6rem; }
.callouts span::before { content: "\\25B8\\00a0"; color: var(--ice); }

.notpanel { border: 1px solid var(--line); background: var(--blue-panel); padding: 1rem 1.2rem; font-size: 0.86rem; color: var(--dim); }
.notpanel b { color: var(--text); font-weight: 500; }

.titleblock {
  margin-top: 2.6rem;
  border: 1.5px solid var(--frame);
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
  font-family: var(--mono);
}
.tb { border: 0.5px solid var(--line); padding: 0.55rem 0.75rem; }
.tb .k { font-size: 0.52rem; letter-spacing: 0.2em; text-transform: uppercase; color: var(--dim); }
.tb .v { font-size: 0.74rem; color: var(--text); word-break: break-word; }

footer { margin-top: 1.5rem; font-size: 0.74rem; color: var(--dim); }

.stampbox {
  float: right;
  font-family: var(--mono); text-transform: uppercase; text-align: center;
  border: 3px double currentColor;
  padding: 0.55rem 1.05rem; letter-spacing: 0.26em; font-weight: 700;
  transform: rotate(3.5deg);
  margin: 0 0 0.8rem 1rem;
  font-size: clamp(0.85rem, 2.4vw, 1.1rem);
  opacity: 0.95;
}
.stampbox small { display: block; font-weight: 400; font-size: 0.52rem; letter-spacing: 0.2em; margin-top: 0.3rem; opacity: 0.8; }
.stamp-warnings { color: var(--warn); }
.stamp-clean { color: var(--ok); }
.stamp-do-not-install { color: var(--crit); }

.target { font-family: var(--mono); font-size: 0.68rem; color: var(--dim); word-break: break-all; margin: 0 0 1.6rem; }
.cachechit {
  display: inline-block;
  font-family: var(--mono); font-size: 0.54rem; letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--ice); border: 1.5px solid var(--ice); padding: 0.28rem 0.55rem;
  transform: rotate(-1deg); background: var(--blue-deep);
  margin-left: 0.6rem; vertical-align: middle;
}

.chainwrap { margin: 0 0 1.5rem; overflow-x: auto; border: 1px solid var(--line); padding: 0.6rem 0.8rem 0.2rem; }
.chainwrap svg { display: block; min-width: 600px; width: 100%; height: auto; }
.chaincap {
  font-family: var(--mono); font-size: 0.58rem; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--dim); margin: 0.2rem 0 0.5rem;
}

.summary { font-size: 1.02rem; color: #f2f9ff; max-width: 42rem; margin: 0 0 0.35rem; }
.summary-src { font-family: var(--mono); font-size: 0.56rem; letter-spacing: 0.16em; text-transform: uppercase; color: var(--dim); margin: 0 0 0.5rem; }

.anno { border-top: 1px solid var(--line-faint); padding: 1rem 0; display: grid; grid-template-columns: 2.6rem 1fr; gap: 0 1rem; }
.anno:last-of-type { border-bottom: 1px solid var(--line-faint); }
.anno .num {
  width: 1.9rem; height: 1.9rem; border-radius: 50%;
  border: 1.5px solid var(--warn); color: var(--warn);
  font-family: var(--mono); font-size: 0.85rem; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
}
.anno.critical .num { border-color: var(--crit); color: var(--crit); }
.anno.clean .num, .anno.note .num { border-color: var(--ok); color: var(--ok); }
.anno .meta { font-family: var(--mono); font-size: 0.58rem; letter-spacing: 0.16em; text-transform: uppercase; margin-bottom: 0.3rem; }
.anno .meta .sev { color: var(--warn); font-weight: 700; }
.anno.critical .meta .sev { color: var(--crit); }
.anno.clean .meta .sev, .anno.note .meta .sev { color: var(--ok); }
.anno .meta .chk { color: var(--dim); }
.anno p { margin: 0 0 0.45rem; font-size: 0.88rem; }
.anno blockquote {
  margin: 0.15rem 0 0.55rem; padding: 0.5rem 0.8rem; overflow-x: auto;
  background: rgba(5,23,38,.75); border: 1px solid var(--line-faint);
  font-family: var(--mono); font-size: 0.72rem; color: var(--ice);
  white-space: pre-wrap;
}
.anno .cite { font-family: var(--mono); font-size: 0.62rem; color: var(--dim); word-break: break-all; }
.anno .cite::before { content: "REF "; letter-spacing: 0.14em; color: var(--ice); }
@media (max-width: 34rem) {
  .anno { grid-template-columns: 2.2rem 1fr; gap: 0 0.7rem; }
  /* A floated stamp next to a long repository name squeezes the heading into
     a one-character column on a phone, so the stamp sits above it instead. */
  .stampbox, .heroseal { float: none; display: inline-block; margin: 0 0 1rem; }
}

.unsurveyed {
  border: 1px solid var(--line);
  background: repeating-linear-gradient(-45deg, transparent 0 12px, rgba(190,220,245,.06) 12px 14px);
  padding: 1.2rem 1.4rem;
  position: relative;
}
.unsurveyed .corner-tag {
  position: absolute; top: -0.8rem; right: 1rem;
  font-family: var(--mono); font-size: 0.54rem; letter-spacing: 0.2em; text-transform: uppercase;
  color: var(--dim); border: 1px solid var(--line); background: var(--blue-deep);
  padding: 0.25rem 0.55rem; transform: rotate(-2deg);
}
.unsurveyed ul { margin: 0; padding-left: 1.15rem; }
.unsurveyed li { margin-bottom: 0.5rem; font-size: 0.88rem; }
.unsurveyed .why { font-size: 0.76rem; font-style: italic; color: var(--dim); margin: 0.9rem 0 0; }

.fence { border: 1px solid var(--line); position: relative; }
.fence .tab {
  display: inline-block; font-family: var(--mono); font-size: 0.56rem; letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--blue-deep); background: var(--warn); padding: 0.28rem 0.7rem; font-weight: 700;
  transform: rotate(-1deg) translateY(-0.35rem); margin-left: 0.8rem;
}
.fence .hazard { height: 8px; background: repeating-linear-gradient(-45deg, var(--warn) 0 10px, rgba(10,41,66,.9) 10px 20px); opacity: 0.75; }
.fence .inner { padding: 1rem 1.2rem; background: rgba(255,210,122,.05); }
.fence blockquote { margin: 0 0 0.9rem; font-size: 0.9rem; color: #d8cba8; font-style: italic; overflow-wrap: anywhere; }
.fence blockquote:last-child { margin-bottom: 0; }
.fence .src { display: block; font-style: normal; font-family: var(--mono); font-size: 0.6rem; color: var(--dim); margin-top: 0.3rem; }
.fence .note { font-size: 0.7rem; color: var(--dim); padding: 0 1.2rem 0.9rem; margin: 0; }
`;

const SITE_URL = "https://chainoftrust.dev";
const DEFAULT_DESCRIPTION =
  "Install-time trust reports for agent-facing tooling. Paste a repository URL and see what installing it would actually do.";

export function page(opts: {
  title: string;
  body: string;
  contact: string;
  status?: number;
  /** The containment status strip, shown on the landing page only. */
  statusbar?: boolean;
  /** Falls back to the site-wide description. Pass a report-specific one for a verdict page. */
  description?: string;
  /** Path this page lives at, for og:url. Falls back to the site root. */
  path?: string;
  /**
   * Set only on pages whose URL is cache-key-immutable: the header a shared
   * link should carry. Landing and status pages never set this.
   */
  cacheControl?: string;
}): Response {
  const statusbar = opts.statusbar
    ? `<div class="statusbar">
<span>EGRESS <b>LOCKED &middot; 5 HOSTS</b></span>
<span>REDIRECTS <b>REFUSED</b></span>
<span>SHELL <b>NONE</b></span>
<span>TARGET EXECUTION <b>STRUCTURALLY IMPOSSIBLE</b></span>
</div>`
    : "";

  const description = opts.description ?? DEFAULT_DESCRIPTION;
  const url = `${SITE_URL}${opts.path ?? "/"}`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="chainoftrust.dev">
<meta property="og:title" content="${esc(opts.title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(opts.title)}">
<meta name="twitter:description" content="${esc(description)}">
<style>${STYLES}</style>
</head>
<body>
${statusbar}
<div class="sheet">
${opts.body}
<footer>
<p>chainoftrust.dev reports what a repository says it does at install time. It never runs the installer, never installs the package, and never executes anything from the repository. Every finding cites the file or API field it came from so you can check it yourself.</p>
<p>Corrections and disputes: <a href="mailto:${esc(opts.contact)}">${esc(opts.contact)}</a></p>
</footer>
</div>
</body>
</html>`;
  return new Response(html, {
    status: opts.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The page has no third-party anything: fonts are self-hosted Worker
      // assets, styles are inline, and there is still no script at all. Say so
      // in a header, since the product's whole claim is about what software is
      // allowed to reach.
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...(opts.cacheControl ? { "cache-control": opts.cacheControl } : {}),
    },
  });
}
