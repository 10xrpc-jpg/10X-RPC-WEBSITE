// Automated Verification: Independence of "Enable Status" and "Enable RPC"
import { db } from '../src/lib/db'
import { buildPresenceActivities } from '../src/lib/rpc-manager'

async function runTests() {
  console.log('🧪 Starting Status & RPC Independence Test Suite...\n')

  // Create or retrieve a test user
  const testDiscordId = 'test-indep-' + Date.now()
  const testUser = await db.user.create({
    data: {
      discordId: testDiscordId,
      username: 'StatusRpcTester',
      sessions: {
        create: {
          token: 'token-' + testDiscordId,
          expiresAt: new Date(Date.now() + 86400000),
          statusEnabled: false,
          rpcEnabled: false,
          userStatus: 'online',
        },
      },
      rpcConfigs: {
        create: {
          name: 'Super Game 2026',
          type: 'PLAYING',
          state: 'Testing independence',
          enabled: false,
        },
      },
      trial: {
        create: {
          endsAt: new Date(Date.now() + 86400000 * 3),
          active: true,
        },
      },
    },
    include: {
      sessions: true,
      rpcConfigs: true,
    },
  })

  const sessionId = testUser.sessions[0].id
  const rpcConfigId = testUser.rpcConfigs[0].id

  try {
    // -------------------------------------------------------------
    // Test 1: Both OFF (Status OFF, RPC OFF)
    // -------------------------------------------------------------
    console.log('Test 1: Combination [Status OFF, RPC OFF]')
    let session = await db.session.update({
      where: { id: sessionId },
      data: { statusEnabled: false, rpcEnabled: false },
    })
    let rpcConfig = await db.rpcConfig.update({
      where: { id: rpcConfigId },
      data: { enabled: false },
    })
    if (session.statusEnabled !== false || session.rpcEnabled !== false || rpcConfig.enabled !== false) {
      throw new Error('Test 1 failed: Expected both to be false')
    }
    let activities = await buildPresenceActivities({
      rpcConfig: (session.rpcEnabled && rpcConfig.enabled) ? rpcConfig : null,
    })
    if (activities.length !== 0) {
      throw new Error(`Test 1 failed: Expected 0 activities, got ${activities.length}`)
    }
    console.log('  ✓ Verified: Status is OFF, RPC is OFF, 0 activities sent to Discord.\n')

    // -------------------------------------------------------------
    // Test 2: Status ON, RPC OFF
    // -------------------------------------------------------------
    console.log('Test 2: Combination [Status ON, RPC OFF]')
    session = await db.session.update({
      where: { id: sessionId },
      data: { statusEnabled: true, userStatus: 'online' },
    })
    // Ensure rpcEnabled and rpcConfig.enabled were NOT changed
    session = (await db.session.findUnique({ where: { id: sessionId } }))!
    rpcConfig = (await db.rpcConfig.findUnique({ where: { id: rpcConfigId } }))!
    if (session.statusEnabled !== true) throw new Error('Test 2 failed: statusEnabled is not true')
    if (session.rpcEnabled !== false) throw new Error('Test 2 failed: rpcEnabled was accidentally set to true!')
    if (rpcConfig.enabled !== false) throw new Error('Test 2 failed: rpcConfig.enabled was accidentally set to true!')

    activities = await buildPresenceActivities({
      rpcConfig: (session.rpcEnabled && rpcConfig.enabled) ? rpcConfig : null,
    })
    if (activities.length !== 0) {
      throw new Error(`Test 2 failed: RPC was sent even though RPC is OFF! Activities: ${JSON.stringify(activities)}`)
    }
    console.log('  ✓ Verified: Status is ON (online), RPC is completely inactive (0 activities).\n')

    // -------------------------------------------------------------
    // Test 3: Status ON, RPC ON
    // -------------------------------------------------------------
    console.log('Test 3: Combination [Status ON, RPC ON]')
    session = await db.session.update({
      where: { id: sessionId },
      data: { rpcEnabled: true },
    })
    rpcConfig = await db.rpcConfig.update({
      where: { id: rpcConfigId },
      data: { enabled: true },
    })
    session = (await db.session.findUnique({ where: { id: sessionId } }))!
    if (session.statusEnabled !== true) throw new Error('Test 3 failed: statusEnabled did not stay true')
    if (session.rpcEnabled !== true) throw new Error('Test 3 failed: rpcEnabled is not true')

    activities = await buildPresenceActivities({
      rpcConfig: (session.rpcEnabled && rpcConfig.enabled) ? rpcConfig : null,
    })
    if (activities.length !== 1) {
      throw new Error(`Test 3 failed: Expected 1 RPC activity, got ${activities.length}`)
    }
    if ((activities[0] as any).name !== 'Super Game 2026') {
      throw new Error(`Test 3 failed: Activity name mismatch: ${(activities[0] as any).name}`)
    }
    console.log('  ✓ Verified: Status is ON (online), RPC is ON (activity active and live).\n')

    // -------------------------------------------------------------
    // Test 4: Status OFF, RPC ON
    // -------------------------------------------------------------
    console.log('Test 4: Combination [Status OFF, RPC ON]')
    session = await db.session.update({
      where: { id: sessionId },
      data: { statusEnabled: false },
    })
    session = (await db.session.findUnique({ where: { id: sessionId } }))!
    rpcConfig = (await db.rpcConfig.findUnique({ where: { id: rpcConfigId } }))!
    if (session.statusEnabled !== false) throw new Error('Test 4 failed: statusEnabled is not false')
    if (session.rpcEnabled !== true) throw new Error('Test 4 failed: rpcEnabled accidentally changed!')
    if (rpcConfig.enabled !== true) throw new Error('Test 4 failed: rpcConfig.enabled accidentally changed!')

    activities = await buildPresenceActivities({
      rpcConfig: (session.rpcEnabled && rpcConfig.enabled) ? rpcConfig : null,
    })
    if (activities.length !== 1) {
      throw new Error(`Test 4 failed: Expected 1 RPC activity, got ${activities.length}`)
    }
    console.log('  ✓ Verified: Status is OFF, RPC remains ON and fully active.\n')

    // -------------------------------------------------------------
    // Test 5: Cross-triggering isolation checks
    // -------------------------------------------------------------
    console.log('Test 5: Cross-triggering Stress Test')
    // Repeatedly toggle status; check RPC stays ON
    for (let i = 0; i < 5; i++) {
      await db.session.update({
        where: { id: sessionId },
        data: { statusEnabled: i % 2 === 0 },
      })
      const check = (await db.session.findUnique({ where: { id: sessionId } }))!
      if (check.rpcEnabled !== true) {
        throw new Error(`Cross-trigger failed at status toggle iteration ${i}: rpcEnabled was altered!`)
      }
    }

    // Repeatedly toggle RPC; check status stays as set
    await db.session.update({ where: { id: sessionId }, data: { statusEnabled: true } })
    for (let i = 0; i < 5; i++) {
      await db.session.update({
        where: { id: sessionId },
        data: { rpcEnabled: i % 2 === 0 },
      })
      await db.rpcConfig.update({
        where: { id: rpcConfigId },
        data: { enabled: i % 2 === 0 },
      })
      const check = (await db.session.findUnique({ where: { id: sessionId } }))!
      if (check.statusEnabled !== true) {
        throw new Error(`Cross-trigger failed at RPC toggle iteration ${i}: statusEnabled was altered!`)
      }
    }
    console.log('  ✓ Verified: No cross-triggering under repeated sequential toggles.\n')

    console.log('🎉 ALL TESTS PASSED SUCCESSFULLY! Both features are 100% independent.')
  } finally {
    // Cleanup test user and associated records
    await db.user.delete({ where: { id: testUser.id } }).catch(() => {})
  }
}

runTests().catch(err => {
  console.error('❌ Test suite failed:', err)
  process.exit(1)
})
