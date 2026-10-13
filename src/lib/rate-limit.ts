// 10X RPC — shared per-IP fixed-window rate limiter.
//
// Used by auth endpoints (token login, demo login) and expensive/cron-ish
// routes (keep-alive, rotator tick, sleep-timer check) to stop resource
// abuse and brute-force attempts.
//
// NOTE: this is in-memory and per serverless instance — on Vercel each
// warm instance keeps its own counters. It is a best-effort guard (burst
// protection), not a distributed quota. If heavier limiting is ever needed,
// back it with a shared store (e.g. Upstash Redis).

type Bucket = { count: number; resetAt: number }

const buckets = new Map<string, Bucket>()

// Periodically drop expired buckets so the map cannot grow unbounded.
let lastSweep = 0
function sweep(now: number) {
  if (now - lastSweep < 60_000) return
  lastSweep = now
  for (const [key, bucket] of buckets) {
    if (now > bucket.resetAt) buckets.delete(key)
  }
}

/** Best-effort client IP from proxy headers (Vercel sets x-forwarded-for / x-real-ip). */
export function clientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'local'
  )
}

/**
 * Fixed-window rate limit check.
 * @returns true when the caller is OVER the limit (i.e. the request should be rejected).
 */
export function isRateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  sweep(now)
  const bucket = buckets.get(key)
  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return false
  }
  bucket.count += 1
  return bucket.count > max
}
