# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Orientation

Start with `README.md` (what it checks, how to run and deploy) and
`docs/seed-dataset.md` (what the two prior audits established and what it became
in code). The design this implements is `data/chainoftrust/DRAFT.md` and its
validation is `data/cot-validate/report.md`, both outside this repository.

## The sandbox rule is the one that cannot be relaxed

Target repository content is untrusted input. **Never clone a target, never
extract an archive, never execute anything from one, and never give a target's
files a path into an agent harness.** `src/lib/fetcher.ts` is the whole network
boundary: an egress allowlist, a fetch budget, a per-file byte cap, and
`redirect: "manual"`. Adding a host to that allowlist is a security decision,
not a convenience.

This is not theoretical. Merely cloning a repository registered its skills into
the auditing agent's own harness on three of eight targets during the
validation. Reading a file listing instead of a checkout is what makes the
hazard structurally unreachable.

Repository prose does reach the model, deliberately. It goes inside a
nonce-fenced untrusted block with envelope-imitating text flattened
(`src/verdict/writeup.ts`). Any change there needs `test/verdict.test.ts` to
still pass. The summary provider is configuration (`src/env.ts`: an OpenRouter
key wins, then Anthropic, else degraded mode), and the isolation guarantees
hold on every provider path: `test/provider.test.ts` proves them on the
OpenAI-compatible wire shape, so a new provider needs the same proof.

## Two calibration traps, both found by running against real repositories

1. **Score distinct concerns, not findings.** A project shipping `install.sh`
   and `install.ps1` states the same defect twice. Every finding carries a
   `concern` id; `src/verdict/score.ts` counts each once at its worst severity.
   A new finding without a `concern` silently collapses into its check id.
2. **Fixtures are not enough.** Both of the real bugs in this pipeline survived
   a passing test suite and died on first contact with `ollama/ollama`. After
   changing a collector, run it live (`npm run dev`, then POST to `/analyse`
   as form-encoded `target=<url>`, not JSON) against a real target before
   believing the tests.
3. **Presence detection and content fetching are two separate mechanisms that
   drift apart.** `agent-config.ts`'s `PATTERNS` match by regex against every
   tree path (any depth, free). `prose.ts`'s `PROSE_CANDIDATES` and
   `selectFiles()` in `index.ts` match by *exact string* against a fixed list
   (bounded by `MAX_FILES`) — a file only gets its content read if its literal
   path is in that list. `renatoworks/strudel-claude` kept `CLAUDE.md` at
   `.claude/CLAUDE.md`: the regex-based presence check would have caught it at
   any depth once anchored right, but the literal candidate list still needed
   the exact nested path added by hand. A new conventional agent-config
   location needs both updated, not just one.
4. **The install-path elevation schematic (`src/ui/elevation.ts`) reads
   `Report.findings` by concern id string, not by a shaped type.** There is no
   structured install-path shape in `types.ts`; the schematic derives release,
   installer, binary and daemon facts from `install-path:*` concern ids
   `index.ts` already emits, the same way `chainOfTrust()` derives its chain
   from severities. It anchors "an installer exists to draw at all" on the
   concern `install-path:sudo`, which `installPathFindings()` pushes exactly
   once per script found, clean or not. Renaming or dropping any of the
   `install-path:*` concern ids in `index.ts` silently breaks the schematic
   with no type error; `test/elevation.test.ts` is what would catch it.

## `.github/workflows/deploy.yml` has never gone green

Every run of the `Deploy` workflow on `main` fails on the same step
(`gh-axi run list --workflow=deploy.yml`): `CLOUDFLARE_API_TOKEN` is not set as
a repo secret (`gh-axi secret list` returns none). Production is real and
live regardless (see the custom domain section below) because every deploy so
far has been pushed by hand with `wrangler deploy` from a machine that has the
token locally. Do not treat a green CI run as the signal that a change is
live, and do not add work that depends on this workflow succeeding without
confirming the secret has been set.

## The account is on Workers Free, and `wrangler.jsonc` must stay deployable on it

Production runs on the Workers Free plan deliberately: it is the only Cloudflare
configuration with a real $0 ceiling (see `docs/cloudflare-spend-controls.md`).
A `"limits"` block (`cpu_ms`/`subrequests`) in `wrangler.jsonc` is rejected
outright on Free (`wrangler deploy` errors with code 100328, "CPU limits are
not supported for the Free plan") — do not add one back. The plan's own native
caps (10ms CPU, 50 subrequests) are already stricter than anything worth
configuring there, so its absence costs nothing. If a future change genuinely
needs a higher per-invocation ceiling, that is a plan upgrade decision, not a
config tweak — treat it the same as any other cost-incurring change.

## Custom domain and contact address

Production serves `chainoftrust.dev` and `www.chainoftrust.dev` as Workers
custom domains (`wrangler.jsonc` `routes`), both free-plan compatible. The
www-to-apex redirect lives in `src/index.ts` (top of `fetch()`), not a
Cloudflare Page Rule or Redirect Rule: the deploying OAuth token only carries
`workers_routes:write`, not a page_rules/DNS scope, so zone-level redirects
are unreachable from this session. `SITE_URL` in `src/ui/layout.ts` is the
single source for the canonical host used in `og:url`/canonical meta.

`config.contact` (`src/env.ts`, sourced from the `CONTACT_EMAIL` var in
`wrangler.jsonc`) is `contact@chainoftrust.dev`, an Email Routing alias on the
zone forwarding to the personal inbox behind it. Set up via raw Cloudflare API
calls (no wrangler CLI subcommand for Email Routing exists): destination
address, `zones/{id}/email/routing/enable`, then a routing rule. Never put a
personal email address back into this repo or the shipped pages; change the
alias's destination in the Cloudflare dashboard instead.

## The summary provider is live, and has no logging by design

Production runs the OpenAI-compatible summary path against Chutes
(`OPENROUTER_BASE_URL=https://llm.chutes.ai/v1`, `MODEL_ID`
`deepseek-ai/DeepSeek-V4-Flash-0731-TEE`, `OPENROUTER_API_KEY` set), chosen
for low per-token cost; any OpenAI-compatible `/chat/completions` host works
there, OpenRouter or otherwise. `writeUp()` (`src/verdict/writeup.ts`)
deliberately has no `console.*` calls anywhere in `src/` (grep confirms it),
so `wrangler tail` never shows *why* a report degraded, only that it did not
throw. To tell a real provider failure from budget/no-key degradation in
production: check `model_spend` in D1 (`wrangler d1 execute chainoftrust
--remote --command "SELECT * FROM model_spend"`) for a charge, and check the
tail event's `wallTime` against `cpuTime` — a call that actually reached the
provider blocks on network wait (seconds of wallTime, single-digit-ms
cpuTime), while a same-millisecond return means it degraded before ever
calling out. `MODEL_RATE_MICRO_CENTS` is unset for this model (not in the
built-in Anthropic-only table), so the budget guard prices it at the table's
most expensive known rate, not Chutes' real (much cheaper) rate; that only
makes the guard trip earlier than necessary, never later.

## Verdict calibration

`do-not-install` is deliberately hard to reach: all eight validation targets
landed on clean or warnings. If a change makes a mainstream project reach that
tier, the change is wrong, not the project. A wrong verdict attached to a named
public repository is the failure this product cannot afford.

## Publication

No verdict on a third-party repository is published until the dispute policy
exists. That means no public index and no seeded rows, with one deliberate,
narrow exception: the hardcoded `SHOWCASE` array (`src/ui/pages.ts`) puts a
handful of favourable-or-neutral example reports on the landing page. See
`docs/seed-dataset.md` for the policy and the carve-out it permits.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
