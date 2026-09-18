import { buildPresenceActivities } from '../src/lib/rpc-manager'
import { resolveRpcActivityName, getPlatformFallbackName } from '../src/lib/constants'
import { db } from '../src/lib/db'

async function runNameTests() {
  console.log('🧪 Starting Comprehensive RPC Device / Platform & Name Resolution Verification...\n')

  // Rule 1 & 2 & 3: Selected platform must NOT automatically become the Activity name.
  // Activity name must ALWAYS be taken from the existing "NAME" field.
  const metaQuestWith10X = await buildPresenceActivities({
    rpcConfig: {
      name: '10X RPC',
      type: 'PLAYING',
      platform: 'meta_quest',
      state: 'gg',
      details: 'ggggg',
      enabled: true,
    },
    platform: 'meta_quest',
  })
  const act1 = metaQuestWith10X[0] as any
  if (act1.name !== '10X RPC') {
    throw new Error(`Expected name '10X RPC', got '${act1.name}'`)
  }
  console.log('✓ Test 1 Passed: NAME="10X RPC" with Platform="Meta Quest" -> Activity Name is "10X RPC" (NOT "Meta Quest")')

  // Rule 4: Custom name in NAME field must be used exactly.
  const metaQuestCustom = await buildPresenceActivities({
    rpcConfig: {
      name: 'My Custom Game',
      type: 'PLAYING',
      platform: 'meta_quest',
      state: 'In Lobby',
      details: 'Playing Match',
      enabled: true,
    },
    platform: 'meta_quest',
  })
  const act2 = metaQuestCustom[0] as any
  if (act2.name !== 'My Custom Game') {
    throw new Error(`Expected name 'My Custom Game', got '${act2.name}'`)
  }
  console.log('✓ Test 2 Passed: NAME="My Custom Game" with Platform="Meta Quest" -> Activity Name is "My Custom Game"')

  // Rule 5: If NAME field is empty, fallback to "Meta Quest" only when Meta Quest is selected.
  const metaQuestEmpty = await buildPresenceActivities({
    rpcConfig: {
      name: '',
      type: 'PLAYING',
      platform: 'meta_quest',
      state: 'VR World',
      enabled: true,
    },
    platform: 'meta_quest',
  })
  const act3 = metaQuestEmpty[0] as any
  if (act3.name !== 'Meta Quest') {
    throw new Error(`Expected fallback name 'Meta Quest', got '${act3.name}'`)
  }
  console.log('✓ Test 3 Passed: Empty NAME with Platform="Meta Quest" -> Activity Name falls back to "Meta Quest"')

  // Rule 5b: Whitespace-only NAME also falls back to "Meta Quest".
  const metaQuestWhitespace = await buildPresenceActivities({
    rpcConfig: {
      name: '   ',
      type: 'PLAYING',
      platform: 'meta_quest',
      enabled: true,
    },
    platform: 'meta_quest',
  })
  const act3b = metaQuestWhitespace[0] as any
  if (act3b.name !== 'Meta Quest') {
    throw new Error(`Expected fallback name 'Meta Quest', got '${act3b.name}'`)
  }
  console.log('✓ Test 4 Passed: Whitespace NAME with Platform="Meta Quest" -> Activity Name falls back to "Meta Quest"')

  // Rule 6: Apply this same logic consistently to ALL platform/device options.
  const platformCases = [
    { platform: 'xbox', label: 'Xbox', customName: 'Halo Infinite' },
    { platform: 'ps4', label: 'PlayStation 4', customName: 'Bloodborne' },
    { platform: 'ps5', label: 'PlayStation 5', customName: 'Demon\'s Souls' },
    { platform: 'console', label: 'Console', customName: 'Retro Game' },
    { platform: 'embedded', label: 'Embedded', customName: 'Smart Terminal' },
    { platform: 'desktop', label: '10X RPC', customName: 'Visual Studio Code' },
    { platform: 'none', label: '10X RPC', customName: 'Discord Bot' },
  ]

  for (const pc of platformCases) {
    // With custom name:
    const withCustom = await buildPresenceActivities({
      rpcConfig: {
        name: pc.customName,
        type: 'PLAYING',
        platform: pc.platform,
        enabled: true,
      },
      platform: pc.platform,
    })
    const actCustom = withCustom[0] as any
    if (actCustom.name !== pc.customName) {
      throw new Error(`Platform ${pc.platform} with custom name '${pc.customName}' failed: got '${actCustom.name}'`)
    }

    // With empty name:
    const withEmpty = await buildPresenceActivities({
      rpcConfig: {
        name: '',
        type: 'PLAYING',
        platform: pc.platform,
        enabled: true,
      },
      platform: pc.platform,
    })
    const actEmpty = withEmpty[0] as any
    if (actEmpty.name !== pc.label) {
      throw new Error(`Platform ${pc.platform} with empty name failed: expected fallback '${pc.label}', got '${actEmpty.name}'`)
    }
    console.log(`✓ Test Passed: Platform "${pc.platform}" -> custom name preserved ("${pc.customName}"), empty name falls back to "${pc.label}"`)
  }

  // Rule 7 & 10: Platform selection and Activity Name are separate values in database.
  // Updating platform must never overwrite NAME.
  const testUser = await db.user.create({
    data: {
      discordId: `test_platform_sep_${Date.now()}`,
      username: 'PlatformTester',
      rpcConfigs: {
        create: {
          name: '10X RPC',
          type: 'PLAYING',
          platform: 'desktop',
          state: 'Coding',
          details: 'Working on 10X RPC',
          enabled: true,
        },
      },
    },
    include: { rpcConfigs: true },
  })

  try {
    let rpcConfig = await db.rpcConfig.findFirst({ where: { userId: testUser.id } })
    if (!rpcConfig) throw new Error('Failed to load initial rpcConfig')

    // Simulate user changing Platform from Desktop to Meta Quest
    rpcConfig = await db.rpcConfig.update({
      where: { id: rpcConfig.id },
      data: { platform: 'meta_quest' }, // ONLY platform updated
    })

    if (rpcConfig.name !== '10X RPC') {
      throw new Error(`Updating platform corrupted NAME: expected '10X RPC', got '${rpcConfig.name}'`)
    }
    if (rpcConfig.platform !== 'meta_quest') {
      throw new Error(`Platform was not updated: expected 'meta_quest', got '${rpcConfig.platform}'`)
    }
    console.log('✓ Test Passed: Updating platform from desktop to meta_quest preserved NAME="10X RPC"')

    // Simulate presence build from this DB record:
    const dbActivities = await buildPresenceActivities({
      rpcConfig,
      platform: rpcConfig.platform,
    })
    const actFromDb = dbActivities[0] as any
    if (actFromDb.name !== '10X RPC') {
      throw new Error(`Expected DB activity name '10X RPC', got '${actFromDb.name}'`)
    }
    console.log('✓ Test Passed: Activity built from DB record has name="10X RPC" with platform="meta_quest"')
  } finally {
    await db.user.delete({ where: { id: testUser.id } }).catch(() => {})
  }

  console.log('\n🎉 ALL 11 RPC DEVICE / PLATFORM & NAME RULES FULLY VERIFIED AND PASSING!')
}

runNameTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Test failed:', err)
    process.exit(1)
  })
