// 10X RPC — Platform and status constants

export interface PlatformOption {
  value: string
  label: string
  description: string
  group: string
  emoji: string
}

export const PLATFORMS: PlatformOption[] = [
  { value: 'console', label: 'Console', description: 'Console session (generic)', group: 'Console', emoji: '🎮' },
  { value: 'xbox', label: 'Xbox', description: 'Xbox integration badge', group: 'Console', emoji: '🎮' },
  { value: 'ps4', label: 'PlayStation 4', description: 'PS4 integration badge', group: 'Console', emoji: '🎮' },
  { value: 'ps5', label: 'PlayStation 5', description: 'PS5 integration badge', group: 'Console', emoji: '🎮' },
  { value: 'embedded', label: 'Embedded', description: 'Embedded session', group: 'VR & Embedded', emoji: '🥽' },
  { value: 'meta_quest', label: 'Meta Quest', description: 'Meta Quest VR session — shows VR headset icon', group: 'VR & Embedded', emoji: '🥽' },
]

export const PLATFORM_GROUPS = ['Console', 'VR & Embedded']

export interface ActivityType {
  value: number
  label: string
}

export const ACTIVITY_TYPES: ActivityType[] = [
  { value: 0, label: 'PLAYING' },
  { value: 1, label: 'STREAMING' },
  { value: 2, label: 'LISTENING' },
  { value: 3, label: 'WATCHING' },
  { value: 5, label: 'COMPETING' },
]

export interface DiscordStatus {
  value: string
  label: string
  color: string
  emoji: string
}

export const DISCORD_STATUSES: DiscordStatus[] = [
  { value: 'online', label: 'Online', color: 'bg-[#23A559]', emoji: '🟢' },
  { value: 'idle', label: 'Idle', color: 'bg-[#F0B232]', emoji: '🟡' },
  { value: 'dnd', label: 'Do Not Disturb', color: 'bg-[#F23F43]', emoji: '🔴' },
  { value: 'invisible', label: 'Invisible', color: 'bg-[#80848E]', emoji: '⚫' },
]

export function platformByValue(value: string) {
  return PLATFORMS.find(p => p.value === value)
}

// ── VR / Mobile badge ⇒ Online rule (the "VR/mobile status not showing" fix) ─
// Discord renders the platform badge (phone shape / VR headset) on a profile
// ONLY while the presence status is "online". With idle/dnd the profile shows
// just the moon / dash glyph and hides the badge entirely — so selecting
// Mobile or VR while Idle/Do Not Disturb looks like "the icon is not showing".
// Product rule: whenever a badge platform is active and the status is
// idle/dnd, the status is automatically switched to online so the selected
// icon always displays.
export const BADGE_PLATFORMS: ReadonlySet<string> = new Set([
  'mobile', 'android', 'ios', 'samsung', 'meta_quest',
])

/**
 * Enforce the badge⇒online rule. Returns the status that should actually be
 * stored / sent to Discord: when a badge platform (Mobile / VR) is active and
 * the requested status is idle or dnd, this returns 'online'.
 */
export function normalizeStatusForPlatform(
  platform: string | null | undefined,
  status: string | null | undefined,
  vrActive?: boolean
): string {
  const badge = vrActive === true || (!!platform && BADGE_PLATFORMS.has(platform))
  if (badge && (status === 'idle' || status === 'dnd')) return 'online'
  return status || 'online'
}

/**
 * STATUS-WINS resolution (the "Idle/DND must save VR/Mobile as None" rule).
 * Discord hides the Mobile/VR badge while the presence status is idle/dnd, so
 * when the user asserts Idle or Do Not Disturb, the badge platform is
 * automatically saved as None (desktop) and the chosen status is kept as-is.
 */
export function normalizePlatformForStatus(
  status: string | null | undefined,
  platform: string | null | undefined,
  vrActive?: boolean
): { platform: string; vrActive: boolean; changed: boolean } {
  const badge = vrActive === true || (!!platform && BADGE_PLATFORMS.has(platform))
  if (badge && (status === 'idle' || status === 'dnd')) {
    return { platform: 'desktop', vrActive: false, changed: true }
  }
  return { platform: platform || 'desktop', vrActive: vrActive === true, changed: false }
}

// Flat options for the "RPC DEVICE / PLATFORM" selector (reference design: None / PlayStation / Xbox / Meta Quest)
export const RPC_PLATFORM_OPTIONS: { value: string; label: string }[] = [
  { value: 'desktop', label: 'None' },
  { value: 'ps4', label: 'PlayStation' },
  { value: 'xbox', label: 'Xbox' },
  { value: 'meta_quest', label: 'Meta Quest' },
]

// Human-readable label for any stored platform value (incl. legacy: ps5, console, embedded)
export function rpcPlatformLabel(value?: string | null): string {
  switch (value) {
    case 'ps4':
    case 'ps5':
      return 'PlayStation'
    case 'xbox':
      return 'Xbox'
    case 'meta_quest':
      return 'Meta Quest'
    case 'console':
      return 'Console'
    case 'embedded':
      return 'Embedded'
    default:
      return 'None'
  }
}

export const PLATFORM_FALLBACK_NAMES: Record<string, string> = {
  meta_quest: 'Meta Quest',
  xbox: 'Xbox',
  ps4: 'PlayStation 4',
  ps5: 'PlayStation 5',
  console: 'Console',
  embedded: 'Embedded',
  mobile: 'Mobile',
  ios: 'iOS',
  android: 'Android',
  samsung: 'Samsung',
  web: 'Web',
  desktop: '10X RPC',
  none: '10X RPC',
}

/**
 * Get fallback activity name for a platform when NAME field is empty or contains no valid name.
 */
export function getPlatformFallbackName(platform?: string | null): string {
  if (!platform) return '10X RPC'
  const key = platform.toLowerCase().trim()
  if (PLATFORM_FALLBACK_NAMES[key]) {
    return PLATFORM_FALLBACK_NAMES[key]
  }
  const match = PLATFORMS.find(p => p.value.toLowerCase() === key)
  if (match) return match.label
  return '10X RPC'
}

/**
 * Resolve the visible Activity/Application name:
 * Always prioritize custom NAME. Only if NAME is empty or contains no valid name,
 * fallback to the platform name.
 */
export function resolveRpcActivityName(name?: string | null, platform?: string | null): string {
  const trimmed = name?.trim()
  if (trimmed && trimmed.length > 0) {
    return trimmed
  }
  return getPlatformFallbackName(platform)
}
