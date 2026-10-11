// 10X RPC — Admin endpoint guard + audit trail + rate limiting.
//
// Every /api/admin/* endpoint re-verifies the session server-side (the
// ADMIN_DISCORD_IDS list); this helper is the shared gate for the new
// privileged routes so 401/403 semantics stay identical to the existing
// routes. writeAudit() records privileged actions in the AuditLog table —
// it is best-effort (never breaks the main action) but failures are logged.
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { CONFIG } from '@/lib/config'
import { isRateLimited, clientIp } from '@/lib/rate-limit'

type AdminSession = NonNullable<Awaited<ReturnType<typeof getSession>>>

export type AdminGuard = { session: AdminSession; error: null } | { session: null; error: NextResponse }

/** 401 when signed out, 403 when not in ADMIN_DISCORD_IDS. */
export async function requireAdmin(): Promise<AdminGuard> {
  const session = await getSession()
  if (!session) {
    return { session: null, error: NextResponse.json({ error: 'not_authenticated' }, { status: 401 }) }
  }
  if (!CONFIG.admin.discordIds.includes(session.user.discordId)) {
    return { session: null, error: NextResponse.json({ error: 'forbidden', message: 'Admin access required' }, { status: 403 }) }
  }
  return { session, error: null }
}

export interface AuditEntry {
  action: string // plan.create · subscription.add_days · trial.config_update …
  actorId: string
  actorName?: string | null
  targetType?: 'user' | 'plan' | 'trial_config' | 'payment' | 'platform' | null
  targetId?: string | null
  targetLabel?: string | null
  before?: unknown
  after?: unknown
  reason?: string | null
  outcome?: 'ok' | 'error'
}

/** Append to the tamper-resistant admin audit log (best-effort, never throws). */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actorId: entry.actorId,
        actorName: entry.actorName ?? null,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        targetLabel: entry.targetLabel ?? null,
        beforeJson: entry.before === undefined ? null : JSON.stringify(entry.before),
        afterJson: entry.after === undefined ? null : JSON.stringify(entry.after),
        reason: entry.reason ?? null,
        outcome: entry.outcome ?? 'ok',
      },
    })
  } catch (e) {
    console.error('[audit] failed to record:', entry.action, e)
  }
}

/**
 * Burst protection for admin mutations (per admin + endpoint). Returns a
 * ready 429 response when over the limit, else null. Limits are generous —
 * this stops runaway loops / double-click storms, not normal use.
 */
export function adminRateLimited(req: Request, scope: string, max = 40, windowMs = 60_000): NextResponse | null {
  const ip = clientIp(req)
  if (isRateLimited(`admin:${scope}:${ip}`, max, windowMs)) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Too many admin actions in a short time — wait a moment and retry.' },
      { status: 429 },
    )
  }
  return null
}
