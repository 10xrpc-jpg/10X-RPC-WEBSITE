// 10X RPC — /health — service health check and 24/7 daemon metrics
// Includes a lightweight database reachability probe (boolean + latency only —
// no error details are exposed publicly; details go to server logs).
import { NextResponse } from 'next/server'
import { getRpcDaemon } from '@/lib/rpc-daemon'
import { presenceBackend } from '@/lib/presence-sync'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

async function probeDb(): Promise<{ ok: boolean; latencyMs: number | null }> {
  const started = Date.now()
  try {
    await db.platformSetting.findFirst({ select: { key: true } })
    return { ok: true, latencyMs: Date.now() - started }
  } catch (err) {
    // One structured server-side line with the exact reason (never exposed via HTTP).
    console.error(JSON.stringify({
      tag: 'health_db_unreachable',
      message: err instanceof Error ? err.message : String(err),
      code: (err as { code?: string })?.code,
      hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
      urlHost: (() => { try { return new URL(process.env.DATABASE_URL || '').host } catch { return null } })(),
      at: new Date().toISOString(),
    }))
    return { ok: false, latencyMs: Date.now() - started }
  }
}

export async function GET() {
  const daemon = getRpcDaemon()
  const daemonStatus = daemon.getStatus()
  const dbStatus = await probeDb()

  return NextResponse.json(
    {
      status: 'ok',
      service: '10x-rpc-backend',
      presenceBackend: await presenceBackend(),
      db: dbStatus,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      daemon: daemonStatus,
    },
    { status: 200 }
  )
}
