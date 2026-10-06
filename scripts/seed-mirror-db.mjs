import crypto from 'crypto'
import fs from 'fs'
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const rows = await db.discordAsset.findMany()
let n = 0
for (const r of rows) {
  if (!/^https?:\/\//.test(r.url)) continue
  let path
  try { path = new URL(r.url).pathname } catch { continue }
  const hash = crypto.createHash('sha1').update(path).digest('hex').slice(0, 16)
  for (const [ext, ct] of [['gif','image/gif'],['png','image/png'],['jpg','image/jpeg'],['jpeg','image/jpeg'],['webp','image/webp']]) {
    const f = `public/asset-mirror/${hash}.${ext}`
    if (fs.existsSync(f)) {
      const bytes = fs.readFileSync(f)
      const payload = new Uint8Array(bytes)
      await db.mirrorAsset.upsert({
        where: { hash },
        create: { hash, contentType: ct, bytes: payload, size: bytes.length },
        update: { contentType: ct, bytes: payload, size: bytes.length },
      })
      console.log(`seeded ${hash} (${ext}, ${bytes.length} bytes) from ${r.url.slice(30, 90)}`)
      n++
      break
    }
  }
}
console.log('total seeded:', n)
await db.$disconnect()
