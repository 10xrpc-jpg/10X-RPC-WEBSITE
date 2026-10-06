// One-time cleanup: remove catalog games that were retired (gtaiii, igtap,
// ragtag-heroes). Deletes every GameConfig row for those slugs; if a row was
// the user's ENABLED game (Gamer RPC active), the master rpcEnabled flag goes
// OFF for that user (mutual exclusivity: Normal RPC was already off). The
// daemon's 30s tick re-syncs and clears the presence automatically.
import { PrismaClient } from '@prisma/client'

const REMOVED = ['gtaiii', 'igtap', 'ragtag-heroes']

async function main() {
  const db = new PrismaClient()
  try {
    const rows = await db.gameConfig.findMany({
      where: { gameSlug: { in: REMOVED } },
    })
    console.log(`Found ${rows.length} GameConfig row(s) for removed games.`)

    const enabledUsers = rows.filter(r => r.enabled).map(r => r.userId)

    if (enabledUsers.length > 0) {
      const res = await db.session.updateMany({
        where: { userId: { in: enabledUsers }, rpcEnabled: true },
        data: { rpcEnabled: false, lastPresenceUpdate: new Date() },
      })
      console.log(`Master RPC turned OFF for ${res.count} session(s) of ${enabledUsers.length} user(s) whose enabled game was removed.`)
    }

    const del = await db.gameConfig.deleteMany({
      where: { gameSlug: { in: REMOVED } },
    })
    console.log(`Deleted ${del.count} GameConfig row(s).`)
  } finally {
    await db.$disconnect()
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
