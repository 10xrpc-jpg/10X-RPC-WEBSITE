import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const presets = await db.rotatorPreset.findMany({ where: { user: { discordId: 'demo-user-10x' } }, orderBy: { order: 'asc' } })
for (const p of presets) console.log(JSON.stringify({ emoji: p.emoji, text: p.text, mins: p.durationMins, order: p.order }))
await db.$disconnect()
