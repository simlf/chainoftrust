export interface Env {
  DB: D1Database;

  MODEL_BUDGET_CENTS_PER_MONTH: string;
  MODEL_ID: string;
  FRESH_ANALYSES_PER_IP_PER_DAY: string;
  CONTACT_EMAIL: string;

  /** Secrets. Both optional: absent degrades behaviour, never breaks it. */
  ANTHROPIC_API_KEY?: string;
  GITHUB_TOKEN?: string;
}

export interface Config {
  budgetCents: number;
  modelId: string;
  ratePerDay: number;
  contact: string;
  apiKey?: string;
  githubToken?: string;
}

export function readConfig(env: Env): Config {
  return {
    budgetCents: intOr(env.MODEL_BUDGET_CENTS_PER_MONTH, 300),
    modelId: env.MODEL_ID || "claude-haiku-4-5",
    ratePerDay: intOr(env.FRESH_ANALYSES_PER_IP_PER_DAY, 5),
    contact: env.CONTACT_EMAIL || "hello@chainoftrust.dev",
    ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
    ...(env.GITHUB_TOKEN ? { githubToken: env.GITHUB_TOKEN } : {}),
  };
}

function intOr(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
