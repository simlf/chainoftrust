# Can Cloudflare enforce a hard spend cap?

Investigated 2026-08-09 against Cloudflare's own documentation, because this
service is going to be exposed publicly with no account and no payment wall,
and the captain asked to know the answer before that happens.

## The short answer

**No. Cloudflare has no hard spend cap on a paid account.** Nothing you can
configure will make Cloudflare stop serving requests when a dollar figure is
reached. Budget alerts exist, and they are informational only.

There is exactly one way to get a genuine ceiling from Cloudflare, and it is
not a cap you set: **stay on the Workers Free plan**, whose limits are enforced
by refusing requests rather than by billing for them.

## What Cloudflare actually offers

| Control | What it does | Is it a cap? |
|---|---|---|
| Budget alerts | Emails you when cumulative usage-based spend for the cycle crosses a threshold you set. Since 2026-06-15, Pay-as-you-go accounts get one at $10 by default. | **No.** The documentation is explicit: "The alert is informational only. It does not cap your usage or impact your account in any way." |
| Billable Usage dashboard | Shows current-period spend per product, aligned to your billing cycle. | No. Reporting only. |
| Workers Free plan limits | 100,000 requests/day. Past that, Cloudflare returns **Error 1027** and does not bill. | **Yes**, and it is the only real one. |
| `limits.cpu_ms` in wrangler config | Caps CPU time per invocation. Cloudflare documents this as the control "to prevent accidental runaway bills or denial-of-wallet attacks". | Per request, not per month. |
| `limits.subrequests` in wrangler config | Caps outbound fetches per invocation. | Per request, not per month. |
| WAF rate limiting rules | Refuses requests above a rate you set, before the Worker runs. | Bounds request rate, not spend. |

Two timing details that matter if you plan to rely on alerts:

- Usage is processed once per day for the previous day's activity, so an alert
  fires the day **after** the threshold is crossed.
- Budget alerts count only usage-based products. The flat $5 Workers Paid
  subscription is not included in the threshold calculation.

## What this repository does about it

Three layers, in the order they bite.

**1. Per-invocation ceilings, committed in `wrangler.jsonc`.**

```jsonc
"limits": { "cpu_ms": 10000, "subrequests": 60 }
```

Both are far below the platform defaults. A runaway analysis is killed by the
runtime rather than billed. `src/index.ts` additionally holds its own fetch
budget of 34 and refuses to exceed it, so the wrangler limit is a backstop to
the application limit rather than the first line.

**2. The application-level model budget, which is the real guard.**

Cloudflare compute is not where the money is. The draft says so plainly and it
is still true: compute per analysis is a fraction of a cent; the model pass is
two to three orders of magnitude more. So the only unbounded cost in this
system is the Anthropic API, and Cloudflare could not cap that even if it had a
spend cap, because it is not Cloudflare's bill.

`MODEL_BUDGET_CENTS_PER_MONTH` is a hard monthly ceiling enforced in
`src/verdict/writeup.ts` before any request is sent. The check estimates the
worst-case cost of the call it is about to make and refuses if that would
exceed what is left. When it refuses, the service **degrades rather than
stops**: the deterministic verdict is served without the written summary. The
findings are the product; the prose is the finish on them.

**Say it plainly, because it is the honest version:** if Cloudflare's own free
tier is not the ceiling, the application-level guard is the only thing standing
between a traffic flood and a bill, and it is code we wrote. It is tested
(`test/verdict.test.ts`) and it fails closed, but it is not a platform
guarantee.

**3. Everything else that bounds volume.**

- Cache by commit SHA: a repository submitted a thousand times costs one
  analysis, and a cache hit never reaches the model.
- 5 fresh analyses per IP per UTC day, charged only when an analysis really
  runs. Reading an existing verdict at its own address is unlimited.
- 100 submissions per IP per UTC day. Resolving a submission always reaches
  GitHub or a registry, so that is what this counter bounds.
- The egress allowlist in `src/lib/fetcher.ts` means a hostile repository
  cannot make the Worker fetch anything it did not choose to fetch.

## Recommendation

**Deploy on the Workers Free plan first.** It is the only configuration where
Cloudflare itself guarantees a $0 ceiling, and this workload plausibly fits: it
is I/O bound, cache-heavy, and rate-limited. The constraints to watch are
10 ms CPU and 50 subrequests per request, against our budget of 34, so the
subrequest headroom is thin but real.

If the CPU limit turns out to bind, move to Workers Paid at $5/month fixed and
accept that from then on:

- the only hard ceiling is the application's own model budget, and
- the earliest warning of anything else is a budget alert arriving a day late.

Set a budget alert anyway, at a threshold near the intended monthly total. It
will not stop anything, but a day-late email beats a month-end surprise.

## Sources

- <https://developers.cloudflare.com/billing/manage/budget-alerts/>
- <https://developers.cloudflare.com/changelog/post/2026-06-15-budget-alerts-default-on/>
- <https://developers.cloudflare.com/workers/platform/limits/>
- <https://developers.cloudflare.com/workers/platform/pricing/>
- <https://developers.cloudflare.com/workers/wrangler/configuration/#limits>
