// Self-presence observer: identify a second gaming-SDK gateway session with the
// user's OAuth token and dump READY/sessions + any PRESENCE_UPDATE for self.
// This reveals what Discord actually accepted from the daemons' OP 3 sends.
import WebSocket from 'ws'
import { PrismaClient } from '@prisma/client'

const GATEWAY = process.argv[2] || 'wss://gateway.gaming-sdk.com/?v=10&encoding=json'
const LISTEN_MS = parseInt(process.argv[3] || '60000', 10)

const db = new PrismaClient()
const ws = new WebSocket(GATEWAY)
let heartbeat = null
let token = null
let mySessionId = null
let seen = 0

function dump(label, obj) {
  console.log(`\n===== ${label} =====`)
  console.log(JSON.stringify(obj, null, 1).slice(0, 4000))
}

ws.on('open', () => console.log(`[probe] connected ${GATEWAY}`))
ws.on('error', (e) => console.error('[probe] error', e.message))
ws.on('close', (c, r) => {
  console.log('[probe] closed', c, r.toString().slice(0, 120))
  process.exit(0)
})
ws.on('message', async (raw) => {
  let p
  try { p = JSON.parse(raw.toString()) } catch { return }
  if (p.op === 10) {
    heartbeat = setInterval(() => { try { ws.send(JSON.stringify({ op: 1, d: null })) } catch {} }, p.d.heartbeat_interval)
    if (!token) {
      const session = await db.session.findFirst({
        where: { userId: 'cmuul9bp30001l404yzfhf5sj', discordAccessToken: { not: null } },
        orderBy: { createdAt: 'desc' },
      })
      token = session?.discordAccessToken
      if (!token) { console.log('[probe] no token, exit'); process.exit(1) }
    }
    ws.send(JSON.stringify({
      op: 2,
      d: { token: token.startsWith('Bearer ') ? token : `Bearer ${token}`, properties: { os: 'Windows', browser: 'Discord Client', device: 'Desktop' } },
    }))
  } else if (p.op === 0 && p.t === 'READY') {
    mySessionId = p.d.session_id
    console.log(`\n[probe] READY session_id=${mySessionId} user=${p.d.user?.username}`)
    const sess = p.d.sessions || []
    console.log(`[probe] READY.sessions (${sess.length}):`)
    for (const s of sess) {
      console.log(`  - sid=${(s.session_id || '').slice(0, 18)}.. status=${s.status} client=${JSON.stringify(s.client_info || {})} activities=${JSON.stringify(s.activities || []).slice(0, 600)}`)
    }
    if (p.d.presences) dump('READY.presences', p.d.presences)
    if (p.d.user?.presences) dump('READY.user.presences', p.d.user.presences)
  } else if (p.op === 0 && p.t === 'SESSIONS_REPLACE') {
    console.log(`\n[probe] SESSIONS_REPLACE (${(p.d || []).length}):`)
    for (const s of p.d || []) {
      console.log(`  - sid=${(s.session_id || '').slice(0, 18)}.. status=${s.status} all=${JSON.stringify(s).slice(0, 700)}`)
    }
  } else if (p.op === 0 && p.t === 'PRESENCE_UPDATE') {
    seen++
    const a = p.d.activities || []
    console.log(`\n[probe] PRESENCE_UPDATE #${seen} sid=${(p.d.session_id || '').slice(0, 18)}.. status=${p.d.status} self=${p.d.user?.id === '1471913734497636403'}`)
    for (const act of a) console.log('  activity:', JSON.stringify(act).slice(0, 900))
  } else if (p.op === 9) {
    console.log('[probe] INVALID SESSION (op 9)', JSON.stringify(p.d))
    process.exit(2)
  }
})

setTimeout(() => { console.log(`\n[probe] listen window done (${seen} presence events)`); try { ws.close() } catch {}; process.exit(0) }, LISTEN_MS)
