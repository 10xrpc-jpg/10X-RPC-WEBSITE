// 10X RPC — /api/admin/user-action — per-user admin operations (admin only).
// Actions:
//   enable-rpc      — turn the user's Normal RPC on + push presence (same
//                     semantics as the user's own toggle / force-enable).
//   disable-rpc     — turn RPC off + clear presence.
//   extend-trial    — add CONFIG.app.trialDays (30) days to the user's trial
//                     (creating it if missing).
//   revoke-sessions — delete every session row for the user (forces re-login).
//                     Blocked for the acting admin's own account (self-logout).
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { CONFIG } from '@/lib/config'
import { syncPresence, stopPresence } from '@/lib/presence-sync'

export const dynamic = 'force-dynamic'

const ACTIONS = ['enable-rpc', 'disable-rpc', 'extend-trial', 'revoke-sessions'] as const
type Action = (typeof ACTIONS)[number]

export async function POST(req: Request) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })
  }
  if (!CONFIG.admin.discordIds.includes(session.user.discordId)) {
    return NextResponse.json({ error: 'forbidden', message: 'Admin access required' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({})) as { userId?: string; action?: string }
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
        message: `Trial extended +${CONFIG.app.trialDays}d for ${user.username} — ends ${endsAt.toISOString().slice(0, 10)}`,
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
