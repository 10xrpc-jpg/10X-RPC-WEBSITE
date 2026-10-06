import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()

const uid = 'cmuul9bp30001l404yzfhf5sj'
console.log('=== RpcConfig (all) ===')
const cfgs = await db.rpcConfig.findMany({ orderBy: { updatedAt: 'desc' }, take: 8 })
for (const c of cfgs) {
  console.log(`user=${c.userId} name="${c.name}" enabled=${c.enabled} largeImage=${(c.largeImage || 'null').slice(0, 110)} updated=${c.updatedAt.toISOString()}`)
}

console.log('\n=== DiscordAsset rows ===')
const das = await db.discordAsset.findMany({ orderBy: { createdAt: 'desc' } })
for (const d of das) {
  console.log(`url=${d.url.slice(0, 100)}\n   key=${d.key.slice(0, 140)} created=${d.createdAt.toISOString()}`)
}

console.log('\n=== MirrorAsset rows ===')
const mas = await db.mirrorAsset.findMany({ select: { hash: true, contentType: true, size: true } })
for (const m of mas) {
  console.log(`hash=${m.hash} ct=${m.contentType} size=${m.size} (${(m.size / 1048576).toFixed(2)}MB)`)
}

await db.$disconnect()
