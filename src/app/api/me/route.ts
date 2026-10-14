// 10X RPC — /api/me — current user + session state
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { avatarUrl } from '@/lib/discord-oauth'
import { CONFIG } from '@/lib/config'
import { resolveRuntimeCandidates, rotationPoolCandidates, rpcCandidateKey, type RpcCandidate } from '@/lib/rpc-manager'
import { rotateCycleIndex, rotateNextSwitchInSecs } from '@/lib/rotation'
import { rotateSettingsView } from '@/lib/rpc-rotate-settings'
import { sweepSubscription, subscriptionView } from '@/lib/subscription'
import { getTrialConfig } from '@/lib/trial-config'
import { serializeSlot } from '@/lib/rpc-slots'

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
    appId: cfg.appId,
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
    let rpcSlots: any[] = []
    let enabledGames: any[] = []
    let rotatorPresets: any[] = []
    // Subscription sweep — flips an expired trial/period to "suspended" and
    // kills the session RPC flags in the same request that notices it.
    const swept = await sweepSubscription(session.userId, session.user.discordId).catch(() => null)
    const subscription = swept?.sub ?? null

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        [trial, globalConfig, rpcSlots, enabledGames, rotatorPresets] = await Promise.all([
          db.trial.findUnique({ where: { userId: session.userId } }),
          db.globalConfig.findUnique({ where: { userId: session.userId } }),
          db.rpcConfig.findMany({
            where: { userId: session.userId },
            orderBy: [{ slot: 'asc' }, { createdAt: 'asc' }],
          }),
          // Task 89 — MULTI-GAME: every enabled game runs at the same time.
          db.gameConfig.findMany({
            where: { userId: session.userId, enabled: true },
            orderBy: { createdAt: 'asc' },
          }),
          db.rotatorPreset.findMany({
            where: { userId: session.userId },
            orderBy: { order: 'asc' },
          }),
        ])
        if (rpcSlots.length === 0) {
          rpcSlots = [
            await db.rpcConfig.create({
              data: {
                userId: session.userId,
                slot: 1,
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
            }),
          ]
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

  // ══ MULTI-RPC — up to 3 independent slots + ALL enabled Gamer RPCs (Task
  // 89 multi-game) ══
  // runtime = what the daemon is ACTUALLY publishing right now (Auto Rotate
  // aware). Saved configs are never modified here.
  const rotateView = rotateSettingsView(globalConfig)
  const fullSelection = resolveRuntimeCandidates({
    rpcEnabled: session.rpcEnabled,
    rpcConfigs: rpcSlots as Array<RpcCandidate & { enabled: boolean }>,
    enabledGame: enabledGames,
  })
  const runtime = resolveRuntimeCandidates({
    rpcEnabled: session.rpcEnabled,
    rpcConfigs: rpcSlots as Array<RpcCandidate & { enabled: boolean }>,
    enabledGame: enabledGames,
    autoRotate: rotateView.enabled,
    rotateSecs: rotateView.secs,
    rotateRefMs: rotateView.refMs,
    rotateOrder: rotateView.order,
    rotateSkip: rotateView.skip,
    rotateIncludeGame: rotateView.includeGame,
    rotateSlotKeys: rotateView.slots,
    rotateSeed: session.userId,
  })

  // ══ ROTATION PREVIEW (Task 87) — what the dashboard's live strip renders.
  // Computed with the SAME deterministic formula the daemon uses, so the
  // "now showing" name + countdown always match what Discord displays.
  let rotationPreview: {
    pool: Array<{ key: string; name: string; type: string; game: boolean }>
    nowIndex: number
    nowName: string
    nextIndex: number
    nextName: string
    nextSwitchInSecs: number
  } | null = null
  if (runtime.active && runtime.runtimeMode === 'rotate' && runtime.rotateIndex != null && runtime.rotatePoolLength) {
    // Task 89 — the preview pool comes from the SAME shared helper the daemon
    // uses (explicit selection → includeGame legacy rule), so the strip,
    // the selection chips and Discord can never disagree.
    const poolCandidates = rotationPoolCandidates(fullSelection, {
      rotateSlotKeys: rotateView.slots,
      includeGame: rotateView.includeGame,
    })
    const pool = poolCandidates.map(c => ({
      key: rpcCandidateKey(c),
      name: c.name ?? 'RPC',
      type: c.type ?? 'PLAYING',
      game: !!c.gameSlug,
    }))
    const nowMs = Date.now()
    const nextIn = rotateNextSwitchInSecs({ refMs: rotateView.refMs, secs: rotateView.secs, nowMs })
    const nextIdx = rotateCycleIndex({
      refMs: rotateView.refMs,
      secs: rotateView.secs,
      skip: rotateView.skip,
      order: rotateView.order,
      length: pool.length,
      seed: session.userId,
      nowMs: nowMs + nextIn * 1000 + 250,
    })
    rotationPreview = {
      pool,
      nowIndex: Math.min(runtime.rotateIndex, pool.length - 1),
      nowName: pool[runtime.rotateIndex]?.name ?? runtime.candidates[0]?.name ?? '',
      nextIndex: nextIdx,
      nextName: pool[nextIdx]?.name ?? '',
      nextSwitchInSecs: nextIn,
    }
  }
  const activeRpcConfig = runtime.active && runtime.candidates[0]
    ? serializeRpcConfig(runtime.candidates[0])
    : null
  // UI-compat mode flag: 'game' only when the game is the SOLE candidate.
  const rpcMode = runtime.active
    ? (runtime.candidates.length === 1 && runtime.candidates[0].gameSlug ? 'game' as const : 'normal' as const)
    : null
  const rpcConfig = rpcSlots[0] ?? null

  return NextResponse.json({
    authenticated: true,
    // Admin flag — drives the admin-dashboard entry point in the UI. The
    // /api/admin/* endpoints re-check this server-side, so this is cosmetic.
    isAdmin: CONFIG.admin.discordIds.includes(session.user.discordId),
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
    // Subscription lifecycle (access source of truth): free|plus|pro|lifetime
    // × trialing|active|suspended. The UI banners/tooltips read from here.
    subscription: subscription
      ? subscriptionView(subscription, session.user.discordId)
      : { plan: 'free', status: 'suspended', allowed: false, daysLeft: 0, msLeft: 0, trialEndsAt: null, currentPeriodEnd: null, suspendedAt: null, endsAt: null, neverExpires: false, admin: false },
    renewUrl: CONFIG.discord.inviteUrl,
    trialDays: (await getTrialConfig()).days,
    globalConfig: globalConfig ? {
      city: globalConfig.city,
      timezone: globalConfig.timezone,
      tempUnit: globalConfig.tempUnit,
      rotatorEnabled: globalConfig.rotatorEnabled,
      rotatorIntervalMins: globalConfig.rotatorIntervalMins,
    } : null,
    // Multi-RPC: every slot (max 3) + optional Auto Rotate settings.
    rpcSlots: rpcSlots.map(serializeSlot),
    autoRotate: rotateView,
    // Task 87 — live rotation state for the dashboard strip (null when not
    // rotating). The UI recomputes the countdown locally every second from
    // autoRotate.refMs/secs/skip/order using the same shared formula.
    rotationPreview,
    rpcConfig: rpcConfig ? {
      ...serializeRpcConfig(rpcConfig),
      enabled: rpcConfig.enabled,
    } : null,
    // The ACTIVE runtime candidate (rotate-aware; null when RPC is not live).
    activeRpcConfig,
    // Convenience: the enabled games (Gamer RPC configs, Task 89 multi-game).
    // `activeGame` (singular) = the first enabled game — kept for backward
    // compatibility with older dashboard builds.
    activeGames: enabledGames.map(g => ({
      slug: g.gameSlug,
      name: g.gameName,
      enabled: g.enabled,
    })),
    activeGame: enabledGames[0] ? {
      slug: enabledGames[0].gameSlug,
      name: enabledGames[0].gameName,
      enabled: enabledGames[0].enabled,
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
