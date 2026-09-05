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

Works with no secrets. The written summary at the top of a report runs in one
of three modes, selected by which API key is configured:

| Mode | Selected by | Summary call |
|---|---|---|
| **openrouter** | `OPENROUTER_API_KEY` set (wins when both are) | OpenAI-compatible chat completions, to `OPENROUTER_BASE_URL` (default OpenRouter), with `MODEL_ID` as that host's model id |
| **anthropic** | only `ANTHROPIC_API_KEY` set | Anthropic Messages API, with `MODEL_ID` as the Anthropic model id |
| **none** | neither key set | No call. Deterministic verdict and all findings, no written summary |

Despite the variable name, `OPENROUTER_BASE_URL` accepts any OpenAI-compatible
`/chat/completions` host, not just OpenRouter. Production runs it against
Chutes (`https://llm.chutes.ai/v1`, `MODEL_ID` `deepseek-ai/DeepSeek-V4-Flash-0731-TEE`),
picked for its low per-token cost. Switching providers is that one variable
plus `MODEL_ID`, not a code change.

The **none** row is degraded mode: a supported mode, not an outage. A provider
error or timeout degrades that one report the same way rather than failing it.
Whatever the provider, the model only weighs findings the deterministic
collectors established, and repository prose reaches it only inside the
nonce-fenced untrusted block described above. Summary cost is per fresh
report and model-dependent: an evidence bundle is roughly 1k-5k tokens, so
price it at your chosen model's rate.

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
npx wrangler secret put OPENROUTER_API_KEY # optional, enables the write-up via OpenRouter
npx wrangler secret put ANTHROPIC_API_KEY # optional, enables the write-up via Anthropic
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
  never costs an analysis. Reading an existing verdict at its own address costs
  nothing at all: those URLs do no upstream work and are not rate limited.
- 5 fresh analyses per IP per UTC day. An analysis that fails before a report is
  stored gives its slot back, up to a daily refund allowance. Past that a
  failure costs the slot.
- 100 submissions per IP per UTC day. Every submission to the form resolves its
  target at GitHub or a registry before anything else happens, so that is the
  counter that bounds the upstream work one address can drive, whether or not
  the report turns out to be cached. It is never given back.

The draft's rule was "cache hits unlimited and exempt". This narrows it rather
than discarding it: the draft was written before the resolution step existed, and
resolving a submission has to reach GitHub or a registry to learn which commit is
being asked about, which is real work done on someone else's behalf. So the free
and unlimited half now lives where it is literally true, on the verdict URLs.

The default budget of 300 cents/month is deliberately below the draft's 30 EUR
envelope. Raise the variable to spend more.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MODEL_BUDGET_CENTS_PER_MONTH` | `300` | Hard ceiling on model spend per UTC month |
| `MODEL_ID` | `claude-haiku-4-5` | Small model for the write-up, in the selected provider's id scheme (OpenRouter: `anthropic/claude-haiku-4.5` and friends) |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Where the OpenAI-compatible call goes; only read in openrouter mode. Pointing it elsewhere is an egress decision |
| `MODEL_RATE_MICRO_CENTS` | | `input,output` token rate in micro-cents for the budget guard. The built-in table only knows Anthropic models and prices anything else at its most expensive rate, so set this when `MODEL_ID` names anything else |
| `FRESH_ANALYSES_PER_IP_PER_DAY` | `5` | A cache hit costs none of these |
| `CONTACT_EMAIL` | | Shown in the footer for corrections |

Secrets: `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`,
`RATE_LIMIT_SALT`. All optional;
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

A report on an npm or PyPI package carries a `?pkg=npm:name@version` (or
`pypi:`) qualifier on its pinned URL, because one commit can back several
published packages.

Add `?format=json` to any report URL. JSON responses are CORS-open and cached
for an hour. Reports are generated on submission from the site, not on demand
from the API, so an unanalysed target returns 404 rather than triggering work.

## Design decisions

**A plain Worker with server-rendered HTML, not SvelteKit.** Two pages, one
form, no client-side state, no hydration. The rendered bundle is one Worker
with no framework runtime, no build step beyond esbuild, and nothing shipped to
the browser except HTML, inline CSS and two self-hosted font families served as
Worker static assets (`public/fonts`): no JavaScript at all, which the CSP
enforces, and zero third-party requests. Given that the product's whole claim
is about what software is allowed to reach, a page that ships zero script and
zero third-party requests is the argument, not just the implementation.

The visual direction is "Containment Blueprint": the site is drawn as an
engineering sheet, the sandbox's guarantees are rendered as design elements,
and each report draws the chain of trust itself, one link per check, broken
where trust fails. Where an installer was found, the report also draws it as
a surveyed elevation, release through daemon, with the severed checksum path
dashed and unchecked stages hatched. Both SVGs are generated deterministically
from the findings, like the verdict.

**A small model, by design and by instruction.** The draft budgets the free
tier as deterministic collectors plus a small model for the write-up, and the
validation measured evidence bundles at 560 to 4,500 tokens. The model never
discovers anything; it weighs and explains findings the collectors already
established. `MODEL_ID` is a variable and the provider behind it is selected by
which key is set, so trading up, down or sideways is a config change, not a
deploy of new code.

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
