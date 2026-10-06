import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const session = await db.session.findFirst({ where: { userId: 'cmuul9bp30001l404yzfhf5sj', discordAccessToken: { not: null } }, orderBy: { createdAt: 'desc' } })
const token = session?.discordAccessToken
if (!token) { console.log('no token'); process.exit(1) }
const url = process.argv[2] || 'https://10x-rpc.vercel.app/asset-mirror/46465df7ec3845e9.gif'
const res = await fetch('https://discord.com/api/v9/applications/1556458074594738376/external-assets', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ urls: [url] }),
})
console.log('status:', res.status)
const j = await res.json().catch(() => null)
console.log(JSON.stringify(j, null, 2)?.slice(0, 900))
process.exit(0)
