// Automated Test Suite: Complete Separation of STATUS and RPC
// Covers all 7 required test cases from the prompt with real DB & Daemon simulation.
import { db } from '../src/lib/db'
import { RpcDaemon } from '../src/lib/rpc-daemon'
import { buildPresenceActivities } from '../src/lib/rpc-manager'

const WS_OPEN = 1

function createCapturingSocket(capture: { payloads: any[] }) {
  return {
    userId: '',
    sessionId: '',
    ws: {
      readyState: WS_OPEN,
      send: (data: string) => {
        capture.payloads.push(JSON.parse(data))
      },
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

function attachSocket(daemon: any, userId: string, sessionId: string, capture: { payloads: any[] }) {
  const sock = createCapturingSocket(capture)
  sock.userId = userId
  sock.sessionId = sessionId
  sock.connected = true
  sock.isConnecting = false
  daemon.sockets.set(userId, sock)
  return sock
}

async function runSeparationTests() {
  console.log('🧪 Running Complete STATUS vs RPC Independence Test Suite...\n')

  const testDiscordId = 'test-sep-' + Date.now()
  const testUser = await db.user.create({
    data: {
      discordId: testDiscordId,
      username: 'SeparationTester',
      sessions: {
        create: {
          token: 'token-' + testDiscordId,
          expiresAt: new Date(Date.now() + 86400000),
          discordAccessToken: 'test-oauth-token',
          statusEnabled: false,
          rpcEnabled: false,
          userStatus: 'online',
          customStatus: null,
          customStatusEmoji: null,
          statusPlatform: 'mobile',
          vrStatusActive: false,
        },
      },
      rpcConfigs: {
        create: {
          name: '10X Awesome Game',
          type: 'PLAYING',
          state: 'In Lobby',
          details: 'Playing solo',
          platform: 'desktop',
          enabled: false,
          startMinsAgo: 5,
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

  const daemon = new RpcDaemon()
  const capture: { payloads: any[] } = { payloads: [] }
  const asAny = daemon as any

  attachSocket(asAny, testUser.id, sessionId, capture)

  try {
    // -------------------------------------------------------------
    // TEST 1: Status = ON, RPC = OFF -> Click Status UPDATE
    // Expected: Status works, RPC stays OFF.
    // -------------------------------------------------------------
    console.log('--- TEST 1: Status = ON, RPC = OFF -> Click Status UPDATE ---')
    await db.session.update({
      where: { id: sessionId },
      data: { statusEnabled: true, rpcEnabled: false, userStatus: 'online', customStatus: 'Chilling', customStatusEmoji: '😎' },
    })
    await db.rpcConfig.update({
      where: { id: rpcConfigId },
      data: { enabled: false },
    })

    // Simulate Status UPDATE button logic (save ONLY status fields & sync daemon)
    await db.session.updateMany({
      where: { userId: testUser.id },
      data: {
        customStatus: 'Chilling Hard',
        customStatusEmoji: '🔥',
        lastPresenceUpdate: new Date(),
      },
    })
    capture.payloads = []
    await daemon.syncUser(testUser.id)

    // Verify DB
    let s = (await db.session.findUnique({ where: { id: sessionId } }))!
    let rc = (await db.rpcConfig.findUnique({ where: { id: rpcConfigId } }))!
    if (s.statusEnabled !== true) throw new Error('TEST 1 Failed: statusEnabled should be true')
    if (s.rpcEnabled !== false) throw new Error('TEST 1 Failed: rpcEnabled was turned on!')
    if (rc.enabled !== false) throw new Error('TEST 1 Failed: rpcConfig.enabled was turned on!')

    // Verify OP 3 payload: only status + custom status, NO RPC activity
    const lastOp1 = capture.payloads[capture.payloads.length - 1]
    if (!lastOp1 || lastOp1.op !== 3) throw new Error('TEST 1 Failed: Expected OP 3 payload')
    if (lastOp1.d.status !== 'online') throw new Error(`TEST 1 Failed: Expected status online, got ${lastOp1.d.status}`)
    const rpcActivities1 = (lastOp1.d.activities || []).filter((a: any) => a.type !== 4)
    if (rpcActivities1.length !== 0) throw new Error(`TEST 1 Failed: RPC activities sent while RPC is OFF! ${JSON.stringify(rpcActivities1)}`)
    const customStatus1 = (lastOp1.d.activities || []).find((a: any) => a.type === 4)
    if (!customStatus1 || customStatus1.state !== 'Chilling Hard') throw new Error('TEST 1 Failed: Custom status not applied')
    console.log('  ✓ Verified: Status is ON and active. RPC remains completely OFF (0 RPC activities).\n')

    // -------------------------------------------------------------
    // TEST 2: Status = ON, RPC = OFF -> Change Online -> Idle -> Click Status UPDATE
    // Expected: Status changes to Idle, RPC stays OFF.
    // -------------------------------------------------------------
    console.log('--- TEST 2: Status = ON, RPC = OFF -> Change Online -> Idle -> Status UPDATE ---')
    // Simulate changing Online -> Idle and clicking Status UPDATE
    await db.session.updateMany({
      where: { userId: testUser.id },
      data: {
        userStatus: 'idle',
        lastPresenceUpdate: new Date(),
      },
    })
    capture.payloads = []
    await daemon.syncUser(testUser.id)

    s = (await db.session.findUnique({ where: { id: sessionId } }))!
    rc = (await db.rpcConfig.findUnique({ where: { id: rpcConfigId } }))!
    if (s.userStatus !== 'idle') throw new Error(`TEST 2 Failed: userStatus should be idle, got ${s.userStatus}`)
    if (s.rpcEnabled !== false || rc.enabled !== false) throw new Error('TEST 2 Failed: RPC was enabled by status change!')

    const lastOp2 = capture.payloads[capture.payloads.length - 1]
    if (lastOp2.d.status !== 'idle') throw new Error(`TEST 2 Failed: Expected status idle, got ${lastOp2.d.status}`)
    const rpcActivities2 = (lastOp2.d.activities || []).filter((a: any) => a.type !== 4)
    if (rpcActivities2.length !== 0) throw new Error('TEST 2 Failed: RPC activities sent!')
    console.log('  ✓ Verified: Status changed to Idle on Discord. RPC remains completely OFF.\n')

    // -------------------------------------------------------------
    // TEST 3: Status = ON, RPC = OFF -> Change VR / icons / status fields -> Status UPDATE
    // Expected: Only Status changes, RPC stays OFF.
    // -------------------------------------------------------------
    console.log('--- TEST 3: Status = ON, RPC = OFF -> Change VR/icons/status -> Status UPDATE ---')
    await db.session.updateMany({
      where: { userId: testUser.id },
      data: {
        customStatus: 'In Meta Quest',
        customStatusEmoji: '🥽',
        statusPlatform: 'meta_quest',
        vrStatusActive: true,
        userStatus: 'dnd',
        lastPresenceUpdate: new Date(),
      },
    })
    capture.payloads = []
    await daemon.syncUser(testUser.id)

    s = (await db.session.findUnique({ where: { id: sessionId } }))!
    rc = (await db.rpcConfig.findUnique({ where: { id: rpcConfigId } }))!
    if (s.statusPlatform !== 'meta_quest') throw new Error('TEST 3 Failed: statusPlatform not updated')
    if (s.vrStatusActive !== true) throw new Error('TEST 3 Failed: vrStatusActive not updated')
    if (s.rpcEnabled !== false || rc.enabled !== false) throw new Error('TEST 3 Failed: RPC was enabled by VR status change!')

    const lastOp3 = capture.payloads[capture.payloads.length - 1]
    if (lastOp3.d.status !== 'dnd') throw new Error(`TEST 3 Failed: Expected status dnd, got ${lastOp3.d.status}`)
    const rpcActivities3 = (lastOp3.d.activities || []).filter((a: any) => a.type !== 4)
    if (rpcActivities3.length !== 0) throw new Error('TEST 3 Failed: RPC activities sent!')
    console.log('  ✓ Verified: VR/icon/status fields updated. RPC remains completely OFF.\n')

    // -------------------------------------------------------------
    // TEST 4: Status = OFF, RPC = OFF -> Click Status UPDATE
    // Expected: Nothing related to RPC happens.
    // -------------------------------------------------------------
    console.log('--- TEST 4: Status = OFF, RPC = OFF -> Click Status UPDATE ---')
    await db.session.update({
      where: { id: sessionId },
      data: { statusEnabled: false, rpcEnabled: false },
    })
    await db.rpcConfig.update({
      where: { id: rpcConfigId },
      data: { enabled: false },
    })

    // Simulate Status UPDATE while Status = OFF
    await db.session.updateMany({
      where: { userId: testUser.id },
      data: {
        customStatus: 'Saved but offline',
        lastPresenceUpdate: new Date(),
      },
    })
    capture.payloads = []
    await daemon.syncUser(testUser.id)

    s = (await db.session.findUnique({ where: { id: sessionId } }))!
    rc = (await db.rpcConfig.findUnique({ where: { id: rpcConfigId } }))!
    if (s.statusEnabled !== false) throw new Error('TEST 4 Failed: statusEnabled should remain false')
    if (s.rpcEnabled !== false || rc.enabled !== false) throw new Error('TEST 4 Failed: RPC was enabled!')

    const lastOp4 = capture.payloads[capture.payloads.length - 1]
    // Socket was cleaned up or user is invisible with 0 activities
    const rpcActivities4 = (lastOp4?.d?.activities || []).filter((a: any) => a.type !== 4)
    if (rpcActivities4.length !== 0) throw new Error('TEST 4 Failed: RPC activity found!')
    console.log('  ✓ Verified: Both remain OFF. No RPC activity triggered.\n')

    // -------------------------------------------------------------
    // TEST 5: Status = OFF, RPC = ON -> Click RPC UPDATE
    // Expected: RPC works, Status remains OFF.
    // -------------------------------------------------------------
    console.log('--- TEST 5: Status = OFF, RPC = ON -> Click RPC UPDATE ---')
    await db.session.update({
      where: { id: sessionId },
      data: { statusEnabled: false, rpcEnabled: true },
    })
    await db.rpcConfig.update({
      where: { id: rpcConfigId },
      data: {
        enabled: true,
        name: 'Super Cyberpunk 2077',
        state: 'Exploring Night City',
        details: 'Mission: The Heist',
      },
    })

    // Re-attach socket for test
    attachSocket(asAny, testUser.id, sessionId, capture)
    capture.payloads = []
    await daemon.syncUser(testUser.id)

    s = (await db.session.findUnique({ where: { id: sessionId } }))!
    rc = (await db.rpcConfig.findUnique({ where: { id: rpcConfigId } }))!
    if (s.statusEnabled !== false) throw new Error('TEST 5 Failed: statusEnabled was enabled!')
    if (s.rpcEnabled !== true || rc.enabled !== true) throw new Error('TEST 5 Failed: RPC not enabled')

    const lastOp5 = capture.payloads[capture.payloads.length - 1]
    const customActivities5 = (lastOp5?.d?.activities || []).filter((a: any) => a.type === 4)
    if (customActivities5.length !== 0) throw new Error('TEST 5 Failed: Custom status sent while Status is OFF!')
    const rpcActivities5 = (lastOp5?.d?.activities || []).filter((a: any) => a.type !== 4)
    if (rpcActivities5.length !== 1) throw new Error(`TEST 5 Failed: Expected 1 RPC activity, got ${rpcActivities5.length}`)
    if (rpcActivities5[0].name !== 'Super Cyberpunk 2077') throw new Error('TEST 5 Failed: Wrong RPC activity name')
    console.log('  ✓ Verified: RPC works and is live. Status remains strictly OFF (0 custom status activities).\n')

    // -------------------------------------------------------------
    // TEST 6: Status = ON, RPC = ON -> Click Status UPDATE
    // Expected: Only Status is updated. RPC does NOT restart, reset, change, or receive new config.
    // -------------------------------------------------------------
    console.log('--- TEST 6: Status = ON, RPC = ON -> Click Status UPDATE ---')
    await db.session.update({
      where: { id: sessionId },
      data: { statusEnabled: true, userStatus: 'online', customStatus: 'Working on code' },
    })

    const rpcBefore = (await db.rpcConfig.findUnique({ where: { id: rpcConfigId } }))!
    const rpcUpdatedBefore = rpcBefore.updatedAt.getTime()

    // Click Status UPDATE
    await db.session.updateMany({
      where: { userId: testUser.id },
      data: {
        customStatus: 'Deep in code',
        userStatus: 'dnd',
        lastPresenceUpdate: new Date(),
      },
    })
    capture.payloads = []
    await daemon.syncUser(testUser.id)

    const rpcAfter = (await db.rpcConfig.findUnique({ where: { id: rpcConfigId } }))!
    if (rpcAfter.updatedAt.getTime() !== rpcUpdatedBefore) {
      throw new Error('TEST 6 Failed: rpcConfig was modified or updated when clicking Status UPDATE!')
    }
    if (rpcAfter.name !== rpcBefore.name || rpcAfter.state !== rpcBefore.state) {
      throw new Error('TEST 6 Failed: rpcConfig data changed!')
    }

    const lastOp6 = capture.payloads[capture.payloads.length - 1]
    if (lastOp6.d.status !== 'dnd') throw new Error(`TEST 6 Failed: Expected status dnd, got ${lastOp6.d.status}`)
    const customStatus6 = (lastOp6.d.activities || []).find((a: any) => a.type === 4)
    if (customStatus6?.state !== 'Deep in code') throw new Error('TEST 6 Failed: Custom status not updated')
    const rpcActivities6 = (lastOp6.d.activities || []).filter((a: any) => a.type !== 4)
    if (rpcActivities6.length !== 1 || rpcActivities6[0].name !== 'Super Cyberpunk 2077') {
      throw new Error('TEST 6 Failed: RPC activity altered or missing')
    }
    console.log('  ✓ Verified: Only Status updated. RPC configuration was completely untouched.\n')

    // -------------------------------------------------------------
    // TEST 7: Status = ON, RPC = OFF -> Click Status UPDATE 10 times
    // Expected: Status continues working. RPC MUST NEVER appear.
    // -------------------------------------------------------------
    console.log('--- TEST 7: Status = ON, RPC = OFF -> Click Status UPDATE 10 times ---')
    await db.session.update({
      where: { id: sessionId },
      data: { statusEnabled: true, rpcEnabled: false },
    })
    await db.rpcConfig.update({
      where: { id: rpcConfigId },
      data: { enabled: false },
    })

    for (let i = 1; i <= 10; i++) {
      // Simulate Status UPDATE call
      await db.session.updateMany({
        where: { userId: testUser.id },
        data: {
          customStatus: `Status Update Iteration ${i}`,
          lastPresenceUpdate: new Date(),
        },
      })
      capture.payloads = []
      await daemon.syncUser(testUser.id)

      s = (await db.session.findUnique({ where: { id: sessionId } }))!
      rc = (await db.rpcConfig.findUnique({ where: { id: rpcConfigId } }))!
      if (s.rpcEnabled !== false || rc.enabled !== false) {
        throw new Error(`TEST 7 Failed at iteration ${i}: RPC was enabled!`)
      }

      const lastOp7 = capture.payloads[capture.payloads.length - 1]
      const rpcActivities7 = (lastOp7?.d?.activities || []).filter((a: any) => a.type !== 4)
      if (rpcActivities7.length !== 0) {
        throw new Error(`TEST 7 Failed at iteration ${i}: RPC activity appeared! ${JSON.stringify(rpcActivities7)}`)
      }
    }
    console.log('  ✓ Verified: Clicked Status UPDATE 10 times. Status works continuously. RPC NEVER appeared.\n')

    console.log('🎉 ALL 7 TESTS PASSED WITH 100% SUCCESS! Complete separation confirmed.')
  } finally {
    asAny.sockets.clear()
    daemon.stop()
    await db.user.delete({ where: { id: testUser.id } }).catch(() => {})
  }
}

runSeparationTests().catch(err => {
  console.error('❌ Test suite error:', err)
  process.exit(1)
})
