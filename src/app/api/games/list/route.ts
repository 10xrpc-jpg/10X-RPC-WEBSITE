// 10X RPC — /api/games/list — list all available game presets + user's saved configs
// Custom games (created via "Add Games", slug starts with "custom-") are appended
// after the presets and carry custom: true.
//
// SELF-HEAL: before listing, duplicate game rows are merged (a historical bug
// let the same game exist twice — e.g. "Counter-Strike 2" as the catalog preset
// AND as a custom row added by its official Application ID). The merge is
// idempotent and only writes when a duplicate actually exists — see
// dedupeUserGames() in lib/game-rotate-settings.ts.
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { GAME_PRESETS } from '@/lib/games'
import { dedupeUserGames } from '@/lib/game-rotate-settings'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getSession()
  const userId = session?.userId

  if (userId) {
    // Merge same-name duplicates (enabled flag + rotation pool/head pointers
    // move to the keeper row). Cheap no-op when there are none.
    await dedupeUserGames(userId).catch(() => {})
  }

  const savedConfigs = userId
    ? await db.gameConfig.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })
    : []

  const configsBySlug = new Map(savedConfigs.map(c => [c.gameSlug, c]))

  const presetGames = GAME_PRESETS.map(preset => {
    const saved = configsBySlug.get(preset.slug)
    return {
      slug: preset.slug,
      name: preset.name,
      largeImage: preset.largeImage,
      iconUrl: preset.iconUrl || '',
      defaultDetails: preset.defaultDetails || '',
      enabled: saved?.enabled ?? false,
      saved: !!saved,
      custom: false,
      /** Row creation time (ms) — the rotation pool orders by it; presets
       *  without a row sort last in the UI preview. */
      createdAtMs: saved ? new Date(saved.createdAt).getTime() : null,
    }
  })

  // Custom games: saved rows whose slug is NOT a preset slug. The row itself is
  // both the catalog entry and the config (name/details/icon live on the row).
  const customGames = savedConfigs
    .filter(c => !GAME_PRESETS.some(p => p.slug === c.gameSlug))
    .map(c => ({
      slug: c.gameSlug,
      name: c.gameName,
      largeImage: c.largeImage || '',
      iconUrl: c.largeImage && /^https?:\/\//i.test(c.largeImage) ? c.largeImage : '',
      defaultDetails: c.details || 'Custom Game',
      enabled: c.enabled,
      saved: true,
      custom: true,
      appId: c.appId || null as string | null,
      createdAtMs: new Date(c.createdAt).getTime(),
    }))

  return NextResponse.json({ games: [...presetGames, ...customGames] })
}
