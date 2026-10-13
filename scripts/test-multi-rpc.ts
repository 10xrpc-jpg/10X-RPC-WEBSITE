// Task 82 — Multi-RPC verification: 3 slots + isolated Game RPC + Auto Rotate
// Pure-function checks over selectActiveRpcConfigs / resolveRuntimeCandidates /
// buildPresenceActivities (no network, no DB).
import {
  selectActiveRpcConfigs,
  resolveRuntimeCandidates,
  buildPresenceActivities,
  fetchRpcAppIds,
} from '../src/lib/rpc-manager'

function assert(cond: boolean, label: string) {
  if (!cond) throw new Error(`FAIL: ${label}`)
  console.log(`PASS: ${label}`)
}

const slot = (n: number, name: string, enabled: boolean, extra: object = {}) => ({
  id: `slot${n}`, userId: 'u1', slot: n, name, type: 'PLAYING', platform: 'desktop',
  state: `state-${n}`, details: `details-${n}`, enabled, startMinsAgo: 0, ...extra,
}) as any

async function main() {
  const ctx = { timezone: 'UTC', rpcStartedAt: Date.now() }

  // ── 1. Simultaneous: 3 enabled slots → 3 activities (+ no game) ──
  const r1 = resolveRuntimeCandidates({
    rpcEnabled: true,
    rpcConfigs: [slot(1, 'RPC One', true), slot(2, 'RPC Two', true), slot(3, 'RPC Three', true)],
    enabledGame: null,
  })
  assert(r1.active && r1.candidates.length === 3, 'simultaneous: 3 enabled slots → 3 candidates')
  assert(r1.runtimeMode === 'simultaneous', 'runtime mode = simultaneous when rotate off')
  const a1 = await buildPresenceActivities({ rpcConfigs: r1.candidates, placeholderCtx: ctx })
  assert(a1.length === 3, `OP 3 carries 3 activities (got ${a1.length})`)
  assert(
    (a1[0] as any).state === 'state-1' && (a1[1] as any).state === 'state-2' && (a1[2] as any).state === 'state-3',
    'each activity keeps its OWN slot fields (no cross-slot merge)'
  )

  // ── 2. Independent enable: RPC 2 disabled → 1 & 3 keep running ──
  const r2 = resolveRuntimeCandidates({
    rpcEnabled: true,
    rpcConfigs: [slot(1, 'RPC One', true), slot(2, 'RPC Two', false), slot(3, 'RPC Three', true)],
    enabledGame: null,
  })
  assert(r2.candidates.length === 2, 'disabled slot excluded, others intact')
  assert(r2.candidates[0].slot === 1 && r2.candidates[1].slot === 3, 'slot order preserved (1 → 3)')

  // ── 3. Game coexistence: 2 slots + game → 3 candidates, game LAST & isolated ──
  const game = { id: 'g1', gameSlug: 'minecraft', gameName: 'Minecraft', name: 'Minecraft', enabled: true, platform: 'xbox', startMinsAgo: 0 } as any
  const r3 = resolveRuntimeCandidates({
    rpcEnabled: true,
    rpcConfigs: [slot(1, 'RPC One', true), slot(2, 'RPC Two', true), slot(3, 'Idle Slot', false)],
    enabledGame: game,
  })
  assert(r3.candidates.length === 3, '2 enabled slots + game = 3 candidates')
  assert(r3.candidates[2].gameSlug === 'minecraft', 'game appended last')
  assert((r3.candidates[0] as any).state === 'state-1', 'slot fields untouched by game candidate')
  const a3 = await buildPresenceActivities({ rpcConfigs: r3.candidates, placeholderCtx: ctx })
  const mc = a3.find(a => (a as any).name === 'Minecraft')
  assert(!!mc, 'game activity present with official spoof name')
  assert(!!(mc as any).application_id, 'game activity carries an application_id (spoof)')

  // ── 4. Auto Rotate: deterministic index per interval, configs untouched ──
  const cfgs = [slot(1, 'A', true), slot(2, 'B', true), slot(3, 'C', true)]
  const ref = 1_700_000_000_000
  const rot = (nowMs: number) => resolveRuntimeCandidates({
    rpcEnabled: true, rpcConfigs: cfgs, enabledGame: null,
    autoRotate: true, rotateSecs: 30, rotateRefMs: ref, nowMs,
  })
  const i0 = rot(ref + 5_000)
  const i1 = rot(ref + 35_000)
  const i2 = rot(ref + 65_000)
  const i3 = rot(ref + 95_000)
  assert(i0.runtimeMode === 'rotate' && i0.candidates.length === 1, 'rotate sends exactly ONE activity')
  assert(i0.rotateIndex === 0 && i1.rotateIndex === 1 && i2.rotateIndex === 2 && i3.rotateIndex === 0,
    `index advances 0→1→2→0 (got ${i0.rotateIndex},${i1.rotateIndex},${i2.rotateIndex},${i3.rotateIndex})`)
  assert(cfgs.every(c => c.enabled), 'rotation never modified saved enabled flags')
  assert(cfgs[0].state === 'state-1' && cfgs[1].state === 'state-2', 'rotation never modified saved fields')
  // Deterministic across restarts (same inputs → same index)
  assert(rot(ref + 35_000).rotateIndex === i1.rotateIndex, 'rotation deterministic (restart-safe)')

  // ── 5. Legacy wrapper preserved (game wins over single normal config) ──
  const { selectActiveRpc } = await import('../src/lib/rpc-manager')
  const legacy = selectActiveRpc(true, slot(1, 'Normal', true), game)
  assert(legacy.mode === 'game' && legacy.config?.name === 'Minecraft', 'legacy selectActiveRpc behavior intact')

  // ── 6. Per-slot Application ID fallback map ──
  const map = await fetchRpcAppIds('no-such-user')
  assert(map instanceof Map && map.size === 0, 'fetchRpcAppIds safe on unknown user (empty map)')

  // ── 7. Max-3 invariant: candidates never exceed 3 slots + 1 game ──
  const r7 = resolveRuntimeCandidates({
    rpcEnabled: true,
    rpcConfigs: [slot(1, 'A', true), slot(2, 'B', true), slot(3, 'C', true)],
    enabledGame: game,
  })
  assert(r7.candidates.length === 4, '3 slots + isolated game = 4 activities max')
  console.log('\nALL MULTI-RPC CHECKS PASSED ✅')
}

main().catch(e => { console.error(e); process.exit(1) })
