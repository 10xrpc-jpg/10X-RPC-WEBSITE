/**
 * Task 108 + 109 test suite (local sandbox, SQLite).
 *
 * Task 108 — MUTUAL EXCLUSIVITY for RPC1/RPC2/RPC3:
 *   1. enableSlotExclusively turns every OTHER slot off atomically.
 *   2. Rapid concurrent toggles can NEVER leave 2+ slots enabled.
 *   3. Game RPC / Application RPC rows are never touched by the rule.
 *   4. enforceRpcSlotExclusivity heals legacy multi-enabled states.
 *
 * Task 109 — ROTATE-MODE PLAYING OWNERSHIP ("Competing in 10X RPC" fix):
 *   5. Auto Rotate ON, no game → the ROTATING card keeps PLAYING on every
 *      turn (before the fix slot 2/3 turns degraded to WATCHING / LISTENING /
 *      COMPETING because the non-pushed first slot consumed PLAYING).
 *   6. Auto Rotate ON + game → game keeps PLAYING; the rotating card gets a
 *      deterministic substitute.
 *   7. Simultaneous (Multi-Session) mode is unchanged.
 *   8. app_rpc parity: the same assignment the daemon computes.
 *
 * Run: bun scripts/test-slot-exclusivity.ts
 */
import { PrismaClient } from '@prisma/client'
import { assignDisplayTypes, buildGlobalDisplayTypeInputs, resolveRuntimeCandidates, type RpcCandidate } from '../src/lib/rpc-manager'

const db = new PrismaClient()

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// Import the real exclusivity helpers through a ts transform-free path:
// they only need `db` — we re-implement the import via require of the
// compiled-free TS is impossible in bun-eval, so instead we import the module
// directly (bun runs TS natively).
const { enableSlotExclusively, enforceRpcSlotExclusivity } = await import('../src/lib/rpc-slots')

const USER = 'test-user-108'
const DISCORD_ID = '108000000000000108'
const now = new Date()

// FK target — create (or reuse) the test user, clean up its rows.
await db.user.deleteMany({ where: { id: USER } })
await db.user.create({
  data: {
    id: USER,
    discordId: DISCORD_ID,
    username: 'exclusivity-test',
  },
})

async function seedSlots(rows: Array<{ slot: number; name: string; type?: string; enabled?: boolean; appId?: string | null; details?: string | null }>) {
  await db.rpcConfig.deleteMany({ where: { userId: USER } })
  for (const r of rows) {
    await db.rpcConfig.create({
      data: {
        userId: USER,
        slot: r.slot,
        name: r.name,
        type: r.type ?? 'PLAYING',
        platform: 'desktop',
        enabled: r.enabled ?? false,
        appId: r.appId ?? null,
        details: r.details ?? null,
        startMinsAgo: 0,
        // Task 113 — these are REAL user-configured slots (the suite models
        // explicit user setups); the resolver now excludes configured=false
        // placeholder rows from the rotation pool as defense-in-depth.
        configured: true,
      },
    })
  }
  return db.rpcConfig.findMany({ where: { userId: USER }, orderBy: { slot: 'asc' } })
}

async function seedGame(enabled: boolean) {
  await db.gameConfig.deleteMany({ where: { userId: USER } })
  if (!enabled) return null
  return db.gameConfig.create({
    data: {
      userId: USER,
      gameSlug: 'minecraft',
      gameName: 'Minecraft',
      platform: 'windows',
      enabled: true,
    },
  })
}

// ─── Task 108 — exclusive enable ─────────────────────────────────────────────
console.log('\n══ Task 108 · enableSlotExclusively ══')
{
  const rows = await seedSlots([
    { slot: 1, name: 'RPC One', enabled: true },
    { slot: 2, name: 'RPC Two' },
    { slot: 3, name: 'RPC Three' },
  ])
  await db.gameConfig.deleteMany({ where: { userId: USER } })
  await db.applicationRpcConfig.deleteMany({ where: { userId: USER } }).catch(() => {})
  await db.applicationRpcConfig.create({
    data: { userId: USER, name: 'App RPC', type: 'WATCHING', enabled: true },
  }).catch(() => null)

  const target = rows.find(r => r.slot === 3)!
  const res = await enableSlotExclusively(USER, target.id)
  check('enable slot 3 succeeds', res.ok)
  if (res.ok) {
    check('slot 3 auto-disabled [1]', JSON.stringify(res.disabledSlots) === '[1]', JSON.stringify(res.disabledSlots))
  }
  const after = await db.rpcConfig.findMany({ where: { userId: USER }, orderBy: { slot: 'asc' } })
  check('only slot 3 enabled in DB', after.filter(r => r.enabled).map(r => r.slot).join(',') === '3')
  const fields = after.find(r => r.slot === 1)!
  check('slot 1 fields preserved (name intact)', fields.name === 'RPC One')
  const game = await db.gameConfig.findFirst({ where: { userId: USER } })
  check('no GameConfig rows created/touched', game === null)
  const appRow = await db.applicationRpcConfig.findFirst({ where: { userId: USER } }).catch(() => null)
  check('Application RPC untouched (still enabled)', !!appRow?.enabled)

  // Re-enable slot 1 → slots 3 off.
  const one = after.find(r => r.slot === 1)!
  const res2 = await enableSlotExclusively(USER, one.id)
  const after2 = await db.rpcConfig.findMany({ where: { userId: USER }, orderBy: { slot: 'asc' } })
  check('enable slot 1 → only slot 1 enabled', res2.ok && after2.filter(r => r.enabled).map(r => r.slot).join(',') === '1')

  // Disable-all: flipping slot 1 off leaves zero enabled (toggle route handles presence; here just DB rule).
  await db.rpcConfig.update({ where: { id: one.id }, data: { enabled: false } })
  const none = await db.rpcConfig.count({ where: { userId: USER, enabled: true } })
  check('disable path leaves 0 enabled slots', none === 0)
}

// ─── Task 108 — concurrent toggles (race) ────────────────────────────────────
console.log('\n══ Task 108 · concurrent toggles (race) ══')
{
  const rows = await seedSlots([
    { slot: 1, name: 'R1' },
    { slot: 2, name: 'R2' },
    { slot: 3, name: 'R3' },
  ])
  // 3 rounds of 3 concurrent enables; each round must end with EXACTLY one
  // enabled slot (the last committed winner's round target set).
  for (let round = 0; round < 3; round++) {
    const order = [rows[round % 3], rows[(round + 1) % 3], rows[(round + 2) % 3]]
    await Promise.all(order.map(r => enableSlotExclusively(USER, r.id)))
    const enabled = await db.rpcConfig.findMany({ where: { userId: USER, enabled: true } })
    check(`round ${round + 1}: exactly ONE slot enabled after 3 parallel toggles`, enabled.length === 1, `got ${enabled.length}`)
    // Heal (belt & suspenders) must be a no-op when the invariant holds.
    const heal = await enforceRpcSlotExclusivity(USER)
    check(`round ${round + 1}: heal no-op`, !heal.changed && heal.disabledSlots.length === 0)
  }
}

// ─── Task 108 — legacy-state heal ────────────────────────────────────────────
console.log('\n══ Task 108 · enforceRpcSlotExclusivity (legacy heal) ══')
{
  // Simulate the pre-Task-108 state: 2 enabled slots.
  const rows = await seedSlots([
    { slot: 1, name: 'R1', enabled: true },
    { slot: 2, name: 'R2', enabled: true },
    { slot: 3, name: 'R3' },
  ])
  const heal = await enforceRpcSlotExclusivity(USER)
  check('heal reports changed', heal.changed)
  check('heal keeps the first enabled slot (1)', heal.keepSlot === 1 && heal.disabledSlots.join(',') === '2', JSON.stringify(heal))
  const after = await db.rpcConfig.findMany({ where: { userId: USER, enabled: true } })
  check('DB converged to slot 1 only', after.length === 1 && after[0].slot === 1)

  // keepId honored.
  const three = rows.find(r => r.slot === 3)!
  await db.rpcConfig.update({ where: { id: three.id }, data: { enabled: true } })
  await db.rpcConfig.updateMany({ where: { userId: USER, slot: 2 }, data: { enabled: true } })
  const heal2 = await enforceRpcSlotExclusivity(USER, three.id)
  check('heal honors keepId (slot 3 kept)', heal2.keepSlot === 3 && heal2.disabledSlots.sort().join(',') === '1,2', JSON.stringify(heal2))
}

// ─── Task 109 — rotate-mode display types ────────────────────────────────────
console.log('\n══ Task 109 · rotating card keeps PLAYING (no game) ══')
{
  const rows = await seedSlots([
    { slot: 1, name: '10X RPC', type: 'PLAYING', enabled: true },
    { slot: 2, name: '10X RPC', type: 'PLAYING' },
    { slot: 3, name: '10X RPC', type: 'PLAYING' },
  ])
  await seedGame(false)
  await db.globalConfig.deleteMany({ where: { userId: USER } })
  const all = rows as unknown as Array<RpcCandidate & { slot?: number }>
  const slotById = new Map(rows.map(r => [r.id, r]))
  const selection = rows.map(r => r.id) // Task 106 user setup: ALL three slots selected

  for (let turn = 0; turn < 3; turn++) {
    const runtime = resolveRuntimeCandidates({
      rpcEnabled: true,
      rpcConfigs: all,
      allRpcConfigs: all,
      enabledGame: [],
      autoRotate: true,
      rotateSecs: 30,
      rotateRefMs: now.getTime() - turn * 30_000, // deterministic turn per iteration
      rotateOrder: 'forward',
      rotateSkip: 0,
      rotateSlotKeys: selection,
      rotateSeed: USER,
      nowMs: now.getTime(),
    })
    if (runtime.runtimeMode !== 'rotate') { check(`turn ${turn}: runtimeMode rotate`, false, runtime.runtimeMode); continue }
    const rotating = runtime.candidates[0]
    const inputs = buildGlobalDisplayTypeInputs({
      slots: all,
      games: [],
      appRpc: null,
    })
    const types = assignDisplayTypes(inputs, new Set(), rotating.id)
    const t = types.get(rotating.id!)
    check(`turn ${turn} (slot ${slotById.get(rotating.id!)?.slot}): rotating card = PLAYING`, t === 'PLAYING', `got ${t}`)
  }
}

console.log('\n══ Task 109 · rotate + game → deterministic substitute ══')
{
  const rows = await seedSlots([
    { slot: 1, name: '10X RPC', type: 'PLAYING', enabled: true },
    { slot: 2, name: '10X RPC', type: 'PLAYING' },
    { slot: 3, name: '10X RPC', type: 'PLAYING' },
  ])
  const game = await seedGame(true)
  const all = rows as unknown as Array<RpcCandidate & { slot?: number }>
  const selection = rows.map(r => r.id)
  for (let turn = 0; turn < 3; turn++) {
    const runtime = resolveRuntimeCandidates({
      rpcEnabled: true,
      rpcConfigs: all,
      allRpcConfigs: all,
      enabledGame: [game].filter(Boolean) as never,
      autoRotate: true,
      rotateSecs: 30,
      rotateRefMs: now.getTime() - turn * 30_000,
      rotateOrder: 'forward',
      rotateSkip: 0,
      rotateSlotKeys: selection,
      rotateSeed: USER,
      nowMs: now.getTime(),
    })
    const rotating = runtime.candidates[0]
    const inputs = buildGlobalDisplayTypeInputs({ slots: all, games: [game], appRpc: null })
    const types = assignDisplayTypes(inputs, new Set(), rotating.id)
    check(`turn ${turn}: game pinned PLAYING`, types.get(`game:${game!.gameSlug}`) === 'PLAYING')
    const t = types.get(rotating.id!)
    check(`turn ${turn}: rotating card substituted (not PLAYING)`, !!t && t !== 'PLAYING', `got ${t}`)
  }
}

console.log('\n══ Task 109 · simultaneous mode unchanged ══')
{
  const rows = await seedSlots([
    { slot: 1, name: 'A', type: 'PLAYING', enabled: true },
    { slot: 2, name: 'B', type: 'PLAYING', enabled: true },
  ])
  await seedGame(false)
  const all = rows as unknown as Array<RpcCandidate & { slot?: number }>
  const runtime = resolveRuntimeCandidates({
    rpcEnabled: true, rpcConfigs: all, enabledGame: [], autoRotate: false,
  })
  check('simultaneous mode with 2 enabled slots', runtime.runtimeMode === 'simultaneous' && runtime.candidates.length === 2)
  const inputs = buildGlobalDisplayTypeInputs({ slots: all.filter(c => (c as { enabled?: boolean }).enabled), games: [], appRpc: null })
  const types = assignDisplayTypes(inputs)
  check('first enabled slot PLAYING, second substituted', types.get(all[0].id!) === 'PLAYING' && types.get(all[1].id!) === 'WATCHING',
    JSON.stringify([...types.entries()]))
}

console.log('\n══ Task 109 · app_rpc parity with the daemon ══')
{
  // Simulate BOTH surfaces on the same inputs: the rotating slot keeps
  // PLAYING and app_rpc (neverPlaying) gets a substitute that never collides.
  const rows = await seedSlots([
    { slot: 1, name: '10X RPC', type: 'PLAYING' },
    { slot: 2, name: '10X RPC', type: 'PLAYING' },
    { slot: 3, name: '10X RPC', type: 'PLAYING' },
  ])
  await seedGame(false)
  const all = rows as unknown as Array<RpcCandidate & { slot?: number }>
  const selection = rows.map(r => r.id)
  const appRpc = { name: '10X RPC', appId: null, type: 'PLAYING' }
  for (let turn = 0; turn < 3; turn++) {
    const runtime = resolveRuntimeCandidates({
      rpcEnabled: true, rpcConfigs: all, allRpcConfigs: all, enabledGame: [],
      autoRotate: true, rotateSecs: 30, rotateRefMs: now.getTime() - turn * 30_000,
      rotateOrder: 'forward', rotateSkip: 0, rotateSlotKeys: selection, rotateSeed: USER, nowMs: now.getTime(),
    })
    const rotating = runtime.candidates[0]
    const inputs = buildGlobalDisplayTypeInputs({ slots: all, games: [], appRpc })
    const neverPlaying = new Set<string>(['app_rpc'])
    const types = assignDisplayTypes(inputs, neverPlaying, rotating.id)
    check(`turn ${turn}: rotating slot PLAYING`, types.get(rotating.id!) === 'PLAYING')
    const appType = types.get('app_rpc')
    check(`turn ${turn}: app_rpc gets a non-PLAYING type`, !!appType && appType !== 'PLAYING', `got ${appType}`)
    // Triple uniqueness across the pushed set (rotating slot + app_rpc).
    const rotatingInput = inputs.find(c => c.key === rotating.id)!
    const t1 = types.get(rotating.id!), t2 = appType
    check(`turn ${turn}: no (type,app,name) triple collision`,
      `${t1}|${rotatingInput.appId ?? ''}|${rotatingInput.name}` !== `${t2}|${appRpc.appId ?? ''}|${appRpc.name}`)
  }
}

await db.rpcConfig.deleteMany({ where: { userId: USER } })
await db.gameConfig.deleteMany({ where: { userId: USER } })
await db.applicationRpcConfig.deleteMany({ where: { userId: USER } }).catch(() => {})
await db.$disconnect()

console.log(`\n${'═'.repeat(50)}\nRESULT: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
