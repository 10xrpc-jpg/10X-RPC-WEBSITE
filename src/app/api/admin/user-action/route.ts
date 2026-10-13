// 10X RPC — /api/admin/user-action — per-user admin operations (admin only).
// Actions:
//   enable-rpc      — turn the user's Normal RPC on + push presence (same
//                     semantics as the user's own toggle / force-enable).
//   disable-rpc     — turn RPC off + clear presence.
//   extend-trial    — legacy: add CONFIG.app.trialDays days to the old Trial row
//                     (the UI now uses grant-subscription instead).
//   revoke-sessions — delete every session row for the user (forces re-login).
//                     Blocked for the acting admin's own account (self-logout).
// Subscription lifecycle actions (the access source of truth):
//   grant-subscription   — plan "pro" (default) or "plus" via { plan },
//                          status "active", +N days (default 30) appended to
//                          the current period end (or now).
//   suspend-subscription — status "suspended" immediately + kill session RPC.
//   reset-trial          — plan "free", status "trialing", fresh 3-day window.
//   grant-lifetime       — plan "lifetime", status "active", never expires.
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { CONFIG } from '@/lib/config'
import { syncPresence, stopPresence } from '@/lib/presence-sync'

export const dynamic = 'force-dynamic'

const ACTIONS = [
  'enable-rpc', 'disable-rpc', 'extend-trial', 'revoke-sessions',
  'grant-subscription', 'suspend-subscription', 'reset-trial', 'grant-lifetime',
] as const
type Action = (typeof ACTIONS)[number]

export async function POST(req: Request) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })
  }
  if (!CONFIG.admin.discordIds.includes(session.user.discordId)) {
    return NextResponse.json({ error: 'forbidden', message: 'Admin access required' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({})) as { userId?: string; action?: string; days?: number; plan?: string }
  const userId = body.userId
  const action = body.action as Action | undefined
  if (!userId || !action || !ACTIONS.includes(action)) {
    return NextResponse.json(
      { error: 'bad_request', message: 'userId and a valid action are required' },
      { status: 400 },
    )
  }

  const user = await db.user.findUnique({ where: { id: userId } })
  if (!user) {
    return NextResponse.json({ error: 'not_found', message: 'User not found' }, { status: 404 })
  }

  const now = new Date()

  switch (action) {
    case 'enable-rpc': {
      const sess = await db.session.findFirst({
        where: { userId, expiresAt: { gt: now }, discordAccessToken: { not: null } },
        orderBy: { expiresAt: 'desc' },
      })
      if (!sess) {
        return NextResponse.json({
          ok: false,
          action,
          message: 'No active session with a Discord token for this user — they must reconnect.',
        })
      }
      // Single source of truth = DB; the presence backend pushes from there.
      await db.session.update({
        where: { id: sess.id },
        data: { rpcEnabled: true, gatewayReady: true, lastPresenceUpdate: now },
      })
      // Mutual exclusivity — Normal RPC owns the presence.
      await db.gameConfig.updateMany({ where: { userId, enabled: true }, data: { enabled: false } })
      await db.rpcConfig.updateMany({ where: { userId }, data: { enabled: true } })
      let syncMsg = 'presence queued'
      try {
        const result = await syncPresence(userId)
        syncMsg = result.message || syncMsg
      } catch (e) {
        syncMsg = e instanceof Error ? e.message : 'presence sync failed'
      }
      return NextResponse.json({ ok: true, action, message: `RPC enabled for ${user.username} — ${syncMsg}` })
    }

    case 'disable-rpc': {
      await db.session.updateMany({
        where: { userId, expiresAt: { gt: now } },
        data: { rpcEnabled: false, gatewayReady: false, vrStatusActive: false },
      })
      try {
        await stopPresence(userId)
      } catch {
        // best-effort — the DB flag already stops the daemon from pushing
      }
      return NextResponse.json({ ok: true, action, message: `RPC disabled for ${user.username} + presence cleared` })
    }

    case 'extend-trial': {
      const existing = await db.trial.findUnique({ where: { userId } })
      const base = existing && existing.endsAt > now ? existing.endsAt : now
      const endsAt = new Date(base.getTime() + CONFIG.app.trialDays * 24 * 60 * 60 * 1000)
      await db.trial.upsert({
        where: { userId },
        create: { userId, startsAt: now, endsAt, active: true },
        update: { endsAt, active: true },
      })
      return NextResponse.json({
        ok: true,
        action,
        message: `Legacy trial extended +${CONFIG.app.trialDays}d for ${user.username} — ends ${endsAt.toISOString().slice(0, 10)}`,
      })
    }

    case 'grant-subscription': {
      // Optional { days } (default 30) — extends the paid period. Optional
      // { plan: 'plus' | 'pro' } (default 'pro') — which plan they get.
      const daysRaw = Number((body as { days?: number }).days)
      const days = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 3650 ? Math.floor(daysRaw) : 30
      const planRaw = String((body as { plan?: string }).plan || 'pro').toLowerCase()
      const plan: 'plus' | 'pro' = planRaw === 'plus' ? 'plus' : 'pro'
      const existing = await db.subscription.findUnique({ where: { userId } })
      const base = existing?.status === 'active' && existing.currentPeriodEnd && existing.currentPeriodEnd > now
        ? existing.currentPeriodEnd
        : now
      const endsAt = new Date(base.getTime() + days * 24 * 60 * 60 * 1000)
      await db.subscription.upsert({
        where: { userId },
        create: { userId, plan, status: 'active', currentPeriodEnd: endsAt },
        update: { plan, status: 'active', currentPeriodEnd: endsAt, suspendedAt: null },
      })
      return NextResponse.json({
        ok: true,
        action,
        message: `${plan} · ${days}d granted to ${user.username} — active until ${endsAt.toISOString().slice(0, 10)}`,
      })
    }

    case 'suspend-subscription': {
      await db.subscription.upsert({
        where: { userId },
        create: { userId, plan: 'free', status: 'suspended', suspendedAt: now },
        update: { status: 'suspended', suspendedAt: now },
      })
      await db.session.updateMany({
        where: { userId, expiresAt: { gt: now } },
        data: { rpcEnabled: false, statusEnabled: false, gatewayReady: false, vrStatusActive: false },
      })
      try {
        await stopPresence(userId)
      } catch {
        // best-effort — the DB flags already stop the daemon
      }
      return NextResponse.json({
        ok: true,
        action,
        message: `${user.username} suspended — RPC stopped everywhere`,
      })
    }

    case 'reset-trial': {
      const endsAt = new Date(now.getTime() + CONFIG.app.trialDays * 24 * 60 * 60 * 1000)
      await db.subscription.upsert({
        where: { userId },
        create: { userId, plan: 'free', status: 'trialing', trialEndsAt: endsAt },
        update: { plan: 'free', status: 'trialing', trialEndsAt: endsAt, suspendedAt: null, currentPeriodEnd: null },
      })
      return NextResponse.json({
        ok: true,
        action,
        message: `Fresh ${CONFIG.app.trialDays}-day trial for ${user.username} — ends ${endsAt.toISOString().slice(0, 10)}`,
      })
    }

    case 'grant-lifetime': {
      await db.subscription.upsert({
        where: { userId },
        create: { userId, plan: 'lifetime', status: 'active', currentPeriodEnd: null },
        update: { plan: 'lifetime', status: 'active', currentPeriodEnd: null, suspendedAt: null },
      })
      return NextResponse.json({
        ok: true,
        action,
        message: `${user.username} now has LIFETIME access`,
      })
    }

    case 'revoke-sessions': {
      if (user.discordId === session.user.discordId) {
        return NextResponse.json({
          ok: false,
          action,
          message: 'You cannot revoke your own sessions here (you would log yourself out).',
        })
      }
      const deleted = await db.session.deleteMany({ where: { userId } })
      return NextResponse.json({
        ok: true,
        action,
        message: `Revoked ${deleted.count} session(s) for ${user.username} — they must log in again`,
      })
    }
  }
}
