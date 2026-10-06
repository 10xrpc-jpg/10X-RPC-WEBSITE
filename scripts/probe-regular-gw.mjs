// Probe: what does the REGULAR client gateway (gateway.discord.gg) show
// for the user's presence? This is the exact data real Discord clients
// use to render profile cards. Uses the user's OAuth access token.
import WebSocket from 'ws'
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()

const ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json')
let hb = null
ws.on('open', () => console.log('[regular-gw] connected'))
ws.on('error', (e) => console.error('[regular-gw] error', e.message))
ws.on('close', (code, reason) => { console.log(`[regular-gw] closed ${code} ${reason.toString()}`); process.exit(0) })
ws.on('message', async (raw) => {
  const p = JSON.parse(raw.toString())
  if (p.op === 10) {
    hb = setInterval(() => { try { ws.send(JSON.stringify({ op: 1, d: null })) } catch {} }, p.d.heartbeat_interval)
    const session = await db.session.findFirst({ where: { userId: 'cmuul9bp30001l404yzfhf5sj', discordAccessToken: { not: null } }, orderBy: { createdAt: 'desc' } })
    const token = session?.discordAccessToken
    if (!token) { console.log('no token'); process.exit(1) }
    ws.send(JSON.stringify({ op: 2, d: { token: `Bearer ${token}`, properties: { os: 'Windows', browser: 'Discord Client', device: 'Desktop' }, intents: 0 } }))
  } else if (p.op === 0 && p.t === 'READY') {
    console.log(`[regular-gw] READY! user=${p.d.user?.username}`)
    for (const s of p.d.sessions || []) {
      console.log(`— session ${s.session_id === 'all' ? 'AGGREGATE(all)' : s.session_id.slice(0, 16) + '..'} client=${s.client_info?.os}/${s.client_info?.client} status=${s.status}`)
      for (const a of s.activities || []) {
        if (a.type === 4) continue
        console.log(`   activity name="${a.name}" type=${a.type} platform=${a.platform} app_id=${a.application_id || 'MISSING'}`)
        console.log(`     assets=${JSON.stringify(a.assets)}`)
        console.log(`     full=${JSON.stringify(a).slice(0, 500)}`)
      }
      if ((s.activities || []).filter(a => a.type !== 4).length === 0) console.log('   (no rich activity)')
    }
    setTimeout(() => { try { ws.close() } catch {}; process.exit(0) }, 5000)
  } else if (p.op === 9) {
    console.log('[regular-gw] INVALID SESSION (op 9):', JSON.stringify(p.d))
    process.exit(1)
  } else if (p.t === 'PRESENCE_UPDATE') {
    console.log('[regular-gw] PRESENCE_UPDATE activities:', JSON.stringify(p.d.activities).slice(0, 800))
  }
})
setTimeout(() => process.exit(0), 25000)
