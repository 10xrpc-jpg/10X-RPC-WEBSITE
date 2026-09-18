// 10X RPC — /api/games/list — list all available game presets + user's saved configs
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

  const games = GAME_PRESETS.map(preset => {
    const saved = configsBySlug.get(preset.slug)
    return {
      slug: preset.slug,
      name: preset.name,
      largeImage: preset.largeImage,
      iconUrl: preset.iconUrl || '',
      defaultDetails: preset.defaultDetails || '',
      enabled: saved?.enabled ?? false,
      saved: !!saved,
    }
  })

  return NextResponse.json({ games })
}
