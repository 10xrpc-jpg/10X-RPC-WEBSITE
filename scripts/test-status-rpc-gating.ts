// Supplemental Verification: Runtime daemon gating matrix for
// "Enable Status" vs "Enable RPC" independence.
// Injects a fake gateway socket into the REAL RpcDaemon and captures the exact
// OP 3 payloads the daemon would push to Discord for every combination, plus
// asserts the daemon never mutates the DB enable flags of either feature.
import { db } from '../src/lib/db'
import { RpcDaemon } from '../src/lib/rpc-daemon'

const WS_OPEN = 1 // ws.WebSocket.OPEN

function makeCapturingSocket(capture: { payload: any }) {
  return {
    userId: '',
    sessionId: '',
    ws: {
      readyState: WS_OPEN,
      send: (data: string) => { capture.payload = JSON.parse(data) },
      close: () => {},
    } as any,
    heartbeatAck: true,
    retryCount: 0,
    platform: 'desktop',
    lastStatus: '',
    lastActivitiesHash: '',
    connected: true,
    isConnecting: false,
  }
}

async function runTests() {
  console.log('🧪 Daemon Gating Independence Test Suite (real RpcDaemon, stubbed socket)\n')
  const daemon = new RpcDaemon()
  const capture: { payload: any } = { payload: null }
  const asAny = daemon as any

  const testDiscordId = 'test-gating-' + Date.now()
  const testUser = await db.user.create({
    data: {
      discordId: testDiscordId,
      username: 'GatingTester',
      sessions: {
        create: {
          token: 'token-' + testDiscordId,
          expiresAt: new Date(Date.now() + 86400000),
          discordAccessToken: 'fake-token',
          statusEnabled: false,
          rpcEnabled: false,
          userStatus: 'online',
        },
      },
      rpcConfigs: {
        create: {
          name: 'Super Game 2026',
          type: 'PLAYING',
          state: 'Gating test',
          enabled: false,
        },
      },
      trial: {
        create: { endsAt: new Date(Date.now() + 86400000 * 3), active: true },
      },
    },
    include: { sessions: true, rpcConfigs: true },
  })

  const sessionId = testUser.sessions[0].id
  const rpcConfigId = testUser.rpcConfigs[0].id

  const setFlags = async (statusEnabled: boolean, rpcEnabled: boolean) => {
    await db.session.update({ where: { id: sessionId }, data: { statusEnabled, rpcEnabled } })
    await db.rpcConfig.update({ where: { id: rpcConfigId }, data: { enabled: rpcEnabled } })
  }

  const freshSession = async () => (await db.session.findUnique({ where: { id: sessionId } }))!
  const assertFlagsUnchanged = async (statusEnabled: boolean, rpcEnabled: boolean, label: string) => {
    const s = await freshSession()
    const rc = await db.rpcConfig.findUnique({ where: { id: rpcConfigId } })
    if (s.statusEnabled !== statusEnabled) throw new Error(`${label}: statusEnabled mutated to ${s.statusEnabled}`)
    if (s.rpcEnabled !== rpcEnabled) throw new Error(`${label}: rpcEnabled mutated to ${s.rpcEnabled}`)
    if (rc!.enabled !== rpcEnabled) throw new Error(`${label}: rpcConfig.enabled mutated to ${rc!.enabled}`)
  }

  try {
    // -------------------------------------------------------------
    // Combo 1: [Status OFF, RPC OFF] via daemon.syncUser
    // -------------------------------------------------------------
    console.log('Combo 1: [Status OFF, RPC OFF]')
    await setFlags(false, false)
    const sock1 = makeCapturingSocket(capture)
    sock1.userId = testUser.id; sock1.sessionId = sessionId
    asAny.sockets.set(testUser.id, sock1)
    const r1 = await daemon.syncUser(testUser.id)
    if (!r1.ok) throw new Error(`Combo 1 failed: syncUser returned ${JSON.stringify(r1)}`)
    if (asAny.sockets.has(testUser.id)) throw new Error('Combo 1 failed: socket should be removed when both features are OFF')
    if (capture.payload?.d?.activities?.length !== 0) throw new Error(`Combo 1 failed: expected 0 activities, payload: ${JSON.stringify(capture.payload)}`)
    if (capture.payload?.d?.status !== 'invisible') throw new Error(`Combo 1 failed: expected status invisible, got ${capture.payload?.d?.status}`)
    console.log('  ✓ Verified: nothing pushed, socket torn down, user goes invisible.\n')

    // -------------------------------------------------------------
    // Combo 2: [Status ON, RPC OFF] via daemon.syncUser
    // -------------------------------------------------------------
    console.log('Combo 2: [Status ON, RPC OFF]')
    await setFlags(true, false)
    await db.session.update({ where: { id: sessionId }, data: { userStatus: 'dnd' } })
    const sock2 = makeCapturingSocket(capture)
    sock2.userId = testUser.id; sock2.sessionId = sessionId
    asAny.sockets.set(testUser.id, sock2)
    const r2 = await daemon.syncUser(testUser.id)
    if (!r2.ok) throw new Error(`Combo 2 failed: syncUser returned ${JSON.stringify(r2)}`)
    if (!asAny.sockets.has(testUser.id)) throw new Error('Combo 2 failed: socket must stay connected for status-only mode')
    if (capture.payload?.d?.status !== 'dnd') throw new Error(`Combo 2 failed: expected status dnd, got ${capture.payload?.d?.status}`)
    if (capture.payload?.d?.activities?.length !== 0) throw new Error(`Combo 2 failed: RPC must be inactive (0 activities), got: ${JSON.stringify(capture.payload?.d?.activities)}`)
    await assertFlagsUnchanged(true, false, 'Combo 2')

    // -------------------------------------------------------------
    // Combo 3: [Status ON, RPC ON] via daemon.pushPresenceForUser
    // -------------------------------------------------------------
    console.log('Combo 3: [Status ON, RPC ON]')
    await setFlags(true, true)
    await db.session.update({ where: { id: sessionId }, data: { userStatus: 'online' } })
    capture.payload = null
    await asAny.pushPresenceForUser(testUser.id, await freshSession(), true)
    if (capture.payload?.d?.status !== 'online') throw new Error(`Combo 3 failed: expected status online, got ${capture.payload?.d?.status}`)
    if (capture.payload?.d?.activities?.length !== 1) throw new Error(`Combo 3 failed: expected 1 activity, got ${JSON.stringify(capture.payload?.d?.activities)}`)
    if (capture.payload?.d?.activities?.[0]?.name !== 'Super Game 2026') throw new Error('Combo 3 failed: wrong activity name')
    await assertFlagsUnchanged(true, true, 'Combo 3')
    console.log('  ✓ Verified: RPC activity live alongside online status.\n')

    // -------------------------------------------------------------
    // Combo 4: [Status OFF, RPC ON] via daemon.pushPresenceForUser
    // -------------------------------------------------------------
    console.log('Combo 4: [Status OFF, RPC ON]')
    await setFlags(false, true)
    capture.payload = null
    await asAny.pushPresenceForUser(testUser.id, await freshSession(), true)
    if (capture.payload?.d?.activities?.length !== 1) throw new Error(`Combo 4 failed: RPC must keep running (1 activity), got ${JSON.stringify(capture.payload?.d?.activities)}`)
    if (capture.payload?.d?.activities?.[0]?.name !== 'Super Game 2026') throw new Error('Combo 4 failed: wrong activity name')
    await assertFlagsUnchanged(false, true, 'Combo 4')
    console.log('  ✓ Verified: RPC keeps running with status OFF (DB statusEnabled stays false).\n')

    // -------------------------------------------------------------
    // Combo 5: Stop RPC while Status ON — status must survive (daemon.stopUserRpc)
    // -------------------------------------------------------------
    console.log('Combo 5: [Stop RPC while Status ON]')
    await setFlags(true, true)
    capture.payload = null
    await daemon.stopUserRpc(testUser.id)
    if (capture.payload?.d?.status !== 'online') throw new Error(`Combo 5 failed: status must stay online, got ${capture.payload?.d?.status}`)
    if (capture.payload?.d?.activities?.length !== 0) throw new Error(`Combo 5 failed: activities must be cleared, got ${JSON.stringify(capture.payload?.d?.activities)}`)
    if (!asAny.sockets.has(testUser.id)) throw new Error('Combo 5 failed: socket must stay for status')
    await assertFlagsUnchanged(true, true, 'Combo 5 (pre-disable flags)')
    console.log('  ✓ Verified: disabling RPC clears activities but keeps user online (status untouched).\n')

    // -------------------------------------------------------------
    // Stress: alternating daemon pushes never cross-trigger flags
    // -------------------------------------------------------------
    console.log('Stress: alternating daemon presence pushes')
    for (let i = 0; i < 4; i++) {
      const statusOn = i % 2 === 0
      await setFlags(statusOn, true)
      await asAny.pushPresenceForUser(testUser.id, await freshSession(), true)
      await assertFlagsUnchanged(statusOn, true, `Stress push ${i}`)
    }
    console.log('  ✓ Verified: repeated daemon pushes never alter either enable flag.\n')

    console.log('🎉 ALL DAEMON GATING TESTS PASSED — Status & RPC are fully independent at runtime.')
  } finally {
    asAny.sockets.clear()
    daemon.stop()
    await db.user.delete({ where: { id: testUser.id } }).catch(() => {})
  }
}

runTests().catch(err => {
  console.error('❌ Daemon gating test suite failed:', err)
  process.exit(1)
})
