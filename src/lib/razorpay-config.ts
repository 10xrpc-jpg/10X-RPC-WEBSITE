// 10X RPC — Razorpay credential resolver (env primary, DB override).
//
// WHY THIS EXISTS: the site's Razorpay keys live in Vercel env vars, which
// only the operator can change (and only via a redeploy). When those keys go
// stale (rotated in the Razorpay dashboard, mis-pasted, mode switched), Buy
// Now dies with "Could not start the payment" and nobody self-serve can fix
// it. This resolver lets the ADMIN save valid credentials from the dashboard
// (stored in the PlatformSetting table, key "razorpay") while keeping the
// env vars as the default source.
//
//   resolution order:  env RAZORPAY_*  →  DB override (if saved)  →  empty
//
// Secrets never leave the server: GET responses mask them (last 4 chars).
// Reads are cached for 30s on hot paths (checkout/verify/webhook); admin
// writes bust the cache immediately so a fix applies on the very next click.
import { db } from '@/lib/db'

export interface RazorpayKeys {
  keyId: string
  keySecret: string
  webhookSecret: string
  /** Where each value came from: "db" (admin override) or "env". */
  source: { keyId: 'db' | 'env'; keySecret: 'db' | 'env'; webhookSecret: 'db' | 'env' }
}

export interface RazorpayOverride {
  keyId?: string
  keySecret?: string
  webhookSecret?: string
  updatedAt?: string
}

const KEY = 'razorpay'
const CACHE_MS = 30_000

let cache: { keys: RazorpayKeys; override: RazorpayOverride | null; at: number } | null = null

function envKeys(): { keyId: string; keySecret: string; webhookSecret: string } {
  return {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  }
}

function safeParse(json: string): RazorpayOverride | null {
  try {
    const v = JSON.parse(json)
    return v && typeof v === 'object' ? (v as RazorpayOverride) : null
  } catch {
    return null
  }
}

/** Resolved credentials: DB override wins over env when present. Cached 30s;
 *  falls back to env-only on DB errors (payments still work if the DB blips). */
export async function getRazorpayKeys(): Promise<RazorpayKeys & { override: RazorpayOverride | null }> {
  const env = envKeys()
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return { ...cache.keys, override: cache.override }
  }
  let override: RazorpayOverride | null = null
  try {
    const row = await db.platformSetting.findUnique({ where: { key: KEY } })
    override = row ? safeParse(row.value) : null
  } catch (e) {
    console.error('[razorpay-config] override read failed (using env):', e)
  }
  const keys: RazorpayKeys = {
    keyId: override?.keyId || env.keyId,
    keySecret: override?.keySecret || env.keySecret,
    webhookSecret: override?.webhookSecret || env.webhookSecret,
    source: {
      keyId: override?.keyId ? 'db' : 'env',
      keySecret: override?.keySecret ? 'db' : 'env',
      webhookSecret: override?.webhookSecret ? 'db' : 'env',
    },
  }
  cache = { keys, override, at: Date.now() }
  return { ...keys, override }
}

/** Non-secret view for the admin UI: full key id (it ships to the browser in
 *  Checkout.js anyway — it is NOT a secret), secrets masked to their tail. */
export function maskedView(keys: RazorpayKeys, override: RazorpayOverride | null) {
  const mask = (v: string) => (v ? `••••••••${v.slice(-4)}` : '')
  return {
    configured: !!keys.keyId && !!keys.keySecret,
    keyId: keys.keyId,
    keyMode: keys.keyId.startsWith('rzp_test_') ? 'test' : keys.keyId.startsWith('rzp_live_') ? 'live' : keys.keyId ? 'unknown' : 'none',
    keySecretMasked: mask(keys.keySecret),
    webhookSecretMasked: mask(keys.webhookSecret),
    source: keys.source,
    overrideUpdatedAt: override?.updatedAt || null,
  }
}

/** Persist an admin override (undefined/empty fields keep existing values).
 *  Pass explicit nulls via resetRazorpayOverride() to drop back to env. */
export async function saveRazorpayOverride(patch: { keyId?: string; keySecret?: string; webhookSecret?: string }): Promise<RazorpayOverride> {
  const current = cache?.override ?? null
  const next: RazorpayOverride = {
    keyId: patch.keyId !== undefined ? patch.keyId.trim() : current?.keyId || '',
    keySecret: patch.keySecret !== undefined ? patch.keySecret.trim() : current?.keySecret || '',
    webhookSecret: patch.webhookSecret !== undefined ? patch.webhookSecret.trim() : current?.webhookSecret || '',
    updatedAt: new Date().toISOString(),
  }
  await db.platformSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  })
  cache = null // bust — the next read applies the new keys immediately
  return next
}

/** Remove the DB override — credentials fall back to the env vars. */
export async function resetRazorpayOverride(): Promise<void> {
  await db.platformSetting.deleteMany({ where: { key: KEY } })
  cache = null
}

/** Basic Key Id sanity check (rzp_test_* / rzp_live_*). */
export function keyIdLooksValid(keyId: string): boolean {
  return /^rzp_(test|live)_[A-Za-z0-9]+$/.test(keyId)
}
