// 10X RPC — Daemon role split (the NODE 1/2/3 deployment architecture).
//
// The user runs THREE Orihost backend servers, one per product pillar:
//   • NODE 1 = STATUS  — custom status, Online/Idle/DND account status,
//                        Mobile/VR badge session, status rotator
//   • NODE 2 = RPC     — Normal RPC slots (the multi-session "3 RPCs" system)
//   • NODE 3 = GAME RPC— isolated Game RPCs + Game Auto-Rotate (always PLAYING)
//
// The SAME codebase runs on all three. `DAEMON_ROLE` (env) selects which
// pillar the process owns:
//   • DAEMON_ROLE unset / 'all' → the classic combined behavior (sandbox,
//     local dev, and the transition window). Byte-for-byte the pre-split
//     logic — the 'all' path is never modified by the role gates.
//   • 'status' | 'rpc' | 'game' → role-gated sockets, pushes and self-heals.
//
// CROSS-DAEMON SAFETY (why this module exists):
// Discord merges concurrent gateway sessions per platform class
// (desktop/mobile/console/vr/web — last-write-wins), and the rendered cards
// per ACTIVITY-level platform label (Task 91). Three independent daemons
// pushing for the same user MUST therefore occupy DISJOINT classes/labels,
// or their pushes would silently wipe each other every tick. Every daemon
// reads the same DB state, so the allocation below is a pure, deterministic
// function of that state — all roles independently reach the same plan and
// never collide:
//
//   status role → IDENTIFY exactly the user's chosen statusPlatform
//                 (mobile | desktop(None) | meta_quest) — the badge session.
//   rpc role    → main session IDENTIFIES with the first slot's EXPLICIT
//                 device (ps4/ps5/xbox/meta_quest — the user picked it, the
//                 badge IS the feature) or the icon-less 'embedded' console
//                 class for None/legacy slots (labels no real client emits,
//                 renders NO device badge — the old unconditional 'ps4'
//                 anchor stamped PlayStation badges onto cards the user
//                 never pointed at a device, which is a product bug).
//   game role   → main session 'embedded' + activity label 'embedded'
//                 (console class — labels no real client and no other role
//                 emits), extras from [samsung, ios, android].
//
// Account-status PATCH authority (REST PATCH /users/@me/settings — Task 97):
// exactly ONE role patches for a user, decided from the DB:
//   Status enabled → status role; else Normal slots active → rpc role;
//   else Game RPC active → game role. The value follows the pre-split rule:
//   status enabled → userStatus, otherwise 'online'.

export type DaemonRole = 'status' | 'rpc' | 'game' | 'all'

/** Parse DAEMON_ROLE from the environment. Anything unknown = 'all'. */
export function daemonRoleFromEnv(): DaemonRole {
  const raw = (process.env.DAEMON_ROLE || 'all').trim().toLowerCase()
  return raw === 'status' || raw === 'rpc' || raw === 'game' ? (raw as DaemonRole) : 'all'
}

/** True when the role should track/push the STATUS pillar for a user. */
export function roleWantsStatus(role: DaemonRole): boolean {
  return role === 'all' || role === 'status'
}

/** True when the role should track/push the Normal RPC slots pillar. */
export function roleWantsRpc(role: DaemonRole): boolean {
  return role === 'all' || role === 'rpc'
}

/** True when the role should track/push the Game RPC pillar. */
export function roleWantsGame(role: DaemonRole): boolean {
  return role === 'all' || role === 'game'
}

/** Deterministic activity-label pool for GAME-role EXTRA sessions. The main
 *  game session always uses 'embedded'; extras continue here. Values are
 *  valid ACTIVITY_PLATFORM_ENUM members (Discord silently rejects others)
 *  and deliberately avoid the rpc-role extras ladder head ('embedded' —
 *  taken by the rpc main for None slots). DEVICE-SELECTION RULE: the pool
 *  contains NO ps4/ps5/xbox/meta_quest — those render device badges on
 *  cards, and a device badge may ONLY appear when the user explicitly
 *  selected that device (Game RPCs have no device selector). */
export const GAME_EXTRA_PLATFORM_POOL = ['samsung', 'ios', 'android'] as const

/** Platforms whose session class is the console family. */
const CONSOLE_FAMILY = new Set(['console', 'xbox', 'ps4', 'ps5', 'embedded'])

/** Badge/mobile families — a statusPlatform in this set renders the phone
 *  shape (BADGE_PLATFORMS semantics from constants.ts). */
const MOBILE_FAMILY = new Set(['mobile', 'android', 'ios', 'samsung'])

export interface RolePresencePlan {
  /** IDENTIFY platform for the STATUS-role session (the badge session). */
  statusSessionPlatform: string
  /** IDENTIFY platform for the RPC-role MAIN session. */
  rpcMainPlatform: string
  /** IDENTIFY platform for the GAME-role MAIN session. */
  gameMainPlatform: string
  /** Activity-level platform label stamped on the GAME-role main card. */
  gameMainLabel: string
}

/**
 * Deterministic cross-role platform plan for one user. All daemons call this
 * with the same DB state and get the same answer — no coordination needed.
 *
 * @param statusEnabled   session.statusEnabled
 * @param statusPlatform  session.statusPlatform (mobile | desktop | meta_quest)
 * @param vrActive        session.vrStatusActive
 * @param firstSlotPlatform  platform of the first ENABLED normal slot (or null)
 * @param rpcEnabled      session.rpcEnabled (slots can only own the badge via
 *                        their own meta_quest platform when this is on)
 */
export function planRolePresencePlatforms(input: {
  statusEnabled: boolean
  statusPlatform: string | null | undefined
  vrActive: boolean
  firstSlotPlatform: string | null | undefined
  rpcEnabled: boolean | null | undefined
}): RolePresencePlan {
  const { statusEnabled, statusPlatform, vrActive, firstSlotPlatform, rpcEnabled } = input

  // ── STATUS role session: IDENTIFY exactly what the user picked ──────────
  // (mobile → phone badge, desktop/None → desktop session, meta_quest → VR
  // headset). Legacy values are mapped onto the closest UI value; console
  // families cannot be produced by the current UI.
  let statusSessionPlatform = 'mobile'
  if (vrActive || statusPlatform === 'meta_quest') {
    statusSessionPlatform = 'meta_quest'
  } else if (!statusPlatform || statusPlatform === 'desktop') {
    statusSessionPlatform = 'desktop'
  } else if (MOBILE_FAMILY.has(statusPlatform)) {
    statusSessionPlatform = 'mobile'
  } else if (CONSOLE_FAMILY.has(statusPlatform)) {
    statusSessionPlatform = statusPlatform
  } else {
    statusSessionPlatform = statusPlatform // 'web' etc. — pass through
  }

  // ── RPC role main session ────────────────────────────────────────────────
  // DEVICE-SELECTION RULE (the "Watching + PlayStation badge I never picked"
  // fix): the main session IDENTIFIES with the first slot's platform when the
  // user EXPLICITLY picked a device (ps4/ps5/xbox/meta_quest — the session
  // class matches the badge the user asked for), and with the icon-less
  // 'embedded' console class for None/desktop/legacy slots. 'embedded' is
  // collision-safe (labels no real client emits) and renders NO device badge
  // on the card. The old unconditional 'ps4' anchor is GONE: an unselected
  // device must never appear on the profile's RPC cards. (Meta Quest slots
  // keep their legitimate meta_quest class+label; a desktop-class main card
  // would be wiped by the user's real desktop client — Task 91/105 — which
  // is exactly why None slots ride the embedded class instead.) When no slot
  // is active the class is irrelevant (no cards) and stays 'desktop'.
  // NOTE: the card's ACTIVITY-level label is decided per pushed card by
  // resolveRpcMainCardLabel (rpc-manager.ts) — explicit devices pass through,
  // None slots get 'embedded' (or 'samsung' while a Game RPC card is live so
  // the two main cards never share a merge key). The session class and the
  // card label may legitimately differ (a pattern Task 110 already shipped:
  // an xbox-labeled card on the anchored session).
  let rpcMainPlatform = 'desktop'
  if (firstSlotPlatform) {
    if (
      firstSlotPlatform === 'meta_quest' ||
      firstSlotPlatform === 'ps4' ||
      firstSlotPlatform === 'ps5' ||
      firstSlotPlatform === 'xbox'
    ) {
      // Explicit device — the user selected it; honor it end to end.
      rpcMainPlatform = firstSlotPlatform
    } else {
      // None / desktop / legacy value → icon-less embedded anchor.
      rpcMainPlatform = 'embedded'
    }
  }

  // ── GAME role main session: always the embedded console class ───────────
  // Labels no other role and no real client emits (Task 91 doctrine: the
  // activity-level label is the card merge key) — the game card can neither
  // merge with a slot card nor be wiped by the user's real desktop client.
  const gameMainPlatform = 'embedded'
  const gameMainLabel = 'embedded'

  void rpcEnabled // reserved: future slot-platform/badge arbitration
  return { statusSessionPlatform, rpcMainPlatform, gameMainPlatform, gameMainLabel }
}

/**
 * Which role owns the ACCOUNT-status REST self-heal (PATCH /users/@me/settings)
 * for a user right now. Deterministic from the DB — exactly one role patches,
 * so the three daemons can never fight over user_settings.status.
 */
export function accountStatusPatchOwner(input: {
  role: DaemonRole
  statusEnabled: boolean
  slotsActive: boolean
  gamesActive: boolean
}): boolean {
  const { role, statusEnabled, slotsActive, gamesActive } = input
  // 'all' keeps the pre-split unconditional behavior (it is the combined
  // daemon; during the transition window its values agree with the owners').
  if (role === 'all') return true
  const owner: 'status' | 'rpc' | 'game' = statusEnabled
    ? 'status'
    : slotsActive
      ? 'rpc'
      : gamesActive
        ? 'game'
        : 'status'
  return owner === role
}

/**
 * Role-staggered OAuth token-refresh thresholds (minutes before expiry).
 * Discord refresh tokens ROTATE on use — two daemons refreshing the same
 * session concurrently would invalidate one grant. After a refresh the
 * expiry jumps ~7 days out, so the status role (widest window) virtually
 * always refreshes first and the tighter windows never fire.
 */
export function tokenRefreshWindowMinutes(role: DaemonRole): number {
  switch (role) {
    case 'status': return 30
    case 'all': return 30
    case 'rpc': return 26
    case 'game': return 22
  }
}
