import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const uid = 'cmuul9bp30001l404yzfhf5sj'
const cfgs = await db.rpcConfig.findMany({ where: { userId: uid }, orderBy: { updatedAt: 'desc' } })
console.log(`=== ALL RpcConfig rows: ${cfgs.length} ===`)
for (const c of cfgs) {
  console.log(`id=${c.id} name="${c.name}" enabled=${c.enabled} largeImage=${(c.largeImage||'null').slice(0,90)} created=${c.createdAt.toISOString()} updated=${c.updatedAt.toISOString()}`)
}
await db.$disconnect()
