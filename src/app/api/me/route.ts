// 10X RPC — /api/me — current user + session state
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { avatarUrl } from '@/lib/discord-oauth'
import { CONFIG } from '@/lib/config'
import { resolveRuntimeCandidates, rotationPoolCandidates, rpcCandidateKey, assignDisplayTypes, buildGlobalDisplayTypeInputs, type RpcCandidate } from '@/lib/rpc-manager'
import { rotateCycleIndex, rotateNextSwitchInSecs } from '@/lib/rotation'
import { rotateSettingsView } from '@/lib/rpc-rotate-settings'
import { sweepSubscription, subscriptionView } from '@/lib/subscription'
import { getTrialConfig } from '@/lib/trial-config'
import { enforceRpcSlotExclusivity, recallHealForUi, serializeSlot } from '@/lib/rpc-slots'

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

    // Task 108 — MUTUAL EXCLUSIVITY heal: legacy/anomalous states with 2-3
    // enabled slots converge to the one-active-slot rule on dashboard load.
    // The response carries `slotExclusivityFixed` so the UI can explain the
    // switch flips. Game RPC rows are never touched by this pass.
    const slotHeal = await enforceRpcSlotExclusivity(session.userId).catch(() => null)
    if (slotHeal?.changed && slotHeal.disabledIds.length > 0) {
      rpcSlots = rpcSlots.map(r =>
        slotHeal.disabledIds.includes(r.id) ? { ...r, enabled: false } : r
      )
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
  // Task 106 — allRpcConfigs passes EVERY slot row (enabled AND disabled): the
  // dashboard's live strip must match the daemon EXACTLY, including disabled
  // slots the user explicitly selected for Auto Rotate.
  const runtime = resolveRuntimeCandidates({
    rpcEnabled: session.rpcEnabled,
    rpcConfigs: rpcSlots as Array<RpcCandidate & { enabled: boolean }>,
    allRpcConfigs: rpcSlots as Array<RpcCandidate & { enabled: boolean }>,
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
    // Task 89/106 — the preview pool comes from the SAME shared resolver the
    // daemon uses. rotatePoolKeys carries the resolved pool (explicit
    // selection matched against ALL slots, disabled ones included); each key
    // is resolved back to its candidate for the strip. Legacy fallback: the
    // enabled-slot pool helper.
    const keyToCandidate = new Map<string, RpcCandidate>()
    for (const c of [...(rpcSlots as RpcCandidate[]), ...enabledGames]) {
      const k = rpcCandidateKey(c)
      if (k && !keyToCandidate.has(k)) keyToCandidate.set(k, c)
    }
    const poolCandidates: RpcCandidate[] = runtime.rotatePoolKeys && runtime.rotatePoolKeys.length > 0
      ? runtime.rotatePoolKeys
          .map(k => keyToCandidate.get(k))
          .filter((c): c is RpcCandidate => !!c)
      : rotationPoolCandidates(fullSelection, {
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
  // Task 107 — DISPLAY-TYPE PARITY: the daemon substitutes the published
  // activity type so Discord's client prune (exactly ONE PLAYING card
  // globally; (type, application_id, name) duplicates collapse) keeps every
  // card. The dashboard profile preview MUST show the SAME type Discord
  // renders — otherwise "Playing" here vs "Watching" on Discord reads as a
  // bug. Mirror of rpc-daemon.ts's global orchestration (games pinned
  // PLAYING first, enabled slots next, the Application RPC last; while Auto
  // Rotate runs the rotating card + app_rpc never present as PLAYING).
  let activeRpcConfig: ReturnType<typeof serializeRpcConfig> | null = null
  if (runtime.active && runtime.candidates[0]) {
    const previewCandidate = runtime.candidates[0]
    let previewType = previewCandidate.type ?? 'PLAYING'
    try {
      if (!previewCandidate.gameSlug) {
        const appRpcRow = await db.applicationRpcConfig.findUnique({
          where: { userId: session.userId },
          select: { name: true, appId: true, type: true, enabled: true },
        })
        // Task 107 — ONE shared input builder (same as both daemons). In
        // rotate mode the slot inputs are EVERY created slot (enabled AND
        // disabled): disabled-but-selected slots take rotation turns and are
        // pushed on Discord during their turn, so the preview must assign
        // them the same substitute type the daemon publishes.
        const typeInputs = buildGlobalDisplayTypeInputs({
          slots: runtime.runtimeMode === 'rotate'
            ? (rpcSlots as Array<RpcCandidate>)
            : (rpcSlots as Array<RpcCandidate & { enabled: boolean }>).filter(c => c.enabled && !c.gameSlug),
          games: enabledGames,
          appRpc: appRpcRow?.enabled
            ? { name: appRpcRow.name, appId: appRpcRow.appId, type: appRpcRow.type }
            : null,
        })
        // Rotate mode → the rotating card + app_rpc never present as PLAYING
        // (mirror of the daemon's neverPlaying set); simultaneous mode → no
        // neverPlaying (the first non-game candidate may own PLAYING when no
        // game is enabled — exactly what the daemon assigns).
        // Task 109 — the ROTATING card owns the free PLAYING position (mirror
        // of the daemon's preferredPlayingKey) — without it the preview shows
        // "Competing in …" during slot 2/3 turns while Discord shows PLAYING.
        const neverPlaying = new Set<string>()
        let preferredPlayingKey: string | null = null
        if (runtime.runtimeMode === 'rotate') {
          if (appRpcRow?.enabled) neverPlaying.add('app_rpc')
          if (Array.isArray(runtime.rotatePoolKeys)) {
            const poolSet = new Set(runtime.rotatePoolKeys)
            for (const c of rpcSlots as Array<RpcCandidate & { enabled: boolean }>) {
              if (c.enabled && !c.gameSlug && c.id && !poolSet.has(c.id)) neverPlaying.add(c.id)
            }
          }
          preferredPlayingKey = rpcCandidateKey(previewCandidate) || null
        }
        const assigned = assignDisplayTypes(typeInputs, neverPlaying, preferredPlayingKey).get(rpcCandidateKey(previewCandidate))
        if (assigned) previewType = assigned
      }
    } catch { /* preview-only parity — never block /api/me on it */ }
    activeRpcConfig = serializeRpcConfig({ ...previewCandidate, type: previewType })
  }
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
    // Task 108 — slot numbers auto-disabled by the mutual-exclusivity heal
    // (empty in the normal case; the UI toasts once when a legacy state
    // with multiple enabled slots converges). recallHealForUi keeps the flag
    // alive for a few seconds so StrictMode/parallel loads still surface it.
    slotExclusivityFixed: slotHeal?.changed ? slotHeal.disabledSlots : recallHealForUi(session.userId),
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
