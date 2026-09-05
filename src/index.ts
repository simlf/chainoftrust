import { collect, resolveTarget, TargetNotFound } from "./collect";
import { readConfig, type Config, type Env } from "./env";
import { Fetcher } from "./lib/fetcher";
import { decodeSegments, InvalidTarget, parseTarget } from "./lib/target";
import { hashIp, Store, utcDay, type RateLimitResult } from "./store";
import type { StoredVerdict } from "./types";
import { homePage, messagePage, verdictPage, verdictPath } from "./ui/pages";
import { buildReport } from "./verdict/score";
import { writeUp } from "./verdict/writeup";

/** Bounded per analysis. A Worker that cannot loop cannot run up a bill. */
const FETCH_BUDGET = 34;
const MAX_FILE_BYTES = 256 * 1024;

/**
 * Submissions per address per UTC day. Every one of them resolves a target,
 * which always reaches upstream, so this is what bounds the work an address can
 * drive. Sized to stop a scripted replay, not to ration a person looking things
 * up: a reader who never runs a fresh analysis still gets a hundred lookups.
 */
const SUBMISSIONS_PER_DAY = 100;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = readConfig(env);
    const url = new URL(request.url);

    if (url.hostname === "www.chainoftrust.dev") {
      url.hostname = "chainoftrust.dev";
      return Response.redirect(url.toString(), 301);
    }

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
        path: url.pathname,
      });
    } catch {
      return messagePage({
        title: "Error - chainoftrust.dev",
        heading: "Something broke on our side",
        message:
          "The analysis did not complete. Nothing was published. Trying again in a moment is reasonable.",
        contact: config.contact,
        status: 500,
        path: url.pathname,
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

  // Two counters, two jobs. Resolving a target always reaches upstream, so
  // every submission spends one submission unit and never gets it back, cached
  // or not. A fresh analysis is the expensive part, so it spends one of the
  // five analysis slots, and only when there is really an analysis to run.
  const submission = await store.consumeSubmission(ipHash, SUBMISSIONS_PER_DAY);
  if (!submission.allowed) return submissionsRefusedPage(submission, config);

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
      return homePage({
        contact: config.contact,
        error: err.message,
        prefill: submitted,
        status: 404,
      });
    }
    throw err;
  }

  // Cache by commit SHA. A hit needs no collection and no model call, so it
  // costs no analysis slot however many times it is asked for.
  const cached = await store.getVerdict(resolved.target.cacheKey);
  if (cached) return redirect(verdictPath(cached.report));

  const limit = await store.consumeRateLimit(ipHash, config.ratePerDay);
  if (!limit.allowed) return refusedPage(limit, config);

  try {
    const evidence = await collect(fetcher, resolved);
    const report = buildReport(evidence, new Date());

    const remaining = await store.budgetRemainingMicroCents(config.budgetCents);
    const summary = await writeUp(report, {
      ...(config.provider ? { provider: config.provider } : {}),
      model: config.modelId,
      ...(config.modelRate ? { rate: config.modelRate } : {}),
      budgetRemainingMicroCents: remaining,
    });
    await store.recordSpend(summary.microCents);

    await store.putVerdict(report, summary.text, summary.model);
    return redirect(verdictPath(report));
  } catch (err) {
    // The analysis produced nothing, so the slot goes back, up to the daily
    // allowance the release path enforces itself. Past that a failure costs the
    // slot, which is what bounds a target that fails on every attempt.
    await store.releaseRateLimit(ipHash);
    throw err;
  }
}

/**
 * A refusal the counter could not confirm is still a refusal, but saying the
 * visitor spent a quota they may not have spent would be a false statement on
 * the error page of a product whose claim is verifiable facts.
 */
function refusedPage(limit: RateLimitResult, config: Config): Response {
  if (limit.reason === "unavailable") return storageFaultPage(config, "fresh analyses");
  return messagePage({
    title: "Daily limit reached - chainoftrust.dev",
    heading: "That is enough fresh analyses for today",
    message: `This address has run ${limit.limit} new analyses today, which is the limit. A report that already exists costs no analysis, and reading one at its own address costs nothing at all, so anything analysed before is still available. The counter resets at midnight UTC.`,
    contact: config.contact,
    status: 429,
  });
}

function submissionsRefusedPage(limit: RateLimitResult, config: Config): Response {
  if (limit.reason === "unavailable") return storageFaultPage(config, "submissions");
  return messagePage({
    title: "Too many submissions today - chainoftrust.dev",
    heading: "That is enough submissions from this address today",
    message: `This address has sent ${limit.limit} submissions today, which is the limit. Every submission looks the target up at GitHub or a registry before anything else happens, so that is what the limit counts. Reports that already exist stay readable at their own addresses, and reading one costs nothing. The counter resets at midnight UTC.`,
    contact: config.contact,
    status: 429,
  });
}

/**
 * Names the counter that actually refused, because two callers reach here and
 * the page of a product whose standard is verifiable facts should not blame the
 * counter that read fine.
 */
function storageFaultPage(config: Config, counter: "submissions" | "fresh analyses"): Response {
  return messagePage({
    title: "Try again shortly - chainoftrust.dev",
    heading: "We could not start a fresh analysis",
    message: `The counter that tracks ${counter} could not be read, so this submission was not started. Nothing was analysed and nothing was published. Trying again in a moment is reasonable. Reports that already exist stay readable at their own addresses.`,
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
  const parts = decodeSegments(pathname);
  if (!parts) return null;
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
      path: url.pathname,
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

  return verdictPage(stored, config.contact, Boolean(match.sha));
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
