// 10X RPC — /api/config/auto-detect — auto-detect city + timezone from request
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

interface IpInfo {
  city?: string
  timezone?: string
}

async function detectFromIp(req: Request): Promise<IpInfo> {
  try {
    // Try ipapi.co (no key required for basic lookup)
    const res = await fetch('https://ipapi.co/json/', { headers: { 'User-Agent': '10x-rpc/1.0' } })
    if (res.ok) {
      const json = await res.json()
      if (json && !json.error) {
        return { city: json.city, timezone: json.timezone }
      }
    }
  } catch {}
  // Fallback: ipwho.is
  try {
    const res = await fetch('https://ipwho.is/')
    if (res.ok) {
      const json = await res.json()
      if (json && json.success !== false) {
        return { city: json.city, timezone: json.timezone?.id }
      }
    }
  } catch {}
  return {}
}

export async function POST(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  const detected = await detectFromIp(req)
  const city = detected.city || null
  const timezone = detected.timezone || 'Asia/Calcutta'

  const updated = await db.globalConfig.upsert({
    where: { userId: session.userId },
    create: { userId: session.userId, city, timezone },
    update: { city, timezone },
  })

  return NextResponse.json({ ok: true, globalConfig: updated })
}
