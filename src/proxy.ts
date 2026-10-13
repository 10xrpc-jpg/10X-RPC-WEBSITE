// 10X RPC — Edge proxy (Next 16 middleware convention): CSRF hardening for
// cookie-authenticated mutations.
//
// Browsers ALWAYS attach an Origin header to cross-site POST/PUT/PATCH/DELETE
// requests (fetch/XHR/form submissions). If one is present and does not match
// the deployment host, the request cannot be a legitimate same-site action —
// block it before it reaches any API route. Requests WITHOUT Origin/Referer
// (curl, server-to-server, GitHub Actions cron) are allowed through: they
// cannot carry forged cross-site cookies, so they are not a CSRF vector.
//
// Primary CSRF defense remains the SameSite=Lax session cookie; this is the
// second layer (defense in depth) and also blocks cross-site profile
// manipulation for browsers that relax SameSite.

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function hostAllowed(hostHeader: string, originHost: string): boolean {
  const normalize = (h: string) => h.toLowerCase().replace(/:\d+$/, (m) => m) // keep port
  // Exact match (with or without port) covers vercel preview + production.
  if (normalize(hostHeader) === normalize(originHost)) return true
  // Allow any *.vercel.app preview host of this project when the request host
  // itself is a vercel.app domain (previews deploy under random names).
  if (hostHeader.endsWith('.vercel.app') && originHost.endsWith('.vercel.app')) return true
  return false
}

export default function proxy(req: NextRequest) {
  const { method } = req
  if (!UNSAFE_METHODS.has(method)) return NextResponse.next()

  const pathname = req.nextUrl.pathname
  const isApi = pathname.startsWith('/api/') || pathname.startsWith('/auth/')
  if (!isApi) return NextResponse.next()

  const host = req.headers.get('host') || ''
  const origin = req.headers.get('origin')
  const referer = req.headers.get('referer')

  // Origin check (authoritative when present).
  if (origin && origin !== 'null') {
    try {
      const originHost = new URL(origin).host
      if (host && !hostAllowed(host, originHost)) {
        return NextResponse.json(
          { error: 'cross_origin_blocked' },
          { status: 403 }
        )
      }
    } catch {
      return NextResponse.json({ error: 'cross_origin_blocked' }, { status: 403 })
    }
    return NextResponse.next()
  }

  // Referer fallback (some browsers omit Origin on same-origin form posts).
  if (referer) {
    try {
      const refererHost = new URL(referer).host
      if (host && !hostAllowed(host, refererHost)) {
        return NextResponse.json(
          { error: 'cross_origin_blocked' },
          { status: 403 }
        )
      }
    } catch {
      // Malformed referer — do not fail the request on it alone.
    }
  }

  // No Origin and no Referer: server-to-server / curl — allow (no cookies
  // can be attached by an attacker in this scenario).
  return NextResponse.next()
}

export const config = {
  matcher: ['/api/:path*', '/auth/:path*'],
}
