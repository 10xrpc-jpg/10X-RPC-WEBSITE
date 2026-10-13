// 10X RPC — /api/admin/session-action — session-level admin operations.
// Actions:
//   revoke        — delete ONE session by id (kicks that login only). Blocked
//                   for the admin's own current session (self-logout guard).
//                   Revoking your own OTHER sessions is allowed (log out
//                   other devices).
//   purge-expired — delete ALL expired session rows (DB hygiene).
//   purge-oauth   — delete ALL expired OAuth state rows (DB hygiene).
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { CONFIG } from '@/lib/config'

export const dynamic = 'force-dynamic'

const ACTIONS = ['revoke', 'purge-expired', 'purge-oauth'] as const
type Action = (typeof ACTIONS)[number]

export async function POST(req: Request) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })
  }
  if (!CONFIG.admin.discordIds.includes(session.user.discordId)) {
    return NextResponse.json({ error: 'forbidden', message: 'Admin access required' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({})) as { action?: string; sessionId?: string }
  const action = body.action as Action | undefined
  if (!action || !ACTIONS.includes(action)) {
    return NextResponse.json(
      { error: 'bad_request', message: 'A valid action is required' },
      { status: 400 },
    )
  }

  switch (action) {
    case 'revoke': {
      const sessionId = body.sessionId
      if (!sessionId) {
        return NextResponse.json({ error: 'bad_request', message: 'sessionId is required' }, { status: 400 })
      }
      if (sessionId === session.id) {
        return NextResponse.json({
          ok: false,
          action,
          message: 'You cannot revoke the session you are currently using (you would log yourself out).',
        })
      }
      const target = await db.session.findUnique({
        where: { id: sessionId },
        include: { user: { select: { username: true } } },
      })
      if (!target) {
        return NextResponse.json({ ok: false, action, message: 'Session not found (already revoked?)' })
      }
      await db.session.delete({ where: { id: sessionId } })
      return NextResponse.json({
        ok: true,
        action,
        message: `Revoked one session for ${target.user.username} — that device must log in again`,
      })
    }

    case 'purge-expired': {
      const deleted = await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } })
      return NextResponse.json({
        ok: true,
        action,
        message: `Purged ${deleted.count} expired session(s)`,
      })
    }

    case 'purge-oauth': {
      const deleted = await db.oAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } })
      return NextResponse.json({
        ok: true,
        action,
        message: `Cleaned ${deleted.count} expired OAuth state(s)`,
      })
    }
  }
}
