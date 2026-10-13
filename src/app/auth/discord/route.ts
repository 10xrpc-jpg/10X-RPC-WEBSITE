// 10X RPC — Initiate Discord OAuth flow
// Stores PKCE verifier in the database keyed by state (NOT cookies).
// This works across the Vercel→Render proxy because the verifier is
// looked up by state in the callback, not read from cookies.
import { NextResponse } from 'next/server'
import { generatePkce, buildAuthorizeUrl } from '@/lib/discord-oauth'
import { CONFIG } from '@/lib/config'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { verifier, challenge } = generatePkce()
  const state = crypto.randomUUID()

  // Store verifier in DB keyed by state (expires in 10 minutes)
  await db.oAuthState.create({
    data: {
      state,
      verifier,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  })

  // Clean up expired states (best-effort, don't block)
  db.oAuthState.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  }).catch(() => {})

  const redirectUri = CONFIG.discord.redirectUri
  const authorizeUrl = buildAuthorizeUrl(state, challenge, redirectUri)

  return NextResponse.redirect(authorizeUrl)
}
