// Task 18 — fetchGameAppId helper test against the real DB
import { PrismaClient } from '@prisma/client'
import { fetchGameAppId } from '../src/lib/rpc-manager'

async function main() {
  const db = new PrismaClient()
  try {
    const u = await db.user.findFirst({ where: { discordId: 'demo-user-10x' } })
    const g = await db.gameConfig.findFirst({ where: { userId: u!.id, enabled: true } })
    if (!g) throw new Error('no enabled game row for demo user')
    const a = await fetchGameAppId(u!.id, g.gameSlug)
    const b = await fetchGameAppId(u!.id, 'minecraft')
    const c = await fetchGameAppId(u!.id, 'custom-nonexistent0000')
    const d = await fetchGameAppId(u!.id, null)
    console.log('helper:', JSON.stringify({ custom: a, preset: b, missing: c, nullSlug: d }))
    if (a !== '1402418714716143646' || b !== null || c !== null || d !== null) {
      throw new Error('HELPER TEST FAILED')
    }
    console.log('HELPER TESTS PASSED')
  } finally {
    await db.$disconnect()
  }
}
main().catch(e => { console.error(e.message); process.exit(1) })
