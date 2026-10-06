// Task 10 diagnostic — verify emoji save persisted and RPC state untouched
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const s = await db.session.findFirst({ where: { user: { discordId: 'demo-user-10x' } } })
console.log('customStatusEmoji:', JSON.stringify(s?.customStatusEmoji))
console.log('customStatus:', JSON.stringify(s?.customStatus))
console.log('statusEnabled:', s?.statusEnabled, '| rpcEnabled:', s?.rpcEnabled, '| gatewayReady:', s?.gatewayReady)
const cfg = await db.rpcConfig.findFirst({ where: { user: { discordId: 'demo-user-10x' } } })
console.log('rpcConfig.enabled:', cfg?.enabled, '| button1:', cfg?.button1Label, '| largeImage:', cfg?.largeImage)
await db.$disconnect()
