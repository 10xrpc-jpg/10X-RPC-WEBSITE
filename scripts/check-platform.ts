import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const cfgs = await db.rpcConfig.findMany()
  for (const c of cfgs) console.log(`user=${c.userId} platform=${c.platform} type=${c.type} name=${c.name}`)
  const sessions = await db.session.findMany({ where: { userId: 'cmuul9bp30001l404yzfhf5sj' } })
  for (const s of sessions) console.log(`session=${s.id} statusPlatform=${s.statusPlatform} statusEnabled=${s.statusEnabled} customStatus=${JSON.stringify(s.customStatus)}`)
  const presets = await db.rotatorPreset.findMany({ where: { userId: 'cmuul9bp30001l404yzfhf5sj' } })
  for (const p of presets) console.log(`rotator: ${p.text} order=${p.order} enabled=${p.enabled}`)
  const gc = await db.globalConfig.findMany({ where: { userId: 'cmuul9bp30001l404yzfhf5sj' } })
  for (const g of gc) console.log(`globalConfig: rotatorEnabled=${g.rotatorEnabled} intervalMins=${g.rotatorIntervalMins}`)
}
main().finally(() => db.$disconnect())
