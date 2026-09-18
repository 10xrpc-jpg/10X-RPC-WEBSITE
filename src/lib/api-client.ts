// 10X RPC — frontend API client
export interface Me {
  authenticated: boolean
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
  globalConfig?: {
    city: string | null
    timezone: string
    rotatorEnabled: boolean
    rotatorIntervalMins: number
  } | null
  rpcConfig?: RpcConfig | null
  rotatorPresets?: RotatorPreset[]
  rotatorEnabled?: boolean
  app?: { name: string; tagline: string }
}

export interface RpcConfig {
  id?: string
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
}

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
}

export interface GameConfig {
  id?: string
  enabled: boolean
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
        try { msg = JSON.parse(text).error || text } catch {}
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
  logout: () => fetchJson<{ ok: boolean; redirect: string }>('/api/logout', { method: 'POST' }),
  demoLogin: () => fetchJson<{ ok: boolean; demo: boolean; sessionToken?: string; redirect?: string }>('/api/demo-login', { method: 'POST' }),

  rpcSave: (data: RpcConfig) => fetchJson<{ ok: boolean; rpcConfig: RpcConfig }>('/api/rpc', {
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
      message?: string
      error?: string
    }>('/api/status/update', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  statusToggle: (enabled: boolean) => fetchJson<{ ok: boolean; statusEnabled: boolean; userStatus?: string }>('/api/status/toggle', {
    method: 'POST', body: JSON.stringify({ enabled }),
  }),

  vrToggle: (active: boolean) => fetchJson<{ ok: boolean; vrStatusActive: boolean }>(
    '/api/vr-status/enable', { method: 'POST', body: JSON.stringify({ active }) }
  ),

  gamesList: () => fetchJson<{ games: GameListItem[] }>('/api/games/list'),
  gameConfig: (slug: string) => fetchJson<{ preset: GamePreset; config: GameConfig | null }>(`/api/games/${slug}`),
  gameSave: (slug: string, data: Partial<GameConfig>) => fetchJson<{ ok: boolean; config: GameConfig }>(
    `/api/games/${slug}`, { method: 'POST', body: JSON.stringify(data) }
  ),

  configSave: (city: string | null, timezone: string) => fetchJson<{ ok: boolean }>(
    '/api/config/save', { method: 'POST', body: JSON.stringify({ city, timezone }) }
  ),
  configAutoDetect: () => fetchJson<{ ok: boolean }>('/api/config/auto-detect', { method: 'POST' }),

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

  adminForceRpc: (enable: boolean) => fetchJson<{
    ok: boolean
    action: string
    totalUsers: number
    successCount: number
    failCount: number
    results: Array<{ userId: string; username: string; ok: boolean; message: string }>
  }>('/api/admin/force-rpc', { method: 'POST', body: JSON.stringify({ enable }) }),

  placeholders: () => fetchJson<{ placeholders: PlaceholderEntry[] }>('/api/placeholders'),
  resolvePlaceholders: (text: string) => fetchJson<{ original: string; resolved: string }>(
    '/api/placeholders', { method: 'POST', body: JSON.stringify({ text }) }
  ),
}
