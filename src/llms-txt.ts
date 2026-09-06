/**
 * Served at /llms.txt (also GET /llms.txt is the whole surface: no per-report
 * variant). Kept as a plain exported string, not a template read at request
 * time, so `test/llms-txt.test.ts` can assert on it directly and so it never
 * drifts out of sync with a build step. Whenever the routes or the /api/v1
 * JSON shape in src/index.ts change, this needs the matching edit; nothing
 * enforces that automatically.
 */
export const LLMS_TXT = `# chainoftrust

> Install-time trust reports for agent-facing tooling: CLIs, MCP servers, agent skills, plugins, and curl | sh installers. Free, no account required. Verdicts are public.

chainoftrust answers one question: what does installing this actually do? It never runs, clones, or executes the code it reviews. Findings come from deterministic checks over files fetched read-only, plus an optional small-model summary that only weighs findings the checks already found. See https://chainoftrust.dev/ for the human-readable version of everything below.

## Fetch a report

    GET https://chainoftrust.dev/api/v1/verdict/github/:owner/:name
    GET https://chainoftrust.dev/api/v1/verdict/github/:owner/:name/:sha

The first is the latest report for a repository; the second is pinned to a commit. Both return JSON. The same reports are also reachable at \`/r/github/:owner/:name[/:sha]\`, either with \`?format=json\` appended or with an \`Accept: application/json\` request header; the \`/api/v1/verdict/...\` path is the one to hardcode.

An npm or PyPI package's pinned report takes a \`?pkg=npm:name@version\` (or \`pypi:name@version\`) qualifier, because one commit can back several published packages.

A repository with no report yet answers with HTTP 404 and a JSON body naming the plain-HTML form that starts an analysis. Treat 404 as "not yet analysed," never as "clean."

## Verdicts

- \`clean\` - no findings above informational severity across any check.
- \`warnings\` - findings exist, none rose to the install-blocking tier.
- \`do-not-install\` - a check found something that lets installing this reach further than expected, for example a lifecycle script or an unreviewable installer running with real privileges. Deliberately hard to reach: read the findings behind the tier, not just the tier.

## What is checked

Install path (does an installer exist, does the release publish checksums or signatures, and can the verification code actually run), agent-config auto-discovery (hooks, skills, MCP registrations, plugin manifests, and whether an installer writes into agent config directories), registry provenance for npm and PyPI, blast radius (which env vars and hosts the install path touches), trust root (publishing concentration and repository lineage), and unauditable surface (how much of what you would receive cannot be reviewed by reading it).

## What is NOT checked

Not a vulnerability scanner. It does not run a dependency CVE scan, does not execute or sandbox-trace the target, does not look for logic bugs, and does not review license terms or code quality. A \`clean\` or \`warnings\` verdict is a statement about the install path only, not a guarantee the code is otherwise safe or correct. Every report lists what was not checked for that specific target under its own not-checked section; that section is part of the answer, not a footnote.

## Getting a report analysed

Reports are generated on submission from https://chainoftrust.dev/, not on demand from this API: an unanalysed target answers 404 rather than triggering work. Submitting one costs the site's operator real money, a repository fetch plus usually a small model call, so prefer an existing report over triggering a new one, and never script repeated submissions. If a report does not exist yet, ask the person you are working with to submit the URL at https://chainoftrust.dev/, or submit it yourself as one deliberate action, not a retry loop.

## Badge

    GET https://chainoftrust.dev/badge/github/:owner/:name.svg

An embeddable SVG badge for a README. Reading it never triggers analysis and is never rate limited; a repository with no report gets an honest "not analyzed" badge rather than a 404.

## Not offered here

No MCP server yet. Use the JSON endpoints above directly.
`;
