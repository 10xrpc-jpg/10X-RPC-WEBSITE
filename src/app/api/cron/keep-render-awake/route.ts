// 10X RPC — /api/cron/keep-render-awake — Vercel Cron Job
// This route runs on VERCEL (not proxied to Render) and pings Render's
// /api/keep-awake endpoint every 10 minutes to prevent Render free tier
// from sleeping. This eliminates the "APPLICATION LOADING" cold start screen.
//
// Configured in vercel.json:
//   "crons": [{ "path": "/api/cron/keep-render-awake", "schedule": "*/10 * * * *" }]
import { NextResponse } from 'next/server'
import { CONFIG } from '@/lib/config'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET() {
  const renderUrl = process.env.RENDER_API_URL
  if (!renderUrl) {
    // On Render itself (no RENDER_API_URL), just return ok
    return NextResponse.json({ ok: true, message: 'Running on Render directly — no ping needed' })
  }

  try {
    // Ping Render's keep-awake endpoint directly (not via proxy)
    const res = await fetch(`${renderUrl}/api/keep-awake`, {
      method: 'GET',
      signal: AbortSignal.timeout(20000),
    })

    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `Render responded ${res.status}` },
        { status: 502 }
      )
    }

    const data = await res.json()
    return NextResponse.json({
      ok: true,
      renderAwake: data.awake,
      pingedAt: new Date().toISOString(),
    })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'fetch failed' },
      { status: 502 }
    )
  }
}
