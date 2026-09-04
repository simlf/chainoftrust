import type { SummaryProvider, TokenRate } from "./verdict/writeup";

export interface Env {
  DB: D1Database;

  MODEL_BUDGET_CENTS_PER_MONTH: string;
  MODEL_ID: string;
  FRESH_ANALYSES_PER_IP_PER_DAY: string;
  CONTACT_EMAIL: string;

  /**
   * Where the OpenAI-compatible summary calls go. Only read when
   * OPENROUTER_API_KEY is set; defaults to OpenRouter itself. Operator
   * configuration, so pointing it elsewhere is an egress decision.
   */
  OPENROUTER_BASE_URL?: string;

  /**
   * Token rate for the budget guard as "input,output" in micro-cents
   * (1e-6 US cent) per token. The built-in table only knows Anthropic models,
   * and prices anything else at the most expensive rate it knows, so set this
   * when MODEL_ID names a model the table does not. Absent or malformed falls
   * back to the table, which can only stop the spend early, never late.
   */
  MODEL_RATE_MICRO_CENTS?: string;

  /** Secrets. All optional: absent degrades behaviour, never breaks it. */
  ANTHROPIC_API_KEY?: string;
  /** Wins over ANTHROPIC_API_KEY: presence selects the OpenAI-compatible path. */
  OPENROUTER_API_KEY?: string;
  GITHUB_TOKEN?: string;
  /** Salt for the rate limiter's IP digests. Absent leaves them enumerable. */
  RATE_LIMIT_SALT?: string;
}

export interface Config {
  budgetCents: number;
  modelId: string;
  modelRate?: TokenRate;
  ratePerDay: number;
  contact: string;
  provider?: SummaryProvider;
  githubToken?: string;
  rateLimitSalt?: string;
}

const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export function readConfig(env: Env): Config {
  const rate = rateOr(env.MODEL_RATE_MICRO_CENTS);
  const provider = providerFor(env);
  return {
    budgetCents: intOr(env.MODEL_BUDGET_CENTS_PER_MONTH, 300),
    modelId: env.MODEL_ID || "claude-haiku-4-5",
    ...(rate ? { modelRate: rate } : {}),
    ratePerDay: intOr(env.FRESH_ANALYSES_PER_IP_PER_DAY, 5),
    contact: env.CONTACT_EMAIL || "hello@chainoftrust.dev",
    ...(provider ? { provider } : {}),
    ...(env.GITHUB_TOKEN ? { githubToken: env.GITHUB_TOKEN } : {}),
    ...(env.RATE_LIMIT_SALT ? { rateLimitSalt: env.RATE_LIMIT_SALT } : {}),
  };
}

/**
 * Which key is set decides where the summary call goes. An OpenRouter key wins
 * when both are set, because setting it is the deliberate later act; neither
 * key means degraded mode, which is supported, not an outage.
 */
function providerFor(env: Env): SummaryProvider | undefined {
  if (env.OPENROUTER_API_KEY) {
    return {
      kind: "openai-compat",
      apiKey: env.OPENROUTER_API_KEY,
      baseUrl: (env.OPENROUTER_BASE_URL || OPENROUTER_DEFAULT_BASE_URL).replace(/\/+$/, ""),
    };
  }
  if (env.ANTHROPIC_API_KEY) {
    return { kind: "anthropic", apiKey: env.ANTHROPIC_API_KEY };
  }
  return undefined;
}

function intOr(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function rateOr(raw: string | undefined): TokenRate | undefined {
  const match = /^(\d+)\s*,\s*(\d+)$/.exec(raw?.trim() ?? "");
  if (!match) return undefined;
  return { input: Number(match[1]), output: Number(match[2]) };
}
