// 10X RPC — /api/logout
import { NextResponse } from 'next/server'
import { clearSessionCookie } from '@/lib/session'
import { CONFIG } from '@/lib/config'

export const dynamic = 'force-dynamic'

export async function POST() {
  await clearSessionCookie()
  return NextResponse.json({ ok: true, redirect: `${CONFIG.app.url}/` })
}
