// 10X RPC — /api/admin/settings — non-secret platform settings for the admin
// dashboard Settings tab. Config only (no live probes — /api/admin/stats owns
// those). Secrets are never returned; only flags like `botConfigured`.
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { CONFIG } from '@/lib/config'

export const dynamic = 'force-dynamic'

function hostOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

export async function GET() {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })
  }
  if (!CONFIG.admin.discordIds.includes(session.user.discordId)) {
    return NextResponse.json({ error: 'forbidden', message: 'Admin access required' }, { status: 403 })
  }

  return NextResponse.json({
    ok: true,
    app: {
      name: CONFIG.app.name,
      url: CONFIG.app.url,
      trialDays: CONFIG.app.trialDays,
      sessionTtlDays: CONFIG.session.ttlDays,
      nodeEnv: process.env.NODE_ENV || 'development',
    },
    discord: {
      clientId: CONFIG.discord.clientId,
      oauthScope: CONFIG.discord.scope,
      autoJoinGuildId: CONFIG.discord.autoJoinGuildId || null,
      inviteUrl: CONFIG.discord.inviteUrl,
      botConfigured: !!CONFIG.discord.botToken,
      oauthConfigured: !!CONFIG.discord.clientSecret,
    },
    infra: {
      serverRegion: process.env.VERCEL_REGION || 'local',
      daemonConfigured: !!process.env.ORIHOST_DAEMON_URL,
      daemonHost: hostOf(process.env.ORIHOST_DAEMON_URL),
      panelConfigured: !!process.env.PTERODACTYL_API_KEY,
      panelHost: hostOf(process.env.PTERODACTYL_URL),
    },
    payments: {
      razorpayConfigured: !!CONFIG.razorpay.keyId && !!CONFIG.razorpay.keySecret,
      webhookConfigured: !!CONFIG.razorpay.webhookSecret,
      currency: CONFIG.razorpay.currency,
      webhookPath: '/api/subscription/webhook',
      plans: (['plus', 'pro'] as const).map(id => {
        const p = CONFIG.razorpay.plans[id]
        return { id, label: p.label, amount: p.amount, periodDays: p.periodDays, display: p.display }
      }),
    },
    admin: {
      adminDiscordIds: CONFIG.admin.discordIds,
      yourDiscordId: session.user.discordId,
      adminCount: CONFIG.admin.discordIds.length,
    },
    checkedAt: new Date().toISOString(),
  })
}
