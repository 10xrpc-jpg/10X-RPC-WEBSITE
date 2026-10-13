// 10X RPC — /api/games/list — list all available game presets + user's saved configs
// Custom games (created via "Add Games", slug starts with "custom-") are appended
// after the presets and carry custom: true.
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { db } from '@/lib/db'
import { GAME_PRESETS } from '@/lib/games'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getSession()
  const userId = session?.userId

  const savedConfigs = userId
    ? await db.gameConfig.findMany({ where: { userId } })
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
    }))

  return NextResponse.json({ games: [...presetGames, ...customGames] })
}
