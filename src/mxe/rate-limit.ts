/**
 * Fixed-window limits for the function 3 intake API: per client and overall.
 * Every accepted rating costs the AA a devnet computation, so the API cannot
 * be an open tap. In memory — one Railway instance, and a restart resetting
 * the window is acceptable for a limiter.
 */
export interface Limits {
  perClient: number;
  perClientWindowMs: number;
  global: number;
  globalWindowMs: number;
}

export const INTAKE_LIMITS: Limits = {
  perClient: Number(process.env.MXE_INTAKE_PER_IP_PER_HOUR ?? 3),
  perClientWindowMs: 3_600_000,
  global: Number(process.env.MXE_INTAKE_PER_DAY ?? 30),
  globalWindowMs: 86_400_000,
};

export class RateLimiter {
  private clients = new Map<string, { start: number; n: number }>();
  private all = { start: 0, n: 0 };
  constructor(private readonly limits: Limits, private readonly now: () => number = Date.now) {}

  /** Counts the attempt if allowed; otherwise says how long to wait. */
  take(client: string): { ok: true } | { ok: false; retryAfterSec: number; scope: "client" | "global" } {
    const t = this.now();
    if (t - this.all.start >= this.limits.globalWindowMs) this.all = { start: t, n: 0 };
    let c = this.clients.get(client);
    if (!c || t - c.start >= this.limits.perClientWindowMs) c = { start: t, n: 0 };
    if (this.all.n >= this.limits.global) {
      return { ok: false, scope: "global", retryAfterSec: Math.ceil((this.all.start + this.limits.globalWindowMs - t) / 1000) };
    }
    if (c.n >= this.limits.perClient) {
      return { ok: false, scope: "client", retryAfterSec: Math.ceil((c.start + this.limits.perClientWindowMs - t) / 1000) };
    }
    c.n++;
    this.all.n++;
    this.clients.set(client, c);
    return { ok: true };
  }
}
