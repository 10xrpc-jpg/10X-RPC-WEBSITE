// 10X RPC — /api/keep-awake — self-ping endpoint to keep Render from sleeping
// Render free tier sleeps after 15 min of inactivity. This endpoint pings itself
// every 10 minutes to stay awake. Called by a setInterval in the server process.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  // Simple DB query to keep the connection warm
  await db.session.count({ where: { expiresAt: { gt: new Date() } } }).catch(() => 0)

  return NextResponse.json({
    ok: true,
    awake: true,
    timestamp: new Date().toISOString(),
  })
}
