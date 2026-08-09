import { collect, resolveTarget, TargetNotFound } from "./collect";
import { readConfig, type Config, type Env } from "./env";
import { Fetcher } from "./lib/fetcher";
import { InvalidTarget, parseTarget } from "./lib/target";
import { hashIp, Store, utcDay, type RateLimitResult } from "./store";
import type { StoredVerdict } from "./types";
import { homePage, messagePage, verdictPage, verdictPath } from "./ui/pages";
import { buildReport } from "./verdict/score";
import { writeUp } from "./verdict/writeup";

/** Bounded per analysis. A Worker that cannot loop cannot run up a bill. */
const FETCH_BUDGET = 34;
const MAX_FILE_BYTES = 256 * 1024;

/** Submissions per address per UTC day that resolve to no repository at all. */
const FAILED_RESOLUTIONS_PER_DAY = 10;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = readConfig(env);
    const url = new URL(request.url);
    const store = new Store(env.DB);

    try {
      if (request.method === "GET" && url.pathname === "/") {
        return homePage({ contact: config.contact });
      }

      if (request.method === "GET" && url.pathname === "/healthz") {
        return new Response("ok", { headers: { "content-type": "text/plain" } });
      }

      if (request.method === "POST" && url.pathname === "/analyse") {
        return await handleAnalyse(request, store, config);
      }

      const verdict = matchVerdictPath(url.pathname);
      if (request.method === "GET" && verdict) {
        return await handleVerdictLookup(url, store, config, verdict);
      }

      return messagePage({
        title: "Not found - chainoftrust.dev",
        heading: "Nothing here",
        message: "That address does not correspond to a page or a report.",
        contact: config.contact,
        status: 404,
      });
    } catch {
      return messagePage({
        title: "Error - chainoftrust.dev",
        heading: "Something broke on our side",
        message:
          "The analysis did not complete. Nothing was published. Trying again in a moment is reasonable.",
        contact: config.contact,
        status: 500,
      });
    }
  },
} satisfies ExportedHandler<Env>;

async function handleAnalyse(
  request: Request,
  store: Store,
  config: Config,
): Promise<Response> {
  const form = await request.formData();
  const submitted = String(form.get("target") ?? "");

  let input;
  try {
    input = parseTarget(submitted);
  } catch (err) {
    if (err instanceof InvalidTarget) {
      return homePage({
        contact: config.contact,
        error: err.message,
        prefill: submitted,
        status: 400,
      });
    }
    throw err;
  }

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const ipHash = await hashIp(ip, {
    day: utcDay(),
    ...(config.rateLimitSalt ? { secret: config.rateLimitSalt } : {}),
  });

  // One rule decides every counter on this path: a slot is spent only by work
  // that reached an upstream host and produced something. A reservation is
  // taken before upstream work when this address has already spent the free
  // resolution attempts, and every exit below settles that reservation. A cache
  // hit reaches nothing, so it settles as "reached-nothing" and costs nothing,
  // whatever the address did earlier.
  const failures = await store.resolutionFailures(ipHash);
  if (failures === null) return storageFaultPage(config);

  const meter = new SubmissionMeter(store, ipHash, config.ratePerDay);
  if (failures >= FAILED_RESOLUTIONS_PER_DAY) {
    const reserved = await meter.reserve();
    if (!reserved.allowed) return refusedPage(reserved, config);
  }

  const fetcher = new Fetcher({
    budget: FETCH_BUDGET,
    maxBytesPerFile: MAX_FILE_BYTES,
    ...(config.githubToken ? { githubToken: config.githubToken } : {}),
  });

  let resolved;
  try {
    resolved = await resolveTarget(fetcher, input);
  } catch (err) {
    if (err instanceof TargetNotFound) {
      await meter.settle("resolved-to-nothing");
      await store.recordResolutionFailure(ipHash);
      return homePage({
        contact: config.contact,
        error: err.message,
        prefill: submitted,
        status: 404,
      });
    }
    await meter.settle("upstream-fault");
    throw err;
  }

  // Cache by commit SHA. A hit is free, needs no model call, and deliberately
  // does not touch the rate limiter: punishing cache hits would discourage the
  // exact behaviour this product wants.
  const cached = await store.getVerdict(resolved.target.cacheKey);
  if (cached) {
    await meter.settle("reached-nothing");
    return redirect(verdictPath(cached.report));
  }

  const limit = await meter.reserve();
  if (!limit.allowed) return refusedPage(limit, config);

  try {
    const evidence = await collect(fetcher, resolved);
    const report = buildReport(evidence, new Date());

    const remaining = await store.budgetRemainingMicroCents(config.budgetCents);
    const summary = await writeUp(report, {
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      model: config.modelId,
      budgetRemainingMicroCents: remaining,
    });
    await store.recordSpend(summary.microCents);

    await store.putVerdict(report, summary.text, summary.model);
    await meter.settle("analysed");
    return redirect(verdictPath(report));
  } catch (err) {
    await meter.settle("upstream-fault");
    throw err;
  }
}

/** What a submission turned out to be, once it is over. */
type Outcome =
  /** A report was produced and stored. The only outcome that spends a slot. */
  | "analysed"
  /** No upstream host was reached at all, so nothing may be charged. */
  | "reached-nothing"
  /** Upstream was reached and named no repository or package. */
  | "resolved-to-nothing"
  /** Upstream was reached and failed, or the analysis threw. */
  | "upstream-fault";

/**
 * The one place a submission's slot is decided.
 *
 * A slot may be reserved before upstream work, because the increment is what
 * serialises concurrent submissions from one address, but only the outcome
 * decides whether it stays spent. Releasing a reservation is not a refund and
 * is not capped: the cap exists so a target that always fails cannot be
 * replayed for free, and a submission that reached nothing did no work to
 * forgive. That is what keeps a cache hit free without a special case.
 */
class SubmissionMeter {
  #reserved = false;

  constructor(
    private readonly store: Store,
    private readonly ipHash: string,
    private readonly perDay: number,
  ) {}

  async reserve(): Promise<RateLimitResult> {
    if (this.#reserved) return { allowed: true, used: 0, limit: this.perDay };
    const result = await this.store.consumeRateLimit(this.ipHash, this.perDay);
    this.#reserved = result.allowed;
    return result;
  }

  async settle(outcome: Outcome): Promise<void> {
    if (!this.#reserved || outcome === "analysed") return;
    this.#reserved = false;

    if (outcome === "reached-nothing") {
      await this.store.releaseRateLimit(this.ipHash);
      return;
    }
    // Upstream was reached. A transient failure is forgiven a bounded number of
    // times a day, and a target that fails every time stops being free after
    // that. A resolution that found nothing keeps the slot, which is what
    // bounds a scripted replay of a name that does not exist.
    if (outcome === "upstream-fault") {
      await this.store.refundRateLimit(this.ipHash, this.perDay);
    }
  }
}

/**
 * A refusal the counter could not confirm is still a refusal, but saying the
 * visitor spent a quota they may not have spent would be a false statement on
 * the error page of a product whose claim is verifiable facts.
 */
function refusedPage(limit: RateLimitResult, config: Config): Response {
  if (limit.reason === "unavailable") return storageFaultPage(config);
  return messagePage({
    title: "Daily limit reached - chainoftrust.dev",
    heading: "That is enough fresh analyses for today",
    message: `This address has run ${limit.limit} new analyses today, which is the limit. Reports that already exist stay free and unlimited, so anything analysed before is still available. The counter resets at midnight UTC.`,
    contact: config.contact,
    status: 429,
  });
}

function storageFaultPage(config: Config): Response {
  return messagePage({
    title: "Try again shortly - chainoftrust.dev",
    heading: "We could not start a fresh analysis",
    message:
      "The counter that tracks fresh analyses could not be read, so this submission was not started. Nothing was analysed and nothing was published. Trying again in a moment is reasonable. Reports that already exist stay free and unlimited.",
    contact: config.contact,
    status: 503,
  });
}

interface VerdictMatch {
  owner: string;
  name: string;
  sha?: string;
}

function matchVerdictPath(pathname: string): VerdictMatch | null {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  // /r/github/:owner/:name[/:sha]  and the API alias
  const offset = parts[0] === "api" && parts[1] === "v1" && parts[2] === "verdict" ? 3 : 0;
  if (offset === 0 && parts[0] !== "r") return null;
  const base = offset === 0 ? 1 : offset;
  if (parts[base] !== "github") return null;

  const owner = parts[base + 1];
  const name = parts[base + 2];
  if (!owner || !name) return null;
  const sha = parts[base + 3];
  return sha ? { owner, name, sha } : { owner, name };
}

async function handleVerdictLookup(
  url: URL,
  store: Store,
  config: Config,
  match: VerdictMatch,
): Promise<Response> {
  const wantsJson =
    url.searchParams.get("format") === "json" || url.pathname.startsWith("/api/");

  const stored: StoredVerdict | null = match.sha
    ? await store.getVerdictForQuery(
        match.owner,
        match.name,
        match.sha,
        url.searchParams.get("pkg"),
      )
    : await store.getLatestForRepo(match.owner, match.name);

  if (!stored) {
    if (wantsJson) {
      return json(
        {
          error: "not_analysed",
          message:
            "No report exists for this target yet. Reports are generated on request from the site.",
        },
        404,
      );
    }
    return messagePage({
      title: "No report yet - chainoftrust.dev",
      heading: "No report for that yet",
      message:
        "Nothing has been analysed at that address. Submit the repository from the front page and one will be generated.",
      contact: config.contact,
      status: 404,
    });
  }

  if (wantsJson) {
    return json(
      {
        verdict: stored.report.verdict,
        target: stored.report.target,
        summary: stored.writeup,
        summary_model: stored.writeupModel,
        findings: stored.report.findings,
        not_checked: stored.report.notChecked,
        prose_excerpts: stored.report.proseExcerpts,
        scorecard: stored.report.scorecard ?? null,
        stats: stored.report.stats,
        generated_at: stored.report.generatedAt,
      },
      200,
    );
  }

  return verdictPage(stored, config.contact);
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Verdicts are public by design, so an agent can read one cross-origin.
      "access-control-allow-origin": "*",
      "cache-control": status === 200 ? "public, max-age=3600" : "no-store",
    },
  });
}
