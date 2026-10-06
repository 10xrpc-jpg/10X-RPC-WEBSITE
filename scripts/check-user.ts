import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const users = await db.user.findMany()
  for (const u of users) console.log(`id=${u.id} discordId=${u.discordId} username=${u.username}`)
  const sessions = await db.session.findMany({ where: { userId: 'cmuul9bp30001l404yzfhf5sj' } })
  for (const s of sessions) console.log(`session=${s.id} created=${s.createdAt.toISOString()} expires=${s.expiresAt.toISOString()} tokenTail=${s.token.slice(-6)} statusEnabled=${s.statusEnabled} rpcEnabled=${s.rpcEnabled}`)
}
main().finally(() => db.$disconnect())
