# chainoftrust

**Should I let my agent install this?**

Install-time trust reports for agent-facing tooling: CLIs, MCP servers, agent
skills, plugins and `curl | sh` installers. Paste a repository URL and get a
report on what installing it would actually do.

Free, no account required. Verdicts are public.

## What it checks

Not a vulnerability scanner. Where an existing tool is authoritative it is
cited rather than duplicated: OpenSSF Scorecard for maintenance hygiene, Socket
for registry package alerts. The question here is what a piece of software asks
permission to do when you install it.

| Check | Question |
|---|---|
| **Install path** | Does an installer exist, does the release publish checksums or signatures, and **can the verification code actually run**? Package-manifest lifecycle scripts fold in here as one cheap field. |
| **Agent config** | Does the repository ship hooks, skills, MCP registrations or plugin manifests, and does an installer write into `~/.claude` and friends? |
| **Registry provenance** | For npm and PyPI targets with no installer to read, does the registry entry bind the published files to the build that produced them? |
| **Blast radius** | Which environment variables and hosts does the install path touch, and are any of them credential-shaped? |
| **Trust root** | How concentrated are publishing rights, and what is the repository's real lineage? |
| **Unauditable surface** | How much of what you would receive cannot be reviewed by reading it? |

Two of these carry the product. **Install-path reachability** is the difference
between "the word checksum appears" and "the verification branch can execute":
the second found four distinct defects across four projects where the first
found none. **Agent-config auto-discovery** fires on file presence alone, before
any install step, which is a mechanism no existing scanner models.

Every finding cites the file, line or API field it came from. Every report ends
with what was **not** checked, which is as load-bearing as the findings: it is
the difference between this and a scanner that implies completeness.

## Analysis sandbox

Repository content is untrusted input, and this product exists partly because
merely cloning a repository can register its skills into the harness that
cloned it.

So there is no clone. Files are read one at a time over HTTPS into Worker
memory. A Worker has no shell, no filesystem and no process spawning, which
makes "never execute the target" structural rather than a rule somebody has to
remember. Egress is restricted to five hosts, redirects are not followed, and
there is a fetch budget and a per-file byte cap.

Repository prose does reach the model, because the validation showed the best
findings live there. It reaches it inside a nonce-fenced block labelled
untrusted, with envelope-imitating text flattened, and a system prompt that
says the block is data. Three independent measures, tested in
`test/verdict.test.ts`.

## Running it

```bash
npm install
npx wrangler d1 create chainoftrust       # paste the id into wrangler.jsonc
npm run db:migrate:local
npm run dev                               # http://localhost:8787
```

Works with no secrets. Without `ANTHROPIC_API_KEY` every report is served in
degraded mode: the deterministic verdict and all findings, no written summary.
That is a supported mode, not an outage.

```bash
npm test          # the whole suite runs offline, no network
npm run typecheck
```

## Deploying it

Infrastructure as code. `wrangler.jsonc` and `migrations/` are committed, and
there are no dashboard steps.

```bash
npx wrangler d1 create chainoftrust       # one time; paste the id in
npm run db:migrate:remote
npx wrangler secret put ANTHROPIC_API_KEY # optional, enables the write-up
npx wrangler secret put GITHUB_TOKEN      # optional, raises the API rate limit
npx wrangler secret put RATE_LIMIT_SALT   # optional, salts the stored IP digests
npm run deploy
```

`.github/workflows/deploy.yml` does the same on a push to `main`, given a
`CLOUDFLARE_API_TOKEN` repository secret, plus `CLOUDFLARE_ACCOUNT_ID` if the
token can see more than one account.

### Cost controls

Read `docs/cloudflare-spend-controls.md` before exposing this publicly. The
summary: **Cloudflare has no hard spend cap.** Budget alerts are informational
and fire a day late. The Workers Free plan is the only configuration with a
real ceiling, because it refuses requests instead of billing for them.

What this repository does instead:

- `limits.cpu_ms` and `limits.subrequests` in `wrangler.jsonc`, both well below
  the platform defaults, as denial-of-wallet guards.
- `MODEL_BUDGET_CENTS_PER_MONTH`, a hard monthly ceiling checked before every
  model call. On reaching it the service **degrades to a deterministic verdict
  without prose** rather than refusing service or spending more.
- Cache by commit SHA. The same commit is never analysed twice, and a cache hit
  costs nothing and never counts against a quota.
- 5 fresh analyses per IP per UTC day. An analysis that fails before a report is
  stored is refunded, but only a bounded number of times a day, so the limit
  bounds the work one address can drive and not just the reports it receives.
- 10 submissions per IP per UTC day that resolve to no repository or package are
  free, counted separately, so a mistyped name costs no analysis. Past that,
  a submission spends one of the five analysis slots before it is resolved, so a
  scripted replay of a name that does not exist runs out while an address that
  still has slots can analyse something real.

The default budget of 300 cents/month is deliberately below the draft's 30 EUR
envelope. Raise the variable to spend more.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MODEL_BUDGET_CENTS_PER_MONTH` | `300` | Hard ceiling on model spend per UTC month |
| `MODEL_ID` | `claude-haiku-4-5` | Small model for the write-up |
| `FRESH_ANALYSES_PER_IP_PER_DAY` | `5` | Cache hits are exempt |
| `CONTACT_EMAIL` | | Shown in the footer for corrections |

Secrets: `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `RATE_LIMIT_SALT`. All optional;
absent degrades behaviour rather than breaking it. Without `RATE_LIMIT_SALT`
the rate limiter's IP digests are salted with the UTC day alone, which rotates
them daily but leaves them enumerable by anyone who can read the table.

## The API

Verdicts are public and machine-readable, so an agent can read one before
installing something.

```
GET /r/github/:owner/:name            latest report for a repository
GET /r/github/:owner/:name/:sha       report pinned to a commit
GET /api/v1/verdict/github/:owner/:name[/:sha]     same, as JSON
```

Add `?format=json` to any report URL. JSON responses are CORS-open and cached
for an hour. Reports are generated on submission from the site, not on demand
from the API, so an unanalysed target returns 404 rather than triggering work.

## Design decisions

**A plain Worker with server-rendered HTML, not SvelteKit.** Two pages, one
form, no client-side state, no hydration. The rendered bundle is one Worker
with no framework runtime, no build step beyond esbuild, and nothing shipped to
the browser except HTML and inline CSS: no JavaScript at all, which the CSP
enforces. Given that the product's whole claim is about what software is
allowed to reach, a page that ships zero script and zero third-party requests
is the argument, not just the implementation.

**A small model, by design and by instruction.** The draft budgets the free
tier as deterministic collectors plus a small model for the write-up, and the
validation measured evidence bundles at 560 to 4,500 tokens. The model never
discovers anything; it weighs and explains findings the collectors already
established. `MODEL_ID` is a variable, so trading up is a config change.

**Verdict tiers are arithmetic over distinct concerns.** Not per finding: a
project shipping `install.sh` and `install.ps1` states the same defect twice,
and counting both tipped a mainstream project over the do-not-install line on
nothing but platform coverage. See `src/verdict/score.ts`.

**`do-not-install` is deliberately hard to reach.** All eight targets in the
validation landed on clean or warnings. A tier that fires easily is a tier
nobody believes, and a wrong verdict attached to a named public project is the
failure this product cannot afford.

## Not decided yet

- Pricing and paid tiers.
- The dispute path for a public verdict on a third-party repository. Until it
  exists there is no public index of analysed repositories and no seeded
  verdicts. See `docs/seed-dataset.md`.

## Licence

MIT. See `LICENSE`.
