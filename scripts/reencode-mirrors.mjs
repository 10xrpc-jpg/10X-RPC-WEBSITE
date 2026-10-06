// One-time maintenance: re-encode oversized MirrorAsset rows (>4MB) so the
// DB-backed mirror route (/api/asset-mirror/<hash>) can serve them on Vercel
// (serverless responses cap ~4.5MB). Before this fix, oversized GIFs fell back
// to the STATIC file URL which 404s on production → media proxy 404 → the RPC
// image never renders (the "GIF not showing" bug).
//
// Also purges stale DiscordAsset cache rows whose wire values reference the
// dead static paths, so every daemon re-resolves to the DB route on its next
// tick, and rewrites the local file mirror to the compressed copy.
//
// Run: DATABASE_URL=<neon> bun run scripts/reencode-mirrors.mjs
import { PrismaClient } from '@prisma/client'
import sharp from 'sharp'
import fs from 'fs'

const db = new PrismaClient()
const LIMIT = 4_000_000
const MIRROR_DIR = 'public/asset-mirror'
const MIME_EXT = { 'image/gif': 'gif', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

function sniff(buf) {
  if (buf.length < 12) return null
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57 && buf[9] === 0x45) return 'image/webp'
  return null
}

async function compress(bytes, contentType) {
  const animated = contentType.includes('gif') || contentType.includes('webp')
  const attempts = []
  if (animated) {
    for (const width of [512, 400, 320, 256]) {
      attempts.push({
        ct: 'image/gif',
        run: () => sharp(bytes, { animated: true, failOn: 'none' }).resize({ width, withoutEnlargement: true }).gif({ colours: width >= 400 ? 192 : 128, effort: 7 }).toBuffer(),
      })
    }
    for (const width of [400, 320, 256]) {
      attempts.push({
        ct: 'image/webp',
        run: () => sharp(bytes, { animated: true, failOn: 'none' }).resize({ width, withoutEnlargement: true }).webp({ quality: 70, effort: 4 }).toBuffer(),
      })
    }
  }
  for (const width of [1024, 768, 512]) {
    attempts.push({ ct: 'image/jpeg', run: () => sharp(bytes, { failOn: 'none' }).resize({ width, withoutEnlargement: true }).jpeg({ quality: 78, mozjpeg: true }).toBuffer() })
  }
  attempts.push({ ct: 'image/png', run: () => sharp(bytes, { failOn: 'none' }).resize({ width: 512, withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer() })

  for (const a of attempts) {
    try {
      const out = Buffer.from(await a.run())
      if (out.length > 0 && out.length <= LIMIT) {
        return { bytes: out, contentType: sniff(out) || a.ct }
      }
    } catch {
      // next strategy
    }
  }
  return null
}

const rows = await db.mirrorAsset.findMany({ where: { size: { gt: LIMIT } } })
console.log(`Oversized mirror rows: ${rows.length}`)
for (const row of rows) {
  const bytes = Buffer.from(row.bytes)
  console.log(`hash=${row.hash} ${row.contentType} ${(bytes.length / 1048576).toFixed(2)}MB`)
  const out = await compress(bytes, row.contentType)
  if (!out) {
    console.log('  ✗ could not compress below limit — leaving row unchanged')
    continue
  }
  const ext = MIME_EXT[out.contentType] || 'png'
  await db.mirrorAsset.update({
    where: { hash: row.hash },
    data: { bytes: new Uint8Array(out.bytes), contentType: out.contentType, size: out.bytes.length },
  })
  console.log(`  ✓ re-encoded → ${(out.bytes.length / 1048576).toFixed(2)}MB ${out.contentType}`)
  try {
    if (!fs.existsSync(MIRROR_DIR)) fs.mkdirSync(MIRROR_DIR, { recursive: true })
    fs.writeFileSync(`${MIRROR_DIR}/${row.hash}.${ext}`, out.bytes)
    for (const e of ['gif', 'png', 'jpg', 'jpeg', 'webp']) {
      if (e !== ext) fs.rmSync(`${MIRROR_DIR}/${row.hash}.${e}`, { force: true })
    }
  } catch (e) {
    console.log(`  (file mirror update skipped: ${e?.message || e})`)
  }
  const del = await db.discordAsset.deleteMany({ where: { key: { contains: `/asset-mirror/${row.hash}.` } } })
  console.log(`  ✓ purged ${del.count} stale static-path DiscordAsset cache row(s)`)
}
await db.$disconnect()
console.log('done')
