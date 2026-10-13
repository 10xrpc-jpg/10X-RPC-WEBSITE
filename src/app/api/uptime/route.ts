// 10X RPC — /api/uptime — real region/ping + uptime probe for the /uptime page.
// Pings every backend component server-side (database, 24/7 daemon, Discord API,
// Pterodactyl node) and reports live status. Cached ~45s server-side.
import { NextResponse } from 'next/server'
import { getUptimeReport } from '@/lib/uptime'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get('force') === '1'
  try {
    const report = await getUptimeReport(force)
    return NextResponse.json(report, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        operational: false,
        degraded: false,
        checkedAt: new Date().toISOString(),
        serverRegion: process.env.VERCEL_REGION || 'local',
        error: e instanceof Error ? e.message : 'uptime probe failed',
      },
      { status: 500 },
    )
  }
}
