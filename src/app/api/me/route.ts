// 10X RPC — /api/me — current user + session state
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { avatarUrl } from '@/lib/discord-oauth'
import { CONFIG } from '@/lib/config'
import { selectActiveRpc, type RpcMode } from '@/lib/rpc-manager'

export const dynamic = 'force-dynamic'

function serializeRpcConfig(cfg: any) {
  return {
    id: cfg.id,
    name: cfg.name,
    type: cfg.type,
    platform: cfg.platform,
    state: cfg.state,
    details: cfg.details,
    largeImage: cfg.largeImage,
    largeText: cfg.largeText,
    smallImage: cfg.smallImage,
    smallText: cfg.smallText,
    button1Label: cfg.button1Label,
    button1Url: cfg.button1Url,
    button2Label: cfg.button2Label,
    button2Url: cfg.button2Url,
    partyCurrent: cfg.partyCurrent,
    partyMax: cfg.partyMax,
    partyId: cfg.partyId,
    partySecret: cfg.partySecret,
    startMinsAgo: cfg.startMinsAgo,
    endTotalMins: cfg.endTotalMins,
    enabled: cfg.enabled,
  }
}

export async function GET() {
  try {
    const session = await getSession()
    if (!session) {
      // Return 200 with authenticated:false — the dashboard handles this case gracefully
      return NextResponse.json({ authenticated: false })
    }

    let trial: any = null
    let globalConfig: any = null
    let rpcConfig: any = null
    let enabledGame: any = null
    let rotatorPresets: any[] = []

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        [trial, globalConfig, rpcConfig, enabledGame, rotatorPresets] = await Promise.all([
          db.trial.findUnique({ where: { userId: session.userId } }),
          db.globalConfig.findUnique({ where: { userId: session.userId } }),
          db.rpcConfig.findFirst({ where: { userId: session.userId } }),
          db.gameConfig.findFirst({ where: { userId: session.userId, enabled: true } }),
          db.rotatorPreset.findMany({
            where: { userId: session.userId },
            orderBy: { order: 'asc' },
          }),
        ])
        if (!rpcConfig) {
          rpcConfig = await db.rpcConfig.create({
            data: {
              userId: session.userId,
              name: '10X RPC',
              type: 'PLAYING',
              platform: 'desktop',
              state: null,
              details: null,
              largeImage: null,
              largeText: null,
              smallImage: null,
              smallText: null,
              button1Label: null,
              button1Url: null,
              button2Label: null,
              button2Url: null,
              partyCurrent: null,
              partyMax: null,
              partyId: null,
              partySecret: null,
              startMinsAgo: 0,
              endTotalMins: null,
              enabled: false,
            },
          })
        }
        break
      } catch (dbErr) {
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 600))
          continue
        }
        console.error('Error fetching user data in /api/me:', dbErr)
      }
    }

  const now = new Date()
  const trialActive = trial?.active && trial.endsAt > now
  const trialMsLeft = trial ? trial.endsAt.getTime() - now.getTime() : 0

  // Check sleep timer
  const sleepTimerActive = session.sleepTimerActive && session.sleepTimerEndsAt && session.sleepTimerEndsAt > now

  // ══ NORMAL RPC vs GAMER RPC — mutual exclusivity (completely separate configs) ══
  //   • Normal RPC config  = rpcConfig (RpcConfig row)
  //   • Gamer RPC config   = enabledGame (GameConfig row)
  // selectActiveRpc returns ONLY the active mode's own config (never a merge).
  const selection = selectActiveRpc(session.rpcEnabled, rpcConfig, enabledGame)
  const rpcMode: RpcMode | null = selection.mode
  // What the daemon is ACTUALLY sending right now (null when nothing is live):
  const activeRpcConfig = selection.active && selection.config ? serializeRpcConfig(selection.config) : null

  return NextResponse.json({
    authenticated: true,
    user: {
      id: session.user.discordId,
      username: session.user.username,
      discriminator: session.user.discriminator,
      avatar: avatarUrl({
        id: session.user.discordId,
        avatar: session.user.avatar,
        discriminator: session.user.discriminator || '0',
      }),
      backgroundUrl: session.user.backgroundUrl,
    },
    session: {
      statusEnabled: session.statusEnabled ?? false,
      rpcEnabled: !!session.rpcEnabled,
      rpcMode,
      gatewayReady: session.gatewayReady,
      userStatus: session.userStatus,
      customStatus: session.customStatus,
      customStatusEmoji: session.customStatusEmoji,
      statusPlatform: session.statusPlatform || 'mobile',
      vrStatusActive: session.vrStatusActive,
      sleepTimerActive,
      sleepTimerEndsAt: session.sleepTimerEndsAt,
      hasDiscordToken: !!session.discordAccessToken,
      lastPresenceUpdate: session.lastPresenceUpdate,
    },
    trial: {
      active: trialActive,
      endsAt: trial?.endsAt,
      msLeft: trialMsLeft,
      daysLeft: Math.max(0, Math.ceil(trialMsLeft / (24 * 60 * 60 * 1000))),
    },
    globalConfig: globalConfig ? {
      city: globalConfig.city,
      timezone: globalConfig.timezone,
      rotatorEnabled: globalConfig.rotatorEnabled,
      rotatorIntervalMins: globalConfig.rotatorIntervalMins,
    } : null,
    rpcConfig: rpcConfig ? {
      ...serializeRpcConfig(rpcConfig),
      enabled: rpcConfig.enabled,
    } : null,
    // The ACTIVE mode's own config (Gamer RPC config when a game owns the
    // presence, Normal RPC config otherwise; null when RPC is not live).
    activeRpcConfig,
    // Convenience: the currently enabled game (Gamer RPC config owner).
    activeGame: enabledGame ? {
      slug: enabledGame.gameSlug,
      name: enabledGame.gameName,
      enabled: enabledGame.enabled,
    } : null,
    rotatorPresets: rotatorPresets.map(p => ({
      id: p.id,
      emoji: p.emoji,
      text: p.text,
      durationMins: p.durationMins,
      enabled: p.enabled,
      order: p.order,
    })),
    rotatorEnabled: globalConfig?.rotatorEnabled ?? false,
    app: {
      name: CONFIG.app.name,
      tagline: CONFIG.app.tagline,
    },
  })
  } catch (err) {
    console.error('Unhandled error in /api/me:', err)
    return NextResponse.json({ error: 'Failed to fetch session' }, { status: 500 })
  }
}
