// 10X RPC — Trial policy (DB-backed, admin-controlled).
//
// Stored in the PlatformSetting table under the key "trial" as JSON so the
// trial length/name/features can change without a deploy. Read paths use a
// short in-memory cache (30s) because ensureSubscription() runs on hot paths;
// admin writes bust the cache immediately. When nothing is stored (fresh
// install / DB hiccup) the CONFIG.app.trialDays default keeps the current
// behavior — new accounts get a 3-day free trial.
import { db } from '@/lib/db'
import { CONFIG } from '@/lib/config'

export interface TrialConfig {
  /** When false, brand-new accounts do NOT get a free trial (they start suspended). */
  enabled: boolean
  /** Free trial length in days (1–90). */
  days: number
  /** Display name of the trial plan on the pricing page. */
  name: string
  description: string
  features: string[]
  /** Allow admins to grant additional trials to users who already used theirs. */
  allowRepeat: boolean
  updatedAt?: string
}

const KEY = 'trial'
const CACHE_MS = 30_000

export function defaultTrialConfig(): TrialConfig {
  return {
    enabled: true,
    days: CONFIG.app.trialDays,
    name: 'Free Trial',
    description: 'Every account starts with a free trial — no card needed.',
    features: ['Full feature access', `${CONFIG.app.trialDays} days validity`, 'No card needed'],
    allowRepeat: false,
  }
}

let cache: { value: TrialConfig; at: number } | null = null

function sanitize(raw: Partial<TrialConfig> | null | undefined, base: TrialConfig): TrialConfig {
  const days = Number(raw?.days)
  return {
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : base.enabled,
    days: Number.isFinite(days) ? Math.min(90, Math.max(0, Math.floor(days))) : base.days,
    name: typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : base.name,
    description: typeof raw?.description === 'string' ? raw.description.slice(0, 300) : base.description,
    features: Array.isArray(raw?.features)
      ? raw.features.map(f => String(f).slice(0, 120)).filter(Boolean).slice(0, 12)
      : base.features,
    allowRepeat: typeof raw?.allowRepeat === 'boolean' ? raw.allowRepeat : base.allowRepeat,
    updatedAt: raw?.updatedAt,
  }
}

/** Current trial policy (cached 30s; falls back to defaults on DB errors). */
export async function getTrialConfig(): Promise<TrialConfig> {
  const base = defaultTrialConfig()
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value
  try {
    const row = await db.platformSetting.findUnique({ where: { key: KEY } })
    const value = row ? sanitize(safeParse(row.value), base) : base
    cache = { value, at: Date.now() }
    return value
  } catch {
    return base
  }
}

/** Validate + persist a trial-policy update (admin only). Busts the cache. */
export async function setTrialConfig(patch: Partial<TrialConfig>): Promise<TrialConfig> {
  const current = await getTrialConfig()
  const next = sanitize(patch, current)
  next.updatedAt = new Date().toISOString()
  await db.platformSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  })
  cache = { value: next, at: Date.now() }
  return next
}

function safeParse(json: string): Partial<TrialConfig> | null {
  try {
    const v = JSON.parse(json)
    return v && typeof v === 'object' ? v as Partial<TrialConfig> : null
  } catch {
    return null
  }
}
