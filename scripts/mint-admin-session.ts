// Mint a local admin session (testing only) — creates/finds the admin user
// and inserts a valid Session row, printing the token for /set-session.
// Usage: bun scripts/mint-admin-session.ts
import { readFileSync } from 'fs'
import crypto from 'crypto'

// Force-override shell DATABASE_URL pollution from .env.local
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2]
}

const { PrismaClient } = await import('@prisma/client')
const db = new PrismaClient()

const SECRET = process.env.SESSION_SECRET
if (!SECRET) throw new Error('SESSION_SECRET missing')

function sign(payload: string): string {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')
}

async function main() {
  const discordId = process.env.ADMIN_DISCORD_IDS!.split(',')[0].trim()
  let user = await db.user.findUnique({ where: { discordId } })
  if (!user) {
    user = await db.user.create({
      data: { discordId, username: 'deveIoper', discriminator: '0', avatar: null },
    })
    console.log('created user', user.id)
  }
  const raw = `${user.id}.${Date.now()}.${crypto.randomBytes(16).toString('hex')}`
  const token = `${raw}.${sign(raw)}`
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  await db.session.create({ data: { userId: user.id, token, expiresAt } })
  console.log('TOKEN=' + token)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
