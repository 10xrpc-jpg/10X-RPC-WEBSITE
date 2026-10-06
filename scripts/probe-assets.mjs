import WebSocket from 'ws'
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const ws = new WebSocket('wss://gateway.gaming-sdk.com/?v=10&encoding=json')
let hb = null, done = false
ws.on('open', () => console.log('[probe] connected'))
ws.on('error', (e) => console.error('[probe] error', e.message))
ws.on('close', () => process.exit(0))
ws.on('message', async (raw) => {
  const p = JSON.parse(raw.toString())
  if (p.op === 10) {
    hb = setInterval(() => { try { ws.send(JSON.stringify({ op: 1, d: null })) } catch {} }, p.d.heartbeat_interval)
    const session = await db.session.findFirst({ where: { userId: 'cmuul9bp30001l404yzfhf5sj', discordAccessToken: { not: null } }, orderBy: { createdAt: 'desc' } })
    const token = session?.discordAccessToken
    if (!token) { console.log('no token'); process.exit(1) }
    ws.send(JSON.stringify({ op: 2, d: { token: `Bearer ${token}`, properties: { os: 'Windows', browser: 'Discord Client', device: 'Desktop' } } }))
  } else if (p.op === 0 && p.t === 'READY') {
    console.log(`\n[probe] READY. Dumping ALL sessions with FULL activity assets:\n`)
    for (const s of p.d.sessions || []) {
      console.log(`— session ${s.session_id === 'all' ? 'AGGREGATE(all)' : s.session_id.slice(0,16)+'..'} client=${s.client_info?.os}/${s.client_info?.client}`)
      for (const a of s.activities || []) {
        if (a.type === 4) continue
        console.log(`   activity name="${a.name}" platform=${a.platform} assets=${JSON.stringify(a.assets)} app_id=${a.application_id || 'MISSING'}`)
      }
      if ((s.activities || []).filter(a => a.type !== 4).length === 0) console.log('   (no rich activity)')
    }
    console.log('')
    if (!done) { done = true; setTimeout(() => { try { ws.close() } catch {} ; process.exit(0) }, 3000) }
  }
})
setTimeout(() => process.exit(0), 30000)
