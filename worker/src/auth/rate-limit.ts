import { ApiError } from './index.js';
export type RateDecision = { allowed: boolean; remaining: number; retryAfterSeconds: number };
type Bucket = { tokens: number; updatedMs: number; touchedMs: number };
/** One long-lived instance per fleet DO. Not globally effective in an ephemeral Worker. */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(readonly capacity = 60, readonly refillPerSecond = 1, readonly maxKeys = 10000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isFinite(refillPerSecond) || refillPerSecond <= 0 ||
      !Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new Error('Invalid rate limiter configuration');
  }
  consume(key: string, cost = 1, nowMs = Date.now()): RateDecision {
    if (!key || key.length > 512 || !Number.isFinite(nowMs) || !Number.isFinite(cost) || cost <= 0 || cost > this.capacity) throw new Error('Invalid rate limiter input');
    let bucket = this.buckets.get(key);
    if (!bucket) {
      // Only fully refilled idle entries may be discarded: no LRU churn bypass.
      for (const [k, b] of this.buckets) {
        if (nowMs - b.touchedMs >= this.capacity / this.refillPerSecond * 1000) this.buckets.delete(k);
      }
      if (this.buckets.size >= this.maxKeys) return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil(this.capacity / this.refillPerSecond) };
      bucket = { tokens: this.capacity, updatedMs: nowMs, touchedMs: nowMs }; this.buckets.set(key, bucket);
    }
    const current = Math.max(bucket.updatedMs, nowMs); // Clock rollback must not award credit twice.
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (current - bucket.updatedMs) / 1000 * this.refillPerSecond);
    bucket.updatedMs = current; bucket.touchedMs = current;
    const allowed = bucket.tokens >= cost;
    if (allowed) bucket.tokens -= cost;
    return { allowed, remaining: Math.floor(bucket.tokens), retryAfterSeconds: allowed ? 0 : Math.ceil((cost - bucket.tokens) / this.refillPerSecond) };
  }
  enforce(key: string, cost = 1, nowMs = Date.now()): RateDecision {
    const result = this.consume(key, cost, nowMs);
    if (!result.allowed) throw new ApiError(429, 'RATE_LIMITED', 'Too many requests', result.retryAfterSeconds);
    return result;
  }
}
/** Separate actions so high-volume pings cannot starve dispatcher reads. */
export function principalRateKey(claims: { fleet_id: string; sub: string }, action: string): string {
  return JSON.stringify([claims.fleet_id, claims.sub, action]);
}
