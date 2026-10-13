// 10X RPC — frontend API client
/** Serializable subscription lifecycle state (from /api/me, /api/subscription,
 *  and the admin user list). plan: free|plus|pro|lifetime; status:
 *  trialing|active|suspended. Admins always see allowed:true. */
export interface SubscriptionInfo {
  plan: 'free' | 'plus' | 'pro' | 'lifetime'
  status: 'trialing' | 'active' | 'suspended'
  trialEndsAt: string | null
  currentPeriodEnd: string | null
  suspendedAt: string | null
  /** When the CURRENT phase (trial or paid period) ends. Null = never. */
  endsAt: string | null
  msLeft: number
  daysLeft: number
  allowed: boolean
  neverExpires: boolean
  /** True when this user bypasses gating via ADMIN_DISCORD_IDS. */
  admin: boolean
}

/** Self-serve purchasable plans (Razorpay). */
export type PaidPlanId = 'plus' | 'pro'

/** POST /api/subscription/checkout response — everything Checkout.js needs. */
export interface SubscriptionCheckout {
  ok: boolean
  keyId: string
  orderId: string
  amount: number
  currency: string
  plan: PaidPlanId
  planLabel: string
  error?: string
  message?: string
}

/** Razorpay Checkout.js success handler payload. */
export interface RazorpayHandlerResponse {
  razorpay_order_id: string
  razorpay_payment_id: string
  razorpay_signature: string
}

export interface Me {
  authenticated: boolean
  /** True when the signed-in Discord ID is in the server's admin list. */
  isAdmin?: boolean
  user?: {
    id: string
    username: string
    discriminator: string
    avatar: string
    backgroundUrl?: string | null
  }
  session?: {
    statusEnabled?: boolean
    rpcEnabled: boolean
    /** Which RPC mode is active: 'normal' (RpcConfig) or 'game' (GameConfig). */
    rpcMode?: 'normal' | 'game' | null
    gatewayReady: boolean
    userStatus: string
    customStatus: string | null
    customStatusEmoji: string | null
    statusPlatform?: string
    vrStatusActive: boolean
    sleepTimerActive: boolean
    sleepTimerEndsAt: string | null
    hasDiscordToken?: boolean
    lastPresenceUpdate?: string | null
  }
  trial?: {
    active: boolean
    endsAt: string | null
    msLeft: number
    daysLeft: number
  }
  /** Subscription lifecycle — the access source of truth. */
  subscription?: SubscriptionInfo
  /** Discord server invite — the renew channel for suspended users. */
  renewUrl?: string
  /** Free trial length (days) for new signups. */
  trialDays?: number
  globalConfig?: {
    city: string | null
    timezone: string
    tempUnit?: string
    rotatorEnabled: boolean
    rotatorIntervalMins: number
  } | null
  rpcConfig?: RpcConfig | null
  /** Multi-RPC: every slot (max 3) with its own config + enabled flag. */
  rpcSlots?: RpcConfig[]
  /** RPC Auto Rotate settings (optional runtime rotation across enabled RPCs). */
  autoRotate?: {
    enabled: boolean
    secs: number
    /** forward | reverse | shuffle (Task 87). */
    order: 'forward' | 'reverse' | 'shuffle'
    /** false = the Game RPC keeps its own always-visible session while slots rotate. */
    includeGame: boolean
    /** Manual advance counter ("Skip to next RPC"). */
    skip: number
    /** Rotation clock anchor (ms epoch) — the UI recomputes the countdown from it. */
    refMs: number | null
  } | null
  /** Task 87 — live rotation state (what the daemon is publishing right now). */
  rotationPreview?: {
    pool: Array<{ name: string; type: string; game: boolean }>
    nowIndex: number
    nowName: string
    nextIndex: number
    nextName: string
    nextSwitchInSecs: number
  } | null
  /** The ACTIVE RPC mode's own config (game config in Gamer RPC mode). */
  activeRpcConfig?: RpcConfig | null
  /** The currently enabled game (Gamer RPC config owner), if any. */
  activeGame?: { slug: string; name: string; enabled: boolean } | null
  rotatorPresets?: RotatorPreset[]
  rotatorEnabled?: boolean
  app?: { name: string; tagline: string }
}

export interface RpcConfig {
  id?: string
  /** RPC slot number 1..3 (multi-RPC). */
  slot?: number
  name?: string
  type?: string
  platform?: string
  state?: string | null
  details?: string | null
  largeImage?: string | null
  largeText?: string | null
  smallImage?: string | null
  smallText?: string | null
  button1Label?: string | null
  button1Url?: string | null
  button2Label?: string | null
  button2Url?: string | null
  partyCurrent?: number | null
  partyMax?: number | null
  partyId?: string | null
  partySecret?: string | null
  startMinsAgo?: number
  endTotalMins?: number | null
  /** Discord Application ID (user's own app) — presence is presented as that application; empty = 10X identity. */
  appId?: string | null
  enabled?: boolean
}

export interface RotatorPreset {
  id?: string
  emoji?: string | null
  text: string
  durationMins?: number
  enabled?: boolean
  order?: number
}

export interface GameListItem {
  slug: string
  name: string
  largeImage: string
  iconUrl?: string
  defaultDetails?: string
  enabled: boolean
  saved: boolean
  custom?: boolean
  /** Discord Application ID (custom games added by App ID). */
  appId?: string | null
}

/** Game/app candidate from /api/games/discover — trending-games ranking plus
 * the full 24,600+ Discord detectable-games catalog, so every query shows ALL
 * real-game results. */
export interface DiscoveredApp {
  appId: string
  name: string
  iconUrl: string | null
  coverUrl: string | null
  description: string
  verified: boolean
  isGame: boolean
  tags: string[]
  /** Which Discord source produced this result. */
  source: 'trending' | 'detectable'
}

/** Favorite Game entry — REMOVED (the Favorite Game board was retired). */

export interface GamePreset {
  slug: string
  name: string
  largeImage: string
  largeText: string
  defaultState: string
  defaultDetails: string
  defaultPlatform: string
  defaultPartyMax: number
  defaultPartyCurrent: number
  defaultEndTotalMins: number | null
  tags: string[]
  custom?: boolean
}

export interface GameConfig {
  id?: string
  enabled: boolean
  appId?: string | null
  platform: string
  state: string | null
  details: string | null
  largeImage: string | null
  largeText: string | null
  smallImage: string | null
  smallText: string | null
  button1Label: string | null
  button1Url: string | null
  button2Label: string | null
  button2Url: string | null
  partyCurrent: number
  partyMax: number
  partyId: string | null
  partySecret: string | null
  startMinsAgo: number
  endTotalMins: number | null
}

export interface PlaceholderEntry {
  token: string
  desc: string
}

/** Live system health for the admin dashboard (from /api/admin/stats). */
export interface AdminSystemHealth {
  operational: boolean
  degraded: boolean
  serverRegion: string
  database: { ok: boolean; latencyMs: number | null }
  discord: { ok: boolean; latencyMs: number | null }
  daemon: {
    ok: boolean
    latencyMs: number | null
    configured: boolean
    running?: boolean
    daemonUptimeSeconds?: number
    activeConnections?: number
    totalTrackedUsers?: number
  }
}

export interface AdminStats {
  ok: boolean
  counts: {
    totalUsers: number
    newUsers24h: number
    activeSessions: number
    sessionsWithToken: number
    rpcLive: number
    statusEnabled: number
    vrActive: number
    sleepTimersActive: number
    gamesEnabled: number
    customGames: number
    rotatorPresets: number
    rotatorEnabledUsers: number
    mirrorAssets: number
    discordAssets: number
    trialsActive: number
    trialsExpired: number
    subsActive: number
    subsTrialing: number
    subsSuspended: number
    subsLifetime: number
    /** Paid Razorpay payments in the ledger. */
    paymentsPaid: number
    /** Sum of paid amounts in paise (₹ = value / 100). */
    paymentsRevenue: number
    oauthStates: number
  }
  system: AdminSystemHealth
  /** Signups per day for the last 7 days (oldest → today). */
  signupTrend?: { date: string; count: number }[]
  /** Up to 5 most recently registered users. */
  newestUsers?: { id: string; username: string; createdAt: string }[]
  checkedAt: string
}

export type AdminSessionAction = 'revoke' | 'purge-expired' | 'purge-oauth'

/** One row of the admin session monitor (/api/admin/sessions). */
export interface AdminSessionRow {
  id: string
  userId: string
  username: string
  avatar: string
  discordId: string
  createdAt: string
  expiresAt: string
  statusEnabled: boolean
  rpcEnabled: boolean
  gatewayReady: boolean
  userStatus: string
  customStatus: string | null
  customStatusEmoji: string | null
  statusPlatform: string
  vrStatusActive: boolean
  hasDiscordToken: boolean
  sleepTimerActive: boolean
  lastPresenceUpdate: string | null
  /** The session backing the admin's current request — revoke is blocked. */
  isCurrent: boolean
  isSelf: boolean
}

export interface AdminSessionsResponse {
  ok: boolean
  scope: 'active' | 'expired'
  summary: {
    activeCount: number
    expiredCount: number
    expiringSoon24h: number
    withTokenActive: number
    rpcLiveActive: number
  }
  sessions: AdminSessionRow[]
}

/** Non-secret platform settings for the admin Settings tab. */
export interface AdminSettings {
  ok: boolean
  app: {
    name: string
    url: string
    trialDays: number
    sessionTtlDays: number
    nodeEnv: string
  }
  discord: {
    clientId: string
    oauthScope: string
    autoJoinGuildId: string | null
    inviteUrl: string
    botConfigured: boolean
    oauthConfigured: boolean
  }
  infra: {
    serverRegion: string
    daemonConfigured: boolean
    daemonHost: string | null
    panelConfigured: boolean
    panelHost: string | null
  }
  payments: {
    razorpayConfigured: boolean
    webhookConfigured: boolean
    currency: string
    webhookPath: string
    plans: { id: 'plus' | 'pro'; label: string; amount: number; periodDays: number; display: string }[]
  }
  admin: {
    adminDiscordIds: string[]
    yourDiscordId: string
    adminCount: number
  }
  checkedAt: string
}

export type AdminUserAction =
  | 'enable-rpc' | 'disable-rpc' | 'extend-trial' | 'revoke-sessions'
  | 'grant-subscription' | 'suspend-subscription' | 'reset-trial' | 'grant-lifetime'

/** One Razorpay ledger row (admin Payments tab). */
export interface AdminPaymentRow {
  id: string
  orderId: string
  paymentId: string | null
  plan: string
  /** Paise — divide by 100 for ₹. */
  amount: number
  currency: string
  status: 'created' | 'paid' | string
  createdAt: string
  username: string
  discordId: string
  avatar: string
}

export interface AdminPaymentsResponse {
  ok: boolean
  summary: {
    revenueTotalPaise: number
    revenue30dPaise: number
    paidCount: number
    paid30dCount: number
    createdCount: number
    payingUsers: number
    plusPaid: number
    proPaid: number
  }
  payments: AdminPaymentRow[]
  checkedAt: string
}

export interface AdminUser {
  id: string
  discordId: string
  username: string
  avatar: string
  createdAt: string
  trial: {
    active: boolean
    endsAt: string | null
    daysLeft: number
  } | null
  subscription: SubscriptionInfo
  rpc: {
    rpcEnabled: boolean
    gatewayReady: boolean
    userStatus: string
    customStatus: string | null
    customStatusEmoji: string | null
    vrStatusActive: boolean
    hasDiscordToken: boolean
    lastPresenceUpdate: string | null
    sleepTimerActive: boolean
    sleepTimerEndsAt: string | null
  } | null
  rpcConfig: {
    name: string
    type: string
    platform: string
    enabled: boolean
  } | null
  globalConfig: {
    city: string | null
    timezone: string
    tempUnit?: string
    rotatorEnabled: boolean
  } | null
  isAdmin: boolean
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const isGet = !init?.method || init.method.toUpperCase() === 'GET'
  const maxAttempts = isGet ? 3 : 1
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        ...init,
      })
      if (!res.ok) {
        if (res.status === 401) {
          throw new Error('not_authenticated')
        }
        if (isGet && attempt < maxAttempts && (res.status === 500 || res.status === 503)) {
          await new Promise(r => setTimeout(r, 600 * attempt))
          continue
        }
        const text = await res.text().catch(() => '')
        let msg = text
        // Prefer the human-readable `message` (e.g. "Connect your Discord
        // account first…") over the raw error code in UI toasts.
        try { const j = JSON.parse(text); msg = j.message || j.error || text } catch {}
        throw new Error(msg || `Request failed: ${res.status}`)
      }
      return (await res.json()) as T
    } catch (err: any) {
      if (err?.message === 'not_authenticated') {
        throw err
      }
      lastError = err
      if (isGet && attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 600 * attempt))
        continue
      }
      throw err
    }
  }
  throw lastError || new Error('Request failed')
}

export const api = {
  me: () => fetchJson<Me>('/api/me'),
  /** Current user's subscription state (runs the lazy suspension sweep). */
  subscription: () => fetchJson<{ ok: boolean; subscription: SubscriptionInfo; transitioned: boolean; renewUrl: string; trialDays: number }>('/api/subscription'),
  /** Create a Razorpay order for a paid plan (Checkout.js). */
  subscriptionCheckout: (plan: PaidPlanId) =>
    fetchJson<SubscriptionCheckout>('/api/subscription/checkout', { method: 'POST', body: JSON.stringify({ plan }) }),
  /** Verify a completed Razorpay payment → activate the subscription. */
  subscriptionVerify: (payload: RazorpayHandlerResponse) =>
    fetchJson<{ ok: boolean; repeat?: boolean; plan?: string; planLabel?: string; lifted?: boolean; subscription?: SubscriptionInfo; error?: string; message?: string }>('/api/subscription/verify', {
      method: 'POST', body: JSON.stringify(payload),
    }),
  logout: () => fetchJson<{ ok: boolean; redirect: string }>('/api/logout', { method: 'POST' }),
  demoLogin: () => fetchJson<{ ok: boolean; demo: boolean; sessionToken?: string; redirect?: string }>('/api/demo-login', { method: 'POST' }),

  rpcSave: (data: RpcConfig) => fetchJson<{ ok: boolean; rpcConfig: RpcConfig; rpcEnabled?: boolean; message?: string }>('/api/rpc', {
    method: 'POST', body: JSON.stringify(data),
  }),
  rpcGet: () => fetchJson<{ rpcConfig: RpcConfig | null }>('/api/rpc'),
  rpcUpdate: () => fetchJson<{
    ok: boolean
    method?: string
    message?: string
    error?: string
    rpcEnabled?: boolean
    gatewayReady?: boolean
  }>('/api/rpc/update', { method: 'POST' }),
  rpcToggle: (enabled: boolean) => fetchJson<{
    ok: boolean
    enabled: boolean
    message?: string
    error?: string
  }>('/api/rpc/toggle', {
    method: 'POST', body: JSON.stringify({ enabled }),
  }),

  // ── Multi-RPC slots (max 3) ──
  rpcSlotsList: () => fetchJson<{
    ok: boolean
    maxSlots: number
    slots: RpcConfig[]
    autoRotate: Me['autoRotate']
    game: { slug: string; name: string; enabled: boolean } | null
  }>('/api/rpc/slots'),
  rpcSlotCreate: () => fetchJson<{
    ok: boolean
    slot?: number
    rpcConfig?: RpcConfig
    message?: string
    error?: string
  }>('/api/rpc/slots', { method: 'POST' }),
  rpcSlotSave: (id: string, data: RpcConfig) => fetchJson<{
    ok: boolean
    rpcConfig?: RpcConfig
    enabled?: boolean
    message?: string
    error?: string
  }>(`/api/rpc/slots/${id}`, {
    method: 'PUT', body: JSON.stringify(data),
  }),
  rpcSlotDelete: (id: string) => fetchJson<{
    ok: boolean
    message?: string
    error?: string
  }>(`/api/rpc/slots/${id}`, { method: 'DELETE' }),
  rpcSlotToggle: (id: string, enabled: boolean) => fetchJson<{
    ok: boolean
    enabled: boolean
    rpcConfig?: RpcConfig
    message?: string
    error?: string
  }>(`/api/rpc/slots/${id}/toggle`, {
    method: 'POST', body: JSON.stringify({ enabled }),
  }),
  rpcRotateSave: (enabled: boolean, secs: number, order?: 'forward' | 'reverse' | 'shuffle', includeGame?: boolean) => fetchJson<{
    ok: boolean
    autoRotate?: NonNullable<Me['autoRotate']>
    message?: string
    error?: string
  }>('/api/rpc/rotate', {
    method: 'POST', body: JSON.stringify({ enabled, secs, order, includeGame }),
  }),
  rpcRotateSkip: () => fetchJson<{
    ok: boolean
    autoRotate?: NonNullable<Me['autoRotate']>
    message?: string
    error?: string
  }>('/api/rpc/rotate/skip', { method: 'POST' }),

  customStatus: (emoji: string | null, text: string | null) =>
    fetchJson<{ ok: boolean }>('/api/rpc/custom-status', {
      method: 'POST', body: JSON.stringify({ emoji, text }),
    }),
  clearCustomStatus: () => fetchJson<{ ok: boolean }>('/api/rpc/clear', { method: 'POST' }),

  setStatus: (status: string) => fetchJson<{ ok: boolean; status: string }>('/api/rpc/status', {
    method: 'POST', body: JSON.stringify({ status }),
  }),
  statusUpdate: (data: {
    userStatus?: string
    customStatus?: string | null
    customStatusEmoji?: string | null
    statusPlatform?: string
  }) =>
    fetchJson<{
      ok: boolean
      statusEnabled: boolean
      userStatus: string
      customStatus: string | null
      customStatusEmoji: string | null
      statusPlatform: string
      autoOnline?: boolean
      autoNone?: boolean
      message?: string
      error?: string
      sync?: { ok: boolean; message: string } | null
    }>('/api/status/update', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  statusToggle: (enabled: boolean) => fetchJson<{ ok: boolean; statusEnabled: boolean; userStatus?: string; statusPlatform?: string; autoNone?: boolean }>('/api/status/toggle', {
    method: 'POST', body: JSON.stringify({ enabled }),
  }),

  vrToggle: (active: boolean) => fetchJson<{ ok: boolean; vrStatusActive: boolean }>(
    '/api/vr-status/enable', { method: 'POST', body: JSON.stringify({ active }) }
  ),

  gamesList: () => fetchJson<{ games: GameListItem[] }>('/api/games/list'),
  gamesDiscover: (q: string, limit = 24) =>
    fetchJson<{ ok: boolean; results: DiscoveredApp[]; popular?: boolean }>(
      `/api/games/discover?q=${encodeURIComponent(q)}&limit=${limit}`
    ),
  gameConfig: (slug: string) => fetchJson<{ preset: GamePreset; config: GameConfig | null }>(`/api/games/${slug}`),
  gameSave: (slug: string, data: Partial<GameConfig>) => fetchJson<{ ok: boolean; config: GameConfig }>(
    `/api/games/${slug}`, { method: 'POST', body: JSON.stringify(data) }
  ),
  gameCustomCreate: (data: { appId: string; name?: string; details?: string; iconUrl?: string }) =>
    fetchJson<{ ok: boolean; config: GameConfig; existing?: boolean }>('/api/games/custom', { method: 'POST', body: JSON.stringify(data) }),
  gameDelete: (slug: string) => fetchJson<{ ok: boolean }>(`/api/games/${slug}`, { method: 'DELETE' }),
  appLookup: (appId: string) =>
    fetchJson<{ ok: boolean; name: string; iconUrl: string | null }>(`/api/games/app-lookup?appId=${encodeURIComponent(appId)}`),

  configSave: (city: string | null, timezone: string, tempUnit: 'C' | 'F' = 'C') => fetchJson<{ ok: boolean; globalConfig: { city: string | null; timezone: string; tempUnit: string } }>(
    '/api/config/save', { method: 'POST', body: JSON.stringify({ city, timezone, tempUnit }) }
  ),
  configAutoDetect: (browserTimezone?: string) => fetchJson<{
    ok: boolean
    globalConfig: { city: string | null; timezone: string; tempUnit?: string }
    detected?: { city: string; timezone: string }
  }>('/api/config/auto-detect', { method: 'POST', body: JSON.stringify({ browserTimezone }) }),

  rotatorList: () => fetchJson<{ presets: RotatorPreset[] }>('/api/rotator/list'),
  rotatorSave: (data: RotatorPreset) => fetchJson<{ ok: boolean; preset: RotatorPreset }>(
    '/api/rotator/save', { method: 'POST', body: JSON.stringify(data) }
  ),
  rotatorDelete: (id: string) => fetchJson<{ ok: boolean }>(`/api/rotator/save?id=${id}`, { method: 'DELETE' }),
  rotatorToggle: (enabled: boolean, intervalMins?: number) =>
    fetchJson<{ ok: boolean }>('/api/rotator/toggle', {
      method: 'POST', body: JSON.stringify({ enabled, intervalMins }),
    }),

  sleepTimer: (hours: number | null) => fetchJson<{ ok: boolean; active?: boolean; endsAt?: string }>(
    '/api/sleep-timer', { method: 'POST', body: JSON.stringify({ hours }) }
  ),

  weather: (city: string) => fetchJson<{ tempC: number; condition: string; emoji: string; city: string }>(
    `/api/weather?city=${encodeURIComponent(city)}`
  ),

  background: (url: string | null) => fetchJson<{ ok: boolean; backgroundUrl: string | null }>(
    '/api/background', { method: 'POST', body: JSON.stringify({ url }) }
  ),

  keepAlive: () => fetchJson<{
    ok: boolean
    totalActive: number
    successCount: number
    failCount: number
    results: Array<{ userId: string; username: string; ok: boolean; message: string }>
  }>('/api/rpc/keep-alive', { method: 'POST' }),

  adminUsers: () => fetchJson<{
    ok: boolean
    totalUsers: number
    activeRpcUsers: number
    users: AdminUser[]
  }>('/api/admin/users'),

  adminStats: () => fetchJson<AdminStats>('/api/admin/stats'),

  adminUserAction: (userId: string, action: AdminUserAction, opts?: { days?: number; plan?: 'plus' | 'pro' }) =>
    fetchJson<{ ok: boolean; action: string; message: string }>('/api/admin/user-action', {
      method: 'POST',
      body: JSON.stringify({ userId, action, ...(opts?.days != null ? { days: opts.days } : {}), ...(opts?.plan ? { plan: opts.plan } : {}) }),
    }),

  /** Admin Payments tab — Razorpay ledger + revenue summary. */
  adminPayments: () => fetchJson<AdminPaymentsResponse>('/api/admin/payments'),

  adminForceRpc: (enable: boolean) => fetchJson<{
    ok: boolean
    action: string
    totalUsers: number
    successCount: number
    failCount: number
    results: Array<{ userId: string; username: string; ok: boolean; message: string }>
  }>('/api/admin/force-rpc', { method: 'POST', body: JSON.stringify({ enable }) }),

  adminSessions: (scope: 'active' | 'expired' = 'active') =>
    fetchJson<AdminSessionsResponse>(`/api/admin/sessions?scope=${scope}`),

  adminSessionAction: (action: AdminSessionAction, sessionId?: string) =>
    fetchJson<{ ok: boolean; action: string; message: string }>('/api/admin/session-action', {
      method: 'POST', body: JSON.stringify({ action, sessionId }),
    }),

  adminSettings: () => fetchJson<AdminSettings>('/api/admin/settings'),

  placeholders: () => fetchJson<{ placeholders: PlaceholderEntry[] }>('/api/placeholders'),
  resolvePlaceholders: (
    text: string,
    overrides?: { city?: string | null; timezone?: string; tempUnit?: 'C' | 'F'; rpcStartedAt?: number }
  ) => fetchJson<{ original: string; resolved: string }>(
    '/api/placeholders', { method: 'POST', body: JSON.stringify({ text, ...overrides }) }
  ),

  // ---------- Admin: plans ----------
  adminPlans: () => fetchJson<AdminPlansResponse>('/api/admin/plans'),
  adminPlanCreate: (data: AdminPlanInput) =>
    fetchJson<{ ok: boolean; plan: AdminPlan }>('/api/admin/plans', { method: 'POST', body: JSON.stringify(data) }),
  adminPlanUpdate: (id: string, data: Partial<AdminPlanInput>) =>
    fetchJson<{ ok: boolean; plan: AdminPlan }>(`/api/admin/plans/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  adminPlanDelete: (id: string) =>
    fetchJson<{ ok: boolean }>(`/api/admin/plans/${id}`, { method: 'DELETE' }),

  // ---------- Admin: trial policy ----------
  adminTrialConfig: () => fetchJson<AdminTrialConfigResponse>('/api/admin/trial-config'),
  adminTrialConfigUpdate: (data: Partial<AdminTrialConfig> & { reason?: string }) =>
    fetchJson<{ ok: boolean; config: AdminTrialConfig }>('/api/admin/trial-config', { method: 'PUT', body: JSON.stringify(data) }),

  // ---------- Admin: subscriptions ----------
  adminSubscriptions: (params: {
    q?: string
    status?: AdminSubFilter
    plan?: string
    sort?: string
    page?: number
    pageSize?: number
  } = {}) => {
    const sp = new URLSearchParams()
    if (params.q) sp.set('q', params.q)
    if (params.status && params.status !== 'all') sp.set('status', params.status)
    if (params.plan && params.plan !== 'all') sp.set('plan', params.plan)
    if (params.sort) sp.set('sort', params.sort)
    if (params.page) sp.set('page', String(params.page))
    if (params.pageSize) sp.set('pageSize', String(params.pageSize))
    const qs = sp.toString()
    return fetchJson<AdminSubscriptionsResponse>(`/api/admin/subscriptions${qs ? `?${qs}` : ''}`)
  },
  /** Subscription surgery — every action requires a reason (server-enforced). */
  adminSubscriptionAdjust: (payload: {
    userId: string
    action: AdminAdjustAction
    reason: string
    days?: number
    date?: string
    plan?: string
    note?: string
    expectedUpdatedAt?: string
  }) =>
    fetchJson<{ ok: boolean; action: string; message: string; subscription?: SubscriptionInfo }>(
      '/api/admin/subscriptions/adjust', { method: 'POST', body: JSON.stringify(payload) },
    ),
  adminUserDetail: (userId: string) => fetchJson<AdminUserDetail>(`/api/admin/users/${userId}`),

  // ---------- Admin: audit + analytics ----------
  adminAudit: (params: { action?: string; actorId?: string; targetType?: string; q?: string; page?: number; pageSize?: number } = {}) => {
    const sp = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v) sp.set(k, String(v))
    const qs = sp.toString()
    return fetchJson<AdminAuditResponse>(`/api/admin/audit${qs ? `?${qs}` : ''}`)
  },
  adminAnalytics: () => fetchJson<AdminAnalytics>('/api/admin/analytics'),

  /** Public pricing catalog (GET /api/plans) — DB plans + trial policy. */
  publicPlans: () => fetchJson<PublicPlans>('/api/plans'),
}

// ---------- Admin subscription-management types ----------

/** Public pricing catalog (GET /api/plans) — the landing page renders this. */
export interface PublicPlans {
  ok: boolean
  currency: string
  plans: {
    slug: string
    name: string
    description: string | null
    amount: number // paise
    originalAmount: number | null
    durationDays: number
    badge: string | null
    features: string[]
    displayOrder: number
  }[]
  trial: { enabled: boolean; days: number; name: string; description: string; features: string[] } | null
}

export interface AdminPlan {
  id: string
  slug: string
  name: string
  description: string | null
  amount: number // paise
  originalAmount: number | null
  durationDays: number
  badge: string | null
  features: string[]
  active: boolean
  visible: boolean
  displayOrder: number
  trial: boolean
  archived: boolean
  createdAt: string
  updatedAt: string
  subscribers: number
  paidCount: number
  revenuePaise: number
}

export interface AdminPlanInput {
  slug?: string
  name: string
  description?: string | null
  amount: number
  originalAmount?: number | null
  durationDays: number
  badge?: string | null
  features?: string[]
  active?: boolean
  visible?: boolean
  archived?: boolean
  displayOrder?: number
  reason?: string
}

export interface AdminPlansResponse {
  ok: boolean
  plans: AdminPlan[]
  checkedAt: string
}

export interface AdminTrialConfig {
  enabled: boolean
  days: number
  name: string
  description: string
  features: string[]
  allowRepeat: boolean
  updatedAt?: string
}

export interface AdminTrialConfigResponse {
  ok: boolean
  config: AdminTrialConfig
  stats: { trialing: number; expired: number; converted: number }
  checkedAt: string
}

export type AdminSubFilter = 'all' | 'trialing' | 'active' | 'suspended' | 'expired' | 'expiring'

export interface AdminSubUser {
  id: string
  discordId: string
  username: string
  avatar: string
  createdAt: string
  adminNote: string | null
  subscription: SubscriptionInfo
  subscriptionRaw: { createdAt: string; updatedAt: string } | null
  session: { rpcEnabled: boolean; hasDiscordToken: boolean; userStatus: string } | null
  lastPayment: { plan: string; planLabel: string | null; amount: number; status: string; createdAt: string } | null
  isAdmin: boolean
}

export interface AdminSubscriptionsResponse {
  ok: boolean
  page: number
  pageSize: number
  filtered: number
  totalPages: number
  summary: { total: number; trialing: number; active: number; suspended: number; expiringSoon: number; lifetime: number }
  users: AdminSubUser[]
  checkedAt: string
}

export type AdminAdjustAction =
  | 'add_days' | 'subtract_days' | 'set_expiry' | 'set_start' | 'set_plan'
  | 'grant_plan' | 'grant_trial' | 'suspend' | 'reactivate' | 'expire_now'
  | 'cancel' | 'clear_expiry' | 'add_note'

export interface AdminAuditRow {
  id: string
  action: string
  actorId: string
  actorName: string | null
  targetType: string | null
  targetId: string | null
  targetLabel: string | null
  beforeJson: string | null
  afterJson: string | null
  reason: string | null
  outcome: string
  createdAt: string
}

export interface AdminAuditResponse {
  ok: boolean
  page: number
  pageSize: number
  total: number
  totalPages: number
  logs: AdminAuditRow[]
}

export interface AdminUserDetail {
  ok: boolean
  user: {
    id: string
    discordId: string
    username: string
    discriminator: string | null
    avatar: string
    createdAt: string
    adminNote: string | null
    isAdmin: boolean
    session: {
      rpcEnabled: boolean
      statusEnabled: boolean
      hasDiscordToken: boolean
      vrStatusActive: boolean
      userStatus: string
      lastPresenceUpdate: string | null
    } | null
  }
  subscription: (SubscriptionInfo & {
    raw: {
      id: string
      plan: string
      status: string
      createdAt: string
      updatedAt: string
      trialEndsAt: string | null
      currentPeriodEnd: string | null
      suspendedAt: string | null
      trialUsed: boolean
    }
  }) | null
  payments: {
    id: string
    orderId: string
    paymentId: string | null
    plan: string
    planLabel: string | null
    amount: number
    currency: string
    status: string
    periodDays: number | null
    createdAt: string
  }[]
  audits: AdminAuditRow[]
  plans: { slug: string; name: string; amount: number; durationDays: number; active: boolean }[]
  checkedAt: string
}

export interface AdminAnalytics {
  ok: boolean
  subscriptions: {
    total: number
    trialing: number
    active: number
    suspended: number
    expired: number
    adminSuspended: number
    lifetime: number
    expiring7d: number
    expiring30d: number
  }
  conversion: { everTrialed: number; payingUsers: number; rate: number; renewals: number }
  revenue: { allTimePaise: number; last30dPaise: number; paidCount: number; paid30dCount: number; payingUsers: number }
  planPopularity: {
    subscriptions: { plan: string; count: number }[]
    payments: { plan: string; count: number; revenuePaise: number }[]
  }
  trend: { date: string; signups: number; paid: number; revenuePaise: number }[]
  checkedAt: string
}
