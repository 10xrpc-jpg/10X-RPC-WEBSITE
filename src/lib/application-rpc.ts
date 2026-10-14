// 10X RPC — Application RPC — shared pure helpers (Task 90)
//
// Application RPC is the THIRD, fully independent RPC system alongside the
// Normal RPC slots (RpcConfig) and the Game RPC (GameConfig). This module
// holds the PURE, dependency-free pieces shared by the website routes, the
// frontend and the standalone daemon:
//   • the serialized config shape sent to the client
//   • run-state vocabulary + human labels
//   • Application ID validation (format + Game-catalog reservation)
//
// Deliberately NO database / secrets / imports of the other RPC systems —
// everything here is safe to import from any layer without coupling the
// three systems together.

import { DISCORD_APP_ID_RE, isGameApplicationId } from './games'

/** Serialized Application RPC config — exactly what the API returns. */
export interface ApplicationRpcView {
  id: string
  name: string
  type: string
  platform: string
  appId: string | null
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
  partyCurrent: number | null
  partyMax: number | null
  startMinsAgo: number
  endTotalMins: number | null
  enabled: boolean
  /** Daemon-written execution truth: idle | starting | running | error. */
  runState: ApplicationRunState
  /** Exact backend-reported reason when runState === 'error'. */
  runError: string | null
  /** ISO timestamp of the last run-state change (drives "running for X"). */
  runSinceAt: string | null
}

/** The Application RPC's own lifecycle states (independent status management). */
export type ApplicationRunState = 'idle' | 'starting' | 'running' | 'error'

export const APPLICATION_RUN_STATES: readonly ApplicationRunState[] = ['idle', 'starting', 'running', 'error']

export function normalizeRunState(v: unknown): ApplicationRunState {
  return APPLICATION_RUN_STATES.includes(v as ApplicationRunState)
    ? (v as ApplicationRunState)
    : 'idle'
}

/** Human label + accent for each run state (the UI renders these verbatim). */
export function applicationRunStateLabel(s: ApplicationRunState): { label: string; tone: 'off' | 'wait' | 'live' | 'bad' } {
  switch (s) {
    case 'running': return { label: 'Running', tone: 'live' }
    case 'starting': return { label: 'Starting…', tone: 'wait' }
    case 'error': return { label: 'Error', tone: 'bad' }
    default: return { label: 'Disabled', tone: 'off' }
  }
}

/** Activity type options — same vocabulary as the Normal RPC form. */
export const APPLICATION_TYPE_OPTIONS = [
  { value: 'PLAYING', label: 'Playing' },
  { value: 'STREAMING', label: 'Streaming' },
  { value: 'LISTENING', label: 'Listening' },
  { value: 'WATCHING', label: 'Watching' },
  { value: 'COMPETING', label: 'Competing' },
] as const

/**
 * Validate an Application ID for the Application RPC.
 * Returns the cleaned id, or a stable rejection reason:
 *   • null/empty        → { ok: true, appId: null } (allowed on SAVE; enabling
 *                          requires an id — enforced in the toggle route)
 *   • bad format        → { ok: false, reason: 'invalid_app_id' }
 *   • game catalog id   → { ok: false, reason: 'game_app_id_reserved' }
 *   • valid             → { ok: true, appId }
 *
 * Game catalog ids (Minecraft, Valorant, CS2, …) are reserved EXCLUSIVELY for
 * the isolated Game RPC (same rule the Normal RPC slots enforce) — an
 * Application RPC must present under its OWN application, not a game's.
 */
export function validateApplicationRpcAppId(input: unknown): { ok: boolean; appId: string | null; reason?: string } {
  if (input === null || input === undefined) return { ok: true, appId: null }
  if (typeof input !== 'string') return { ok: false, appId: null, reason: 'invalid_app_id' }
  const t = input.trim()
  if (!t) return { ok: true, appId: null }
  if (!DISCORD_APP_ID_RE.test(t)) return { ok: false, appId: null, reason: 'invalid_app_id' }
  if (isGameApplicationId(t)) return { ok: false, appId: null, reason: 'game_app_id_reserved' }
  return { ok: true, appId: t }
}

/** True when the value is a well-formed, non-game Application ID (enable gate). */
export function isUsableApplicationRpcAppId(appId: string | null | undefined): boolean {
  return !!appId && DISCORD_APP_ID_RE.test(appId) && !isGameApplicationId(appId)
}

/**
 * Serialize a raw ApplicationRpcConfig row (Prisma row or raw-SQL row) for the
 * client. Secret-free by construction — this row carries no tokens; the
 * Discord OAuth tokens live exclusively on the Session row and are never
 * exposed by any Application RPC surface.
 */
export function serializeApplicationRpc(row: Record<string, unknown>): ApplicationRpcView {
  return {
    id: String(row.id ?? ''),
    name: typeof row.name === 'string' ? row.name : '10X RPC',
    type: typeof row.type === 'string' ? row.type : 'PLAYING',
    platform: typeof row.platform === 'string' ? row.platform : 'meta_quest',
    appId: typeof row.appId === 'string' && row.appId ? row.appId : null,
    state: typeof row.state === 'string' ? row.state : null,
    details: typeof row.details === 'string' ? row.details : null,
    largeImage: typeof row.largeImage === 'string' ? row.largeImage : null,
    largeText: typeof row.largeText === 'string' ? row.largeText : null,
    smallImage: typeof row.smallImage === 'string' ? row.smallImage : null,
    smallText: typeof row.smallText === 'string' ? row.smallText : null,
    button1Label: typeof row.button1Label === 'string' ? row.button1Label : null,
    button1Url: typeof row.button1Url === 'string' ? row.button1Url : null,
    button2Label: typeof row.button2Label === 'string' ? row.button2Label : null,
    button2Url: typeof row.button2Url === 'string' ? row.button2Url : null,
    partyCurrent: typeof row.partyCurrent === 'number' ? row.partyCurrent : null,
    partyMax: typeof row.partyMax === 'number' ? row.partyMax : null,
    startMinsAgo: typeof row.startMinsAgo === 'number' ? row.startMinsAgo : 0,
    endTotalMins: typeof row.endTotalMins === 'number' ? row.endTotalMins : null,
    enabled: row.enabled === true,
    runState: normalizeRunState(row.runState),
    runError: typeof row.runError === 'string' ? row.runError : null,
    runSinceAt: typeof row.runSinceAt === 'string' ? row.runSinceAt : null,
  }
}
