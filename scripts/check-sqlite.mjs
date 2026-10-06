import { PrismaClient } from '@prisma/client'
process.env.DATABASE_URL = 'file:/home/z/my-project/db/custom.db'
const db = new PrismaClient()
try {
  const cfgs = await db.rpcConfig.findMany()
  console.log(`=== SQLite RpcConfig rows: ${cfgs.length} ===`)
  for (const c of cfgs) console.log(`name="${c.name}" enabled=${c.enabled} largeImage=${(c.largeImage||'null').slice(0,100)} updated=${c.updatedAt?.toISOString()}`)
  const sessions = await db.session.findMany()
  console.log(`=== SQLite Sessions: ${sessions.length} ===`)
  for (const s of sessions) console.log(`rpc=${s.rpcEnabled} status=${s.statusEnabled} hasToken=${!!s.discordAccessToken} created=${s.createdAt?.toISOString()} expires=${s.expiresAt?.toISOString()}`)
} catch (e) { console.log('SQLite read error:', e.message.slice(0,300)) }
await db.$disconnect()
