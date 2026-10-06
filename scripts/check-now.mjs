import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const uid = 'cmuul9bp30001l404yzfhf5sj'
const cfg = await db.rpcConfig.findFirst({ where: { userId: uid }, orderBy: { updatedAt: 'desc' } })
console.log('=== RpcConfig ===')
console.log(JSON.stringify(cfg, (k,v) => k === 'id' || k === 'userId' ? undefined : v, 1))
const assets = await db.discordAsset.findMany({ orderBy: { createdAt: 'asc' } })
console.log('=== DiscordAsset cache rows ===')
for (const a of assets) console.log(`key=${a.key} url=${a.url.slice(0,120)}`)
const sessions = await db.session.findMany({ where: { userId: uid }, orderBy: { createdAt: 'desc' }, take: 5 })
console.log('=== Sessions (top 5) ===')
for (const s of sessions) console.log(`id=${s.id.slice(0,12)}.. created=${s.createdAt.toISOString()} expires=${s.expiresAt.toISOString()} rpc=${s.rpcEnabled} status=${s.statusEnabled} gw=${s.gatewayReady} custom="${s.customStatus}" hasToken=${!!s.discordAccessToken} tokenExp=${s.discordTokenExpiresAt?.toISOString()}`)
await db.$disconnect()
