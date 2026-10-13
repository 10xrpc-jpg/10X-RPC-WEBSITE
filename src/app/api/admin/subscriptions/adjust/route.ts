// 10X RPC — POST /api/admin/subscriptions/adjust — subscription surgery.
//
// Every privileged per-user subscription operation, with:
//   • a REQUIRED reason (min 3 chars) for each sensitive change
//   • optimistic concurrency — the client sends expectedUpdatedAt; a 409 is
//     returned when another admin (or the sweep) changed the row meanwhile,
//     so concurrent edits can never silently overwrite each other
//   • a transaction per compound change + an AuditLog row (before/after)
//
// Actions and their exact semantics:
//   add_days      — extend the CURRENT phase (trial → trialEndsAt, active →
//                   currentPeriodEnd stacks). Blocked for suspended/lifetime:
//                   renew with grant_plan instead (explicit reactivation).
//   subtract_days — shorten the current phase; crossing zero expires now.
//   set_expiry    — exact end date for the current phase (past date =
//                   expired). Lifetime rejects (change the plan first).
//   set_start     — correct the subscription's createdAt record.
//   set_plan      — change the plan, keeping the current dates (entitlements
//                   are preserved; lifetime clears the period end).
//   grant_plan    — assign/renew a plan (DB plan duration by default, or
//                   explicit days). Explicit renewal → lifts suspension.
//   grant_trial   — manual free trial (admin intent; sets trialUsed).
//   suspend       — suspend NOW, dates preserved (admin-suspended).
//   reactivate    — lift suspension ONLY when real time remains; otherwise
//                   rejected (use grant_plan to renew an expired account).
//   expire_now    — zero out the remaining time → suspended.
//   cancel        — cancel per existing rules (suspend + audit as cancel).
//   clear_expiry  — remove the end date → never expires under current plan.
//   add_note      — internal admin remark on the user (never shown to them).
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin, adminRateLimited, writeAudit } from '@/lib/admin-guard'
import { subscriptionView, ensureSubscription } from '@/lib/subscription'

export const dynamic = 'force-dynamic'

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_DATE = new Date('2036-01-01T00:00:00Z') // sane upper bound for dates
const ACTIONS = [
  'add_days', 'subtract_days', 'set_expiry', 'set_start', 'set_plan',
  'grant_plan', 'grant_trial', 'suspend', 'reactivate', 'expire_now',
  'cancel', 'clear_expiry', 'add_note',
] as const
type Action = (typeof ACTIONS)[number]

function bad(message: string, status = 400) {
  return NextResponse.json({ error: 'bad_request', message }, { status })
}

function parseDate(input: unknown): Date | null {
  if (typeof input !== 'string' && typeof input !== 'number') return null
  const d = new Date(input)
  if (Number.isNaN(d.getTime())) return null
  if (d.getTime() > MAX_DATE.getTime()) return null
  return d
}

/** Kill every live session's RPC flags + best-effort stop presence. */
async function killRpc(userId: string) {
  await db.session.updateMany({
    where: { userId, expiresAt: { gt: new Date() } },
    data: { rpcEnabled: false, statusEnabled: false, gatewayReady: false, vrStatusActive: false },
  }).catch(() => {})
  try {
    const { stopPresence } = await import('@/lib/presence-sync')
    await stopPresence(userId)
  } catch {
    // presence backend unavailable — the DB flags already stop the daemon
  }
}

export async function POST(req: Request) {
  const { session, error } = await requireAdmin()
  if (error) return error
  const limited = adminRateLimited(req, 'subscriptions-adjust', 30, 60_000)
  if (limited) return limited

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const userId = typeof body.userId === 'string' ? body.userId : ''
  const action = body.action as Action
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!userId || !action || !ACTIONS.includes(action)) {
    return bad('userId and a valid action are required.')
  }
  if (reason.length < 3 || reason.length > 300) {
    return bad('A reason (3–300 characters) is required for every subscription change.')
  }

  const user = await db.user.findUnique({ where: { id: userId } })
  if (!user) return NextResponse.json({ error: 'not_found', message: 'User not found.' }, { status: 404 })

  // Concurrency guard: the row the admin saw must still be current.
  const current = await ensureSubscription(userId)
  if (typeof body.expectedUpdatedAt === 'string' && body.expectedUpdatedAt) {
    if (current.updatedAt.toISOString() !== body.expectedUpdatedAt) {
      return NextResponse.json({
        error: 'conflict',
        message: 'This subscription changed while you were editing — refresh and try again.',
      }, { status: 409 })
    }
  }

  const now = new Date()
  const planRaw = typeof body.plan === 'string' ? body.plan.trim().toLowerCase() : ''
  const daysRaw = Number(body.days)
  const days = Number.isFinite(daysRaw) ? Math.floor(daysRaw) : null

  // Snapshot for the audit log.
  const before = {
    plan: current.plan,
    status: current.status,
    trialEndsAt: current.trialEndsAt?.toISOString() ?? null,
    currentPeriodEnd: current.currentPeriodEnd?.toISOString() ?? null,
    suspendedAt: current.suspendedAt?.toISOString() ?? null,
    createdAt: current.createdAt.toISOString(),
    trialUsed: current.trialUsed,
  }

  try {
    // Apply the action inside a transaction; `next` is the fresh row.
    const next = await db.$transaction(async tx => {
      const isTrial = current.status === 'trialing' || current.plan === 'free'
      const phaseEnd = isTrial ? current.trialEndsAt : current.currentPeriodEnd
      const msLeft = phaseEnd ? phaseEnd.getTime() - now.getTime() : 0
      const isLifetime = current.plan === 'lifetime' && current.status === 'active' && !current.currentPeriodEnd

      switch (action) {
        case 'add_days': {
          if (!days || days <= 0) throw new Error('days must be a positive number.')
          if (days > 3650) throw new Error('days must be ≤ 3650.')
          if (current.status === 'suspended') {
            throw new Error('This account is suspended/expired — use "Grant plan" (explicit renewal) or "Reactivate" first; adding days would silently restore access.')
          }
          if (isLifetime) throw new Error('Lifetime access never expires — nothing to extend.')
          if (isTrial) {
            const base = current.trialEndsAt && current.trialEndsAt > now ? current.trialEndsAt : now
            return tx.subscription.update({ where: { userId }, data: { trialEndsAt: new Date(base.getTime() + days * DAY_MS) } })
          }
          const base = current.currentPeriodEnd && current.currentPeriodEnd > now ? current.currentPeriodEnd : now
          return tx.subscription.update({ where: { userId }, data: { currentPeriodEnd: new Date(base.getTime() + days * DAY_MS), suspendedAt: null } })
        }

        case 'subtract_days': {
          if (!days || days <= 0) throw new Error('days must be a positive number.')
          if (current.status === 'suspended') throw new Error('Subscription is already suspended — nothing to subtract.')
          if (isLifetime) throw new Error('Lifetime access never expires — nothing to subtract.')
          if (!phaseEnd) throw new Error('This subscription has no end date — nothing to subtract.')
          const newEnd = new Date(Math.max(0, phaseEnd.getTime() - days * DAY_MS))
          if (newEnd.getTime() <= now.getTime()) {
            // Crossing zero → expired immediately + RPC killed.
            await killRpc(userId)
            return tx.subscription.update({
              where: { userId },
              data: isTrial
                ? { trialEndsAt: newEnd, status: 'suspended', suspendedAt: now }
                : { currentPeriodEnd: newEnd, status: 'suspended', suspendedAt: now },
            })
          }
          return tx.subscription.update({
            where: { userId },
            data: isTrial ? { trialEndsAt: newEnd } : { currentPeriodEnd: newEnd },
          })
        }

        case 'set_expiry': {
          const date = parseDate(body.date)
          if (!date) throw new Error('A valid expiry date is required.')
          if (isLifetime) throw new Error('Lifetime access never expires — change the plan first if you need an end date.')
          const active = date.getTime() > now.getTime()
          if (isTrial || current.plan === 'free') {
            return tx.subscription.update({
              where: { userId },
              data: { trialEndsAt: date, status: active ? 'trialing' : 'suspended', suspendedAt: active ? null : now },
            })
          }
          if (!active) await killRpc(userId)
          return tx.subscription.update({
            where: { userId },
            data: { currentPeriodEnd: date, status: active ? 'active' : 'suspended', suspendedAt: active ? null : now },
          })
        }

        case 'set_start': {
          const date = parseDate(body.date)
          if (!date) throw new Error('A valid start date is required.')
          return tx.subscription.update({ where: { userId }, data: { createdAt: date } })
        }

        case 'set_plan': {
          if (!planRaw) throw new Error('A plan is required.')
          return tx.subscription.update({
            where: { userId },
            data: {
              plan: planRaw,
              ...(planRaw === 'lifetime' ? { currentPeriodEnd: null, status: 'active', suspendedAt: null } : {}),
            },
          })
        }

        case 'grant_plan': {
          if (!planRaw) throw new Error('A plan is required.')
          // Explicit renewal → allowed from ANY state (this is the intended
          // path for expired accounts). Duration: explicit days, else the
          // plan's configured duration, else 30.
          let periodDays = days && days > 0 && days <= 3650 ? days : null
          if (!periodDays) {
            const dbPlan = await tx.plan.findUnique({ where: { slug: planRaw } })
            periodDays = dbPlan?.durationDays ?? (planRaw === 'plus' ? 30 : planRaw === 'pro' ? 90 : 30)
          }
          if (planRaw === 'lifetime') {
            return tx.subscription.update({ where: { userId }, data: { plan: 'lifetime', status: 'active', currentPeriodEnd: null, suspendedAt: null } })
          }
          const stacking = current.status === 'active' && current.currentPeriodEnd && current.currentPeriodEnd > now
          const base = stacking ? current.currentPeriodEnd!.getTime() : now.getTime()
          return tx.subscription.update({
            where: { userId },
            data: { plan: planRaw, status: 'active', currentPeriodEnd: new Date(base + periodDays * DAY_MS), suspendedAt: null },
          })
        }

        case 'grant_trial': {
          const trialDays = days && days > 0 && days <= 90 ? days : null
          if (trialDays == null) throw new Error('Trial days must be 1–90.')
          return tx.subscription.update({
            where: { userId },
            data: {
              plan: 'free', status: 'trialing', trialEndsAt: new Date(now.getTime() + trialDays * DAY_MS),
              currentPeriodEnd: null, suspendedAt: null, trialUsed: true,
            },
          })
        }

        case 'suspend': {
          await killRpc(userId)
          return tx.subscription.update({ where: { userId }, data: { status: 'suspended', suspendedAt: now } })
        }

        case 'reactivate': {
          if (current.status !== 'suspended') throw new Error('Subscription is not suspended.')
          const hasTime = (current.currentPeriodEnd && current.currentPeriodEnd > now) || (current.trialEndsAt && current.trialEndsAt > now)
          if (!hasTime) {
            throw new Error('No remaining time on this subscription — grant a plan or days instead of reactivating an expired account.')
          }
          return tx.subscription.update({
            where: { userId },
            data: {
              status: (current.currentPeriodEnd && current.currentPeriodEnd > now) ? 'active' : 'trialing',
              suspendedAt: null,
            },
          })
        }

        case 'expire_now': {
          if (isLifetime) throw new Error('Lifetime access — use Suspend to cut access (expiry does not apply).')
          await killRpc(userId)
          return tx.subscription.update({
            where: { userId },
            data: {
              status: 'suspended', suspendedAt: now,
              ...(isTrial ? { trialEndsAt: now } : { currentPeriodEnd: now }),
            },
          })
        }

        case 'cancel': {
          await killRpc(userId)
          return tx.subscription.update({ where: { userId }, data: { status: 'suspended', suspendedAt: now } })
        }

        case 'clear_expiry': {
          if (current.status === 'suspended') throw new Error('Reactivate the subscription before clearing its expiry.')
          return tx.subscription.update({ where: { userId }, data: { currentPeriodEnd: null } })
        }

        case 'add_note': {
          const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : ''
          await tx.user.update({ where: { id: userId }, data: { adminNote: note || null } })
          return current
        }

        default:
          throw new Error('Unsupported action.')
      }
    })

    // add_note touched the user, not the subscription — the row is unchanged.
    const changed = next.id !== current.id || next.updatedAt.getTime() !== current.updatedAt.getTime()

    await writeAudit({
      action: `subscription.${action}`,
      actorId: session.user.discordId,
      actorName: session.user.username,
      targetType: 'user',
      targetId: userId,
      targetLabel: user.username,
      before,
      after: changed ? {
        plan: next.plan, status: next.status,
        trialEndsAt: next.trialEndsAt?.toISOString() ?? null,
        currentPeriodEnd: next.currentPeriodEnd?.toISOString() ?? null,
        suspendedAt: next.suspendedAt?.toISOString() ?? null,
        createdAt: next.createdAt.toISOString(),
      } : { adminNote: typeof body.note === 'string' ? body.note : null },
      reason,
    })

    const view = subscriptionView(next, user.discordId, new Date())
    const labels: Record<Action, string> = {
      add_days: `+${days} day(s)`,
      subtract_days: `-${days} day(s)`,
      set_expiry: 'expiry set',
      set_start: 'start date set',
      set_plan: `plan → ${planRaw}`,
      grant_plan: `${planRaw || 'plan'} granted${days ? ` (+${days}d)` : ''}`,
      grant_trial: `${days ?? 'trial'}-day trial granted`,
      suspend: 'suspended',
      reactivate: 'reactivated',
      expire_now: 'expired immediately',
      cancel: 'cancelled',
      clear_expiry: 'expiry removed (never expires)',
      add_note: 'note saved',
    }
    return NextResponse.json({
      ok: true,
      action,
      message: `${user.username}: ${labels[action]} — reason recorded.`,
      subscription: view,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Adjustment failed.'
    console.error('[admin/subscriptions/adjust]', action, 'failed:', e)
    // Rejected business rules are 422 (client shows the message); unexpected
    // errors are 500.
    const isRule = e instanceof Error && !String(e).includes('Invalid')
    await writeAudit({
      action: `subscription.${action}`,
      actorId: session.user.discordId,
      actorName: session.user.username,
      targetType: 'user',
      targetId: userId,
      targetLabel: user.username,
      reason,
      outcome: 'error',
    }).catch(() => {})
    return NextResponse.json({ error: 'adjust_failed', message }, { status: isRule ? 422 : 500 })
  }
}
