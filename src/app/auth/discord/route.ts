// 10X RPC — Initiate Discord OAuth flow
// Stores PKCE verifier in the database keyed by state (NOT cookies).
// This works across the Vercel→Render proxy because the verifier is
// looked up by state in the callback, not read from cookies.
import { NextResponse } from 'next/server'
import { generatePkce, buildAuthorizeUrl } from '@/lib/discord-oauth'
import { CONFIG } from '@/lib/config'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/** Friendly full-page error instead of a blank HTTP 500. */
function dbUnavailablePage(detail: string) {
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Login temporarily unavailable — 10X RPC</title>
<style>body{background:#0b0b0f;color:#e5e5ee;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}
.box{max-width:560px;text-align:center}h1{font-size:1.35rem;margin:0 0 8px}p{color:#a0a0b0;line-height:1.55;margin:8px 0}
code{background:#1a1a22;border:1px solid #2c2c38;border-radius:6px;padding:2px 8px;font-size:.85em;color:#f0b429}
a.btn{display:inline-block;margin-top:18px;background:#7c3aed;color:#fff;text-decoration:none;border-radius:10px;padding:10px 22px;font-weight:600}
a.btn:hover{filter:brightness(1.1)}</style></head>
<body><div class="box"><h1>Login is temporarily unavailable</h1>
<p>The website couldn't reach its database while starting the Discord sign-in flow.</p>
<p>If you're the site owner: set <code>DATABASE_URL</code> (and friends) in your Vercel
project's Production environment variables, then redeploy — see
<code>Fix production env</code> in GitHub Actions for a one-click repair.</p>
<p style="color:#5a5a68;font-size:.85em">detail: ${detail}</p>
<a class="btn" href="/">← Back to 10X RPC</a></div></body></html>`
  return new NextResponse(html, {
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '60' },
  })
}

export async function GET() {
  const { verifier, challenge } = generatePkce()
  const state = crypto.randomUUID()

  // Store verifier in DB keyed by state (expires in 10 minutes)
  try {
    await db.oAuthState.create({
      data: {
        state,
        verifier,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    })
  } catch (err) {
    // DB unreachable — make the failure diagnosable instead of a blank 500.
    console.error(JSON.stringify({
      tag: 'auth_discord_db_unavailable',
      message: err instanceof Error ? err.message : String(err),
      hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
      at: new Date().toISOString(),
    }))
    return dbUnavailablePage('oAuthState.create failed — database unreachable or DATABASE_URL missing')
  }

  // Clean up expired states (best-effort, don't block)
  db.oAuthState.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  }).catch(() => {})

  const redirectUri = CONFIG.discord.redirectUri
  const authorizeUrl = buildAuthorizeUrl(state, challenge, redirectUri)

  return NextResponse.redirect(authorizeUrl)
}
