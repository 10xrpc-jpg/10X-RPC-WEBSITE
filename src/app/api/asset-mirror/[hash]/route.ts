// 10X RPC — DB-backed asset mirror
//
// Serves mirrored copies of user-provided RPC images from the Neon database.
// This exists because public/asset-mirror/* STATIC files only reach production
// (Vercel) on a redeploy — any image the user sets between deploys resolved to
// a 404 mirror URL, which Discord's media proxy then failed to fetch (the
// "RPC image not showing" bug). DB-backed mirrors are live immediately.
//
// A hash maps 1:1 to the source URL's pathname; re-uploading a file under the
// same path overwrites the row (hash stays stable), so caching must be modest.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Vercel serverless responses are practically capped ~4.5MB; larger mirrors
// redirect to the best live source instead of failing.
const MAX_SERVE_BYTES = 4 * 1024 * 1024

export async function GET(_req: NextRequest, { params }: { params: Promise<{ hash: string }> }) {
  const raw = (await params).hash || ''

  // Discord's media proxy decides how to serve an image partly by URL EXTENSION:
  // a `.gif` URL is passed through ANIMATED, while an extension-less URL gets
  // converted to a static thumbnail — killing GIF animation in the RPC card.
  // The DB route therefore supports an optional format extension suffix.
  let hash = raw
  const m = /^([0-9a-f]{16})\.(?:gif|png|jpe?g|webp)$/i.exec(raw)
  if (m) hash = m[1]

  if (!/^[0-9a-f]{16}$/.test(hash)) {
    return NextResponse.json({ error: 'invalid hash' }, { status: 400 })
  }

  let row: { contentType: string; bytes: Uint8Array; size: number } | null = null
  try {
    const found = await db.mirrorAsset.findUnique({
      where: { hash },
      select: { contentType: true, bytes: true, size: true },
    })
    row = found
  } catch (err) {
    console.error('[AssetMirror] DB read failed:', err)
    return NextResponse.json({ error: 'mirror unavailable' }, { status: 503 })
  }

  if (!row) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const body = Buffer.from(row.bytes)
  if (body.length > MAX_SERVE_BYTES) {
    return NextResponse.json(
      { error: 'mirror too large to serve inline' },
      { status: 413 }
    )
  }

  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      'Content-Type': row.contentType || 'image/png',
      'Content-Length': String(body.length),
      // Hash content can be replaced under the same path — keep CDN cache short
      // but allow stale-while-revalidate so avatars stay warm.
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=86400',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
