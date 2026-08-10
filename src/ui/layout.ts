/** Escape everything that reaches the page. Target text is untrusted input. */
export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLES = `
:root {
  --cream: #f6f2e8;
  --ink: #1c1b18;
  --muted: #6b6659;
  --rule: #ddd5c4;
  --green: #1f4231;
  --green-hover: #163124;
  --warn: #8a5a12;
  --crit: #8c2f22;
  --ok: #2c6247;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--cream);
  color: var(--ink);
  font-family: Georgia, "Iowan Old Style", "Times New Roman", serif;
  font-size: 18px;
  line-height: 1.6;
}
.wrap { max-width: 42rem; margin: 0 auto; padding: 3.5rem 1.5rem 5rem; }
.wrap.wide { max-width: 50rem; }
.eyebrow {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.7rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 0 0 1.75rem;
}
h1 {
  font-size: clamp(2.1rem, 6vw, 3.4rem);
  line-height: 1.1;
  font-weight: 400;
  letter-spacing: -0.015em;
  margin: 0 0 1.25rem;
}
h2 {
  font-size: 1.15rem;
  font-weight: 400;
  font-style: italic;
  margin: 2.75rem 0 0.85rem;
}
p { margin: 0 0 1rem; }
.lede { font-size: 1.05rem; color: var(--muted); margin-bottom: 2.25rem; }
form { margin: 0 0 1rem; }
label { display: block; }
input[type="url"], input[type="text"] {
  width: 100%;
  padding: 0.95rem 1.05rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9rem;
  color: var(--ink);
  background: #fffdf7;
  border: 1px solid var(--rule);
  border-radius: 2px;
}
input:focus { outline: 2px solid var(--green); outline-offset: 1px; }
button {
  margin-top: 0.85rem;
  padding: 0.9rem 2rem;
  font-family: inherit;
  font-size: 1rem;
  color: var(--cream);
  background: var(--green);
  border: 0;
  border-radius: 2px;
  cursor: pointer;
}
button:hover { background: var(--green-hover); }
.reassure {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.68rem;
  letter-spacing: 0.13em;
  text-transform: uppercase;
  color: var(--muted);
}
.examples { font-size: 0.9rem; color: var(--muted); }
.examples a { color: var(--muted); }
a { color: var(--green); }
hr { border: 0; border-top: 1px solid var(--rule); margin: 2.5rem 0; }
.error {
  padding: 0.9rem 1.1rem;
  border-left: 3px solid var(--crit);
  background: #f1e7e0;
  margin-bottom: 1.75rem;
}
.verdict-band { margin: 0 0 0.4rem; }
.verdict-band .tier {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.72rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}
.tier-clean { color: var(--ok); }
.tier-warnings { color: var(--warn); }
.tier-do-not-install { color: var(--crit); }
.target {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.78rem;
  color: var(--muted);
  word-break: break-all;
  margin-bottom: 2rem;
}
.summary { font-size: 1.15rem; }
.finding {
  border-top: 1px solid var(--rule);
  padding: 1.05rem 0;
}
.finding:last-of-type { border-bottom: 1px solid var(--rule); }
.finding .sev {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.63rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
}
.finding .sev.critical { color: var(--crit); }
.finding .sev.warning { color: var(--warn); }
.finding .sev.clean { color: var(--ok); }
.finding p { margin: 0.35rem 0 0.4rem; }
.finding .cite {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.72rem;
  color: var(--muted);
  word-break: break-all;
}
ul { padding-left: 1.15rem; margin: 0 0 1rem; }
li { margin-bottom: 0.45rem; }
blockquote {
  margin: 0 0 1rem;
  padding-left: 1rem;
  border-left: 2px solid var(--rule);
  font-size: 0.95rem;
  color: var(--muted);
}
blockquote .src {
  display: block;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.68rem;
  margin-top: 0.35rem;
}
footer {
  margin-top: 4rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--rule);
  font-size: 0.82rem;
  color: var(--muted);
}
.note-box {
  font-size: 0.88rem;
  color: var(--muted);
  background: #f0ebdd;
  padding: 0.85rem 1.05rem;
  border-radius: 2px;
  margin-bottom: 1.5rem;
}
@media (max-width: 34rem) {
  .wrap { padding: 2.5rem 1.15rem 3.5rem; }
  button { width: 100%; }
}
`;

export function page(opts: {
  title: string;
  body: string;
  contact: string;
  wide?: boolean;
  status?: number;
}): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<meta name="description" content="Install-time trust reports for agent-facing tooling. Paste a repository URL and see what installing it would actually do.">
<style>${STYLES}</style>
</head>
<body>
<main class="wrap${opts.wide ? " wide" : ""}">
${opts.body}
<footer>
<p>chainoftrust.dev reports what a repository says it does at install time. It never runs the installer, never installs the package, and never executes anything from the repository. Every finding cites the file or API field it came from so you can check it yourself.</p>
<p>Corrections and disputes: <a href="mailto:${esc(opts.contact)}">${esc(opts.contact)}</a></p>
</footer>
</main>
</body>
</html>`;
  return new Response(html, {
    status: opts.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The page has no third-party anything. Say so in a header, since the
      // product's whole claim is about what software is allowed to reach.
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}
