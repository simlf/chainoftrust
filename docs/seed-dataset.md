# Seed dataset

Two audits already exist in this fleet, and their findings are the reason this
pipeline is shaped the way it is. This file records what they established, what
each one became in the code, and what is deliberately **not** published.

## Nothing here is published

**No verdict on a third-party repository is published as part of V1.** The
database ships empty and there is no seeded row for any target named below.

That is a deliberate stop, not an oversight. Verdicts are public by design, but
the disclosure and dispute policy for a verdict on someone else's repository is
a decision that has not been taken. Until it is:

- reports exist only for repositories somebody submitted,
- there is no public index or listing of what has been analysed,
- the footer carries a contact address for corrections.

The evidence below lives here as test fixtures and as calibration, which is
what makes it useful without publishing anything.

## Where the audits landed in the code

| Audit finding | What it became |
|---|---|
| Installer ignores the `checksums.txt` its own release publishes (no-mistakes, treehouse, Ollama) | `install-path:unused-integrity-assets` in `src/collect/index.ts`, plus the release-asset name patterns in `test/release-assets.test.ts` |
| Checksum variables declared but never assigned, so the branch is dead (aider) | `VerificationState = "unreachable"` in `src/collect/shell.ts` |
| Verification silently no-ops when the hashing tool is missing (uv) | `VerificationState = "can-skip-silently"` |
| Installer leaves a daemon running (Ollama, no-mistakes) | `install-path:residency` |
| All artefacts share one publishing account (the `*-axi` family, one npm account) | `trust-root:publish-rights` and `trust-root:concentration` |
| Cloning a repository registered its skills into the auditing agent's harness (3 of 8 targets) | `src/collect/agent-config.ts`, and the no-clone design of `src/lib/fetcher.ts` |
| Registry provenance separates an official package from its typosquat (`@playwright/mcp`) | `registry-provenance:attestation` and `registry-provenance:name-confusion` |
| The best findings came from prose, not manifests | `src/collect/prose.ts` |

## Correction to carry, verified 2026-08-09 on release v1.46.0

The 2026-08-08 toolchain audit recorded that the axi family sends no telemetry.
**That is true of the axi packages and not of `no-mistakes` itself.**

- `no-mistakes` ships a telemetry host compiled into the binary.
- Its self-update path **does** verify checksums, even though `docs/install.sh`
  does not.

So the install gap for `no-mistakes` is client-side and specific to that one
script; the release-side integrity engineering is genuinely strong (Developer ID
codesigning on macOS, `codesign --verify --strict` in CI, a checksums job that
depends on the signed darwin build). Any verdict this pipeline ever produces on
that target must reflect the corrected version, not the earlier summary. The
fixture in `test/fixtures/installers.ts` carries this note inline so it cannot
drift out of view.

## Targets used for calibration

Run live against the real GitHub API during development, not stored:

| Target | Tier | What it exercises |
|---|---|---|
| `ollama/ollama` | warnings | No verification, published checksums ignored, sudo, daemon residency, two installers exercising concern de-duplication |
| `astral-sh/uv` | warnings | Verification that enforces but can skip; agent-config files present in the repository |
| `obra/superpowers` | warnings | Unconditional `SessionStart` hook, 14 skill definitions, no installer at all |

The pipeline independently reproduced the validation report's marquee Ollama
finding, which is the main evidence that the collectors work: the release
publishes `sha256sum.txt` and neither `scripts/install.sh` nor
`scripts/install.ps1` references it.

Two calibration bugs were caught by running against real targets rather than
fixtures, and both are now regression-tested:

1. The release-asset pattern anchored the whole filename, so `sha256sum.txt`
   did not match and the sharpest finding was silently dropped.
2. Scoring counted findings rather than distinct concerns, so a project
   shipping both a `.sh` and a `.ps1` installer double-counted every shared
   defect and tipped a 178,000-star project into `do-not-install`.

## Sources

- `data/cot-validate/report.md` (2026-08-09), the 8-repository validation
- `data/learnings.md` (2026-08-08), the toolchain audit and its follow-up
