// 10X RPC — /api/asset-image/[key] — GET
//
// Resolves a Discord application asset reference into a VIEWABLE image by
// redirecting to Discord's app-assets CDN
// (https://cdn.discordapp.com/app-assets/<appId>/<assetId>.<ext>).
//
// Accepted inputs:
//   • asset key   e.g. "img-c55d38e101", "vscode", "gtav"
//   • asset ID    e.g. "1556496377242984529" (the wire format presences use)
//
// The web preview cannot render bare keys/IDs — Discord only accepts them
// inside gateway presence payloads. This endpoint lets the UI display the real
// uploaded image (animated GIFs included) instead of a letter fallback.
//
// The application asset list is fetched with the bot token and cached for 5
// minutes; responses are 302 redirects so the browser/CDN does the fetching.

import { NextResponse } from 'next/server'
import { CONFIG } from '@/lib/config'

export const dynamic = 'force-dynamic'

const API = 'https://discord.com/api/v9'
const ASSET_LIST_TTL_MS = 5 * 60 * 1000

interface AppAsset {
  key: string
  asset_id: string
  asset_type?: number
  metadata?: { content_type?: string; is_animated?: boolean }
}

let assetListCache: { at: number; assets: AppAsset[] } | null = null

async function getAppAssets(): Promise<AppAsset[]> {
  if (assetListCache && Date.now() - assetListCache.at < ASSET_LIST_TTL_MS) {
    return assetListCache.assets
  }
  const res = await fetch(`${API}/applications/${CONFIG.discord.clientId}/assets`, {
    headers: { Authorization: `Bot ${CONFIG.discord.botToken}` },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`asset_list_${res.status}`)
  const assets = (await res.json()) as AppAsset[]
  assetListCache = { at: Date.now(), assets }
  return assets
}

export async function GET(_req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params

  if (!key || !/^[a-z0-9_-]{1,64}$/i.test(key)) {
    return NextResponse.json({ error: 'invalid_key' }, { status: 400 })
  }

  try {
    const assets = await getAppAssets()
    const asset = assets.find(a => a.key === key.toLowerCase() || a.asset_id === key)
    if (!asset || !asset.asset_id) {
      return NextResponse.json({ error: 'asset_not_found' }, { status: 404 })
    }
    const isGif = asset.metadata?.content_type === 'image/gif' || asset.metadata?.is_animated === true
    const ext = isGif ? 'gif' : 'png'
    const cdnUrl = `https://cdn.discordapp.com/app-assets/${CONFIG.discord.clientId}/${asset.asset_id}.${ext}`
    return NextResponse.redirect(cdnUrl, 302)
  } catch (err) {
    console.error('[AssetImage] lookup failed:', err)
    return NextResponse.json({ error: 'lookup_failed' }, { status: 502 })
  }
}
