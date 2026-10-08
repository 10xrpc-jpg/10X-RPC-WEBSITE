// 10X RPC — /set-session — runs on VERCEL (not proxied to Render)
// After OAuth callback on Render, the browser is redirected here with ?token=xxx
// This route sets the session cookie on Vercel's domain, then redirects to dashboard.
import { NextResponse } from 'next/server'
import { CONFIG } from '@/lib/config'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const token = url.searchParams.get('token')

  if (!token) {
    return NextResponse.redirect(`${CONFIG.app.url}/?error=missing_token`)
  }

  // Set the session cookie on Vercel's domain
  const expiresAt = new Date(Date.now() + CONFIG.session.ttlDays * 24 * 60 * 60 * 1000)
  const res = NextResponse.redirect(`${CONFIG.app.url}/dashboard`)
  res.cookies.set(CONFIG.session.cookieName, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  })
  return res
}
