import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const assets = await db.discordAsset.findMany({ take: 20 })
  console.log('=== DiscordAsset cache rows ===')
  for (const a of assets) console.log(`url: ${a.url.slice(0, 140)}\n  -> key: ${a.key}`)
  const cfgs = await db.rpcConfig.findMany({ take: 10 })
  console.log('\n=== RpcConfig rows ===')
  for (const c of cfgs) console.log(`user=${c.userId} enabled=${c.enabled}\n  largeImage=${c.largeImage}\n  smallImage=${c.smallImage}`)
  const sessions = await db.session.findMany({ take: 10, orderBy: { lastPresenceUpdate: 'desc' } })
  console.log('\n=== Sessions (recent presence) ===')
  for (const s of sessions) console.log(`user=${s.userId} rpcEnabled=${s.rpcEnabled} statusEnabled=${s.statusEnabled} gatewayReady=${s.gatewayReady} lastUpdate=${s.lastPresenceUpdate?.toISOString()}`)
}
main().finally(() => db.$disconnect())
