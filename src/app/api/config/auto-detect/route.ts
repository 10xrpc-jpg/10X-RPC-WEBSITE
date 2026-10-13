// 10X RPC — /api/config/auto-detect — auto-detect the USER's city + timezone.
// Detection priority (most accurate first):
//   1. Vercel edge geo headers (x-vercel-ip-city / x-vercel-ip-timezone) — these
//      describe the ACTUAL visitor, resolved at the nearest edge location.
//   2. Browser timezone sent by the client (Intl-based, always correct).
//   3. Server-side IP lookup using the CLIENT's forwarded IP (never the server's
//      own IP, which the old implementation mistakenly detected).
// If nothing can be detected, the user's existing config is preserved (never wiped).
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

interface IpInfo {
  city?: string
  timezone?: string
}

function isValidTimezone(tz: string | undefined | null): tz is string {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function isPublicIp(ip: string): boolean {
  if (!ip) return false
  if (ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('fc') || ip.startsWith('fd')) return false
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return false
  return true
}

async function detectFromClientIp(ip: string): Promise<IpInfo> {
  if (!isPublicIp(ip)) return {}
  // ipapi.co with the explicit client IP
  try {
    const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
      headers: { 'User-Agent': '10x-rpc/1.0' },
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
    })
    if (res.ok) {
      const json = await res.json()
      if (json && !json.error) return { city: json.city, timezone: json.timezone }
    }
  } catch {}
  // Fallback: ipwho.is with the explicit client IP
  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, {
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
    })
    if (res.ok) {
      const json = await res.json()
      if (json && json.success !== false) return { city: json.city, timezone: json.timezone?.id }
    }
  } catch {}
  return {}
}

export async function POST(req: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })

  let body: { browserTimezone?: string } = {}
  try {
    body = await req.json() as { browserTimezone?: string }
  } catch {}

  const headers = req.headers
  let city: string | null = null
  let timezone: string | null = null
  const source = { city: 'none', timezone: 'none' } as { city: string; timezone: string }

  // 1) Vercel edge geo — the real visitor's location (values are URL-encoded)
  const vercelCity = headers.get('x-vercel-ip-city')
  const vercelTz = headers.get('x-vercel-ip-timezone')
  if (vercelCity) {
    try {
      city = decodeURIComponent(vercelCity)
      source.city = 'vercel-edge'
    } catch {
      city = vercelCity
      source.city = 'vercel-edge'
    }
  }
  if (isValidTimezone(vercelTz)) {
    timezone = vercelTz
    source.timezone = 'vercel-edge'
  }

  // 2) Browser timezone from the client (always trustworthy)
  if (!timezone && isValidTimezone(body.browserTimezone)) {
    timezone = body.browserTimezone
    source.timezone = 'browser'
  }

  // 3) Client-IP lookup (never the server's own IP)
  if ((!city || !timezone)) {
    const clientIp = (headers.get('x-forwarded-for') || headers.get('x-real-ip') || '')
      .split(',')[0].trim().split(':')[0]
    const detected = await detectFromClientIp(clientIp)
    if (!city && detected.city) {
      city = detected.city
      source.city = 'client-ip'
    }
    if (!timezone && isValidTimezone(detected.timezone)) {
      timezone = detected.timezone
      source.timezone = 'client-ip'
    }
  }

  // Never wipe the existing config when detection comes up empty
  const existing = await db.globalConfig.findUnique({ where: { userId: session.userId } })
  const finalCity = city ?? existing?.city ?? null
  const finalTimezone = timezone ?? existing?.timezone ?? 'Asia/Calcutta'

  const updated = await db.globalConfig.upsert({
    where: { userId: session.userId },
    create: { userId: session.userId, city: finalCity, timezone: finalTimezone },
    update: { city: finalCity, timezone: finalTimezone },
  })

  return NextResponse.json({ ok: true, globalConfig: updated, detected: source })
}
