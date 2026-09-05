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

## Verdict calibration

`do-not-install` is deliberately hard to reach: all eight validation targets
landed on clean or warnings. If a change makes a mainstream project reach that
tier, the change is wrong, not the project. A wrong verdict attached to a named
public repository is the failure this product cannot afford.

## Spend guarantees: caching and honest degradation

Two guarantees the launch depends on, both enforced in `handleAnalyse`
(`src/index.ts`) and proven in `test/reanalysis.test.ts`: the same repository
at the same commit SHA is never re-collected or re-summarised (exact-key cache
hit, before any rate limit is even consumed); a submission naming no explicit
ref or commit that already has a report is served that report by default, with
a visible newer-commit notice and an explicit refresh form, not silently
re-analysed. Re-analysing is gated by `MIN_REANALYSIS_INTERVAL_MS` per
repository, composed with the existing per-IP counters in `store.ts` rather
than duplicating them. An explicit ref or commit in the submitted URL
(`target.requestedRef !== ""`) always bypasses this gate: pasting a pin is
already the deliberate act.

Why there is no written summary is persisted, not just decided at write time:
`writeup_degraded_reason` in D1 (migration `0003`) carries `"no-key"` (never
configured), `"budget"` or `"error"` (a configured provider produced nothing
this time) through to every cached read. `degradedNotice()` in
`src/ui/pages.ts` is the only place that turns that into prose, and it is
deliberately unable to say more than the reason it was given; extending
`WriteupResult.degradedReason` in `src/verdict/writeup.ts` with a new case
needs a matching case there or it silently falls back to the reason-agnostic
wording.

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
