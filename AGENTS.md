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

## Verdict calibration

`do-not-install` is deliberately hard to reach: all eight validation targets
landed on clean or warnings. If a change makes a mainstream project reach that
tier, the change is wrong, not the project. A wrong verdict attached to a named
public repository is the failure this product cannot afford.

## Publication

No verdict on a third-party repository is published until the dispute policy
exists. That means no public index and no seeded rows. See `docs/seed-dataset.md`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
