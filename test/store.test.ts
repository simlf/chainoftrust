import { describe, expect, it } from "vitest";
import { hashIp, Store } from "../src/store";

/**
 * A minimal in-memory stand-in for the D1 statements the rate limiter issues.
 * It understands only those four shapes and throws on anything else, so a query
 * this fake does not model cannot pass silently.
 */
function fakeDb() {
  const rows = new Map<string, number>();

  const db = {
    rows,
    prepare(sql: string) {
      const text = sql.replace(/\s+/g, " ").trim();
      let args: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          args = values;
          return stmt;
        },
        async run() {
          if (text.startsWith("INSERT INTO rate_limits")) {
            const key = `${args[0]}|${args[1]}`;
            rows.set(key, (rows.get(key) ?? 0) + 1);
            return;
          }
          if (text.startsWith("DELETE FROM rate_limits WHERE day <")) {
            for (const key of [...rows.keys()]) {
              if (key.split("|")[1]! < String(args[0])) rows.delete(key);
            }
            return;
          }
          throw new Error(`unmodelled statement: ${text}`);
        },
        async first<T>(): Promise<T | null> {
          if (text.startsWith("SELECT count FROM rate_limits")) {
            const count = rows.get(`${args[0]}|${args[1]}`);
            return count === undefined ? null : ({ count } as T);
          }
          throw new Error(`unmodelled statement: ${text}`);
        },
      };
      return stmt;
    },
  };
  return db;
}

const today = new Date().toISOString().slice(0, 10);

describe("rate limiting", () => {
  it("writes nothing when it only checks", async () => {
    const db = fakeDb();
    const store = new Store(db as never);

    expect(await store.checkRateLimit("ip", 5)).toMatchObject({ allowed: true, used: 0 });
    expect(await store.checkRateLimit("ip", 5)).toMatchObject({ allowed: true, used: 0 });
    expect(db.rows.size).toBe(0);
  });

  it("counts only the analyses that were consumed", async () => {
    // The failure this protects against: an analysis that threw before storing
    // a report used to spend one of five daily slots for nothing.
    const db = fakeDb();
    const store = new Store(db as never);

    for (let i = 0; i < 3; i++) await store.checkRateLimit("ip", 5);
    await store.consumeRateLimit("ip", 5);

    expect(await store.checkRateLimit("ip", 5)).toMatchObject({ used: 1, allowed: true });
  });

  it("refuses once the day's slots are spent", async () => {
    const db = fakeDb();
    const store = new Store(db as never);

    for (let i = 0; i < 5; i++) await store.consumeRateLimit("ip", 5);

    expect(await store.checkRateLimit("ip", 5)).toMatchObject({ used: 5, allowed: false });
  });

  it("drops counters from days that have passed", async () => {
    const db = fakeDb();
    const store = new Store(db as never);
    db.rows.set("someone|2020-01-01", 4);
    db.rows.set("someone-else|2020-06-01", 2);

    await store.consumeRateLimit("ip", 5);

    expect([...db.rows.keys()]).toEqual([`ip|${today}`]);
  });
});

describe("the stored form of a client address", () => {
  it("never contains the address", async () => {
    const digest = await hashIp("203.0.113.7", { day: "2026-08-10" });
    expect(digest).not.toContain("203.0.113.7");
    expect(digest).toMatch(/^[0-9a-f]{32}$/);
  });

  it("rotates with the UTC day", async () => {
    const a = await hashIp("203.0.113.7", { day: "2026-08-10" });
    const b = await hashIp("203.0.113.7", { day: "2026-08-11" });
    expect(a).not.toBe(b);
  });

  it("changes when the salt secret is set, and is stable while it is", async () => {
    const unsalted = await hashIp("203.0.113.7", { day: "2026-08-10" });
    const salted = await hashIp("203.0.113.7", { day: "2026-08-10", secret: "s3cret" });
    const again = await hashIp("203.0.113.7", { day: "2026-08-10", secret: "s3cret" });

    expect(salted).not.toBe(unsalted);
    expect(again).toBe(salted);
  });

  it("separates two addresses on the same day", async () => {
    const a = await hashIp("203.0.113.7", { day: "2026-08-10", secret: "s" });
    const b = await hashIp("203.0.113.8", { day: "2026-08-10", secret: "s" });
    expect(a).not.toBe(b);
  });
});
