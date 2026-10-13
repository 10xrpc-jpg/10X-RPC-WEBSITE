// 10X RPC — /api/rpc/rotate — RPC Auto Rotate settings (optional feature)
// Auto Rotate controls ONLY the runtime presentation (which enabled RPC is
// shown on Discord and how often it switches). It NEVER creates, deletes,
// resets, overwrites, enables or disables any RPC configuration, and it never
// touches Game RPC settings. Saved configs are 100% read-only to this route.
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { syncPresence } from '@/lib/presence-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const ALLOWED_SECS = [30, 60, 120, 300, 600]

export async function POST(req: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ ok: false, error: 'not_authenticated' }, { status: 401 })

    const body = await req.json() as { enabled?: boolean; secs?: number }
    const enabled = !!body.enabled
    const secs = ALLOWED_SECS.includes(Number(body.secs)) ? Number(body.secs) : 30

    const updated = await db.globalConfig.upsert({
      where: { userId: session.userId },
      create: { userId: session.userId, rpcAutoRotate: enabled, rpcRotateSecs: secs },
      update: { rpcAutoRotate: enabled, rpcRotateSecs: secs },
    })

    // Runtime-only change — rebuild what is being sent (rotation starts/ends
    // immediately) without modifying any configuration.
    if (session.discordAccessToken && session.rpcEnabled) {
      await syncPresence(session.userId)
    }

    return NextResponse.json({
      ok: true,
      autoRotate: {
        enabled: (updated as { rpcAutoRotate: boolean }).rpcAutoRotate,
        secs: (updated as { rpcRotateSecs: number }).rpcRotateSecs,
      },
      message: enabled
        ? `Auto Rotate ON — your enabled RPCs switch every ${secs >= 60 ? `${secs / 60} min` : `${secs}s`}`
        : 'Auto Rotate OFF — all enabled RPCs are sent together',
    })
  } catch (e: unknown) {
    console.error('Error saving rotate settings:', e instanceof Error ? e.message : e)
    return NextResponse.json({ ok: false, error: 'rotate_save_failed' }, { status: 500 })
  }
}
