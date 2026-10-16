// Task 107 — RPC3 fix verification: display-type substitution, fingerprint
// rotation coverage, app-daemon order parity, resolver regression.
// Run: bunx tsx scripts/test-rpc3-fixes.ts   (or bun scripts/test-rpc3-fixes.ts)
import {
  resolveRuntimeCandidates,
  assignDisplayTypes,
  buildGlobalDisplayTypeInputs,
  rpcCandidateKey,
  type RpcCandidate,
  type DisplayTypeCandidate,
} from '../src/lib/rpc-manager'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const slot = (id: string, n: number, over: Partial<RpcCandidate> = {}): RpcCandidate & { slot: number; enabled: boolean } => ({
  id, slot: n, name: `RPC ${n}`, type: 'PLAYING', platform: 'desktop', enabled: true, ...over,
})

// ─── 1. Resolver regression (Task 106 contract intact) ───────────────────────
console.log('\n[1] resolveRuntimeCandidates regression')
{
  const s1 = slot('s1', 1)
  const s2 = slot('s2', 2, { enabled: false })
  const s3 = slot('s3', 3, { enabled: false })
  const r = resolveRuntimeCandidates({
    rpcEnabled: true,
    rpcConfigs: [s1, s2, s3],
    allRpcConfigs: [s1, s2, s3],
    enabledGame: [],
    autoRotate: true,
    rotateSecs: 15,
    rotateRefMs: Date.now() - 20_000,
    rotateSlotKeys: ['s1', 's2', 's3'],
    rotateSeed: 'u1',
  })
  check('rotate mode with 3 selected slots', r.runtimeMode === 'rotate' && r.rotatePoolLength === 3)
  check('rotating candidate exists and is a slot', !!r.candidates[0] && !r.candidates[0].gameSlug)
  check('disabled-but-selected slot publishable (enabled stamped)', r.candidates[0].enabled === true)
  check('pool keys cover all 3 slots', JSON.stringify([...(r.rotatePoolKeys ?? [])].sort()) === JSON.stringify(['s1', 's2', 's3']))
}

// ─── 2. THE CORE FIX — rotate mode + game: rotating card must NOT be PLAYING ─
console.log('\n[2] rotate+game display-type substitution (the "rotating RPC invisible" fix)')
{
  const s1 = slot('s1', 1, { name: '10X RPC | Control' })
  const s2 = slot('s2', 2, { enabled: false, name: 'RPC Two' })
  const s3 = slot('s3', 3, { enabled: false, name: 'RPC Three' })
  const game: RpcCandidate & { gameSlug: string; gameName: string; enabled: boolean } = {
    id: 'g1', name: 'Grand Theft Auto VI', type: 'PLAYING', enabled: true, gameSlug: 'gta-vi', gameName: 'Grand Theft Auto VI',
  } as unknown as RpcCandidate & { gameSlug: string; gameName: string; enabled: boolean }
  // Mirror rpc-daemon.ts Task 107: rotate mode → ALL slots (enabled AND
  // disabled) via the shared builder; games pinned; neverPlaying = app_rpc.
  const allSlots = [s1, s2, s3]
  const inputs = buildGlobalDisplayTypeInputs({
    slots: allSlots,
    games: [game],
    appRpc: null,
  })
  const displayTypes = assignDisplayTypes(inputs, new Set<string>())
  check('game pinned PLAYING', displayTypes.get('game:gta-vi') === 'PLAYING')
  for (const s of allSlots) {
    const t = displayTypes.get(s.id!)
    check(`slot ${s.id} (enabled=${s.enabled}) yields to a substitute type (not PLAYING)`, !!t && t !== 'PLAYING', `got ${t}`)
  }
  // Without a game the rotating card owns PLAYING.
  const noGame = assignDisplayTypes(buildGlobalDisplayTypeInputs({ slots: allSlots, games: [], appRpc: null }), new Set())
  check('no game → first slot keeps PLAYING', noGame.get('s1') === 'PLAYING')

  // Same-name degenerate config: every slot still gets a DISTINCT triple.
  const sameName = allSlots.map(s => ({ ...s, name: '10X RPC' }))
  const dtSame = assignDisplayTypes(buildGlobalDisplayTypeInputs({ slots: sameName, games: [game], appRpc: null }), new Set())
  const triples = allSlots.map(s => `${dtSame.get(s.id!)}|${s.id}`)
  check('same-name slots: distinct types', new Set(triples.map(t => t.split('|')[0])).size === 3, JSON.stringify(triples))
}

// ─── 3. Multi-session: 3 slots + game all render distinct types ──────────────
console.log('\n[3] multi-session 3 slots + game + app_rpc assignment')
{
  const s1 = slot('s1', 1, { name: 'RPC One' })
  const s2 = slot('s2', 2, { name: 'RPC Two' })
  const s3 = slot('s3', 3, { name: 'RPC Three' })
  const game = { key: 'game:gta-vi', name: 'Grand Theft Auto VI', appId: null, configuredType: 'PLAYING', kind: 'game' as const }
  const inputs: DisplayTypeCandidate[] = ([
    { key: 's1', name: 'RPC One', appId: null, configuredType: 'PLAYING' },
    { key: 's2', name: 'RPC Two', appId: null, configuredType: 'PLAYING' },
    { key: 's3', name: 'RPC Three', appId: null, configuredType: 'PLAYING' },
    game,
    { key: 'app_rpc', name: '10X App', appId: '999', configuredType: 'COMPETING' },
  ] as DisplayTypeCandidate[]).sort((a, b) => (a.kind === 'game' ? 0 : 1) - (b.kind === 'game' ? 0 : 1))
  const dt = assignDisplayTypes(inputs)
  const types = [dt.get('s1'), dt.get('s2'), dt.get('s3'), dt.get('game:gta-vi'), dt.get('app_rpc')]
  const tripleOf = (k: string) => {
    const c = inputs.find(i => i.key === k)!
    return `${dt.get(k)}|${c.appId ?? ''}|${c.name}`
  }
  const triples = ['s1', 's2', 's3', 'game:gta-vi', 'app_rpc'].map(tripleOf)
  check('exactly ONE PLAYING among non-game candidates', types.filter(t => t === 'PLAYING').length === 1)
  // The client dedupes on the (type, application_id, name) TRIPLE — two
  // COMPETING cards with different names/apps render side by side. The
  // invariant that matters is: all TRIPLES distinct.
  check('all five (type, app, name) triples distinct (no client uniqBy collapse)', new Set(triples).size === 5, JSON.stringify(triples))
  check('game pinned PLAYING', dt.get('game:gta-vi') === 'PLAYING')
}

// ─── 4. App-daemon order parity: games-first both sides → same app_rpc type ──
console.log('\n[4] app_rpc assignment parity (rpc-daemon vs application-rpc-daemon order)')
{
  const slots: DisplayTypeCandidate[] = [
    { key: 's1', name: 'RPC One', appId: null, configuredType: 'PLAYING' },
    { key: 's2', name: 'RPC Two', appId: null, configuredType: 'PLAYING' },
    { key: 's3', name: 'RPC Three', appId: null, configuredType: 'PLAYING' },
  ]
  const games: DisplayTypeCandidate[] = [
    { key: 'g1', name: 'GTA VI', appId: null, configuredType: 'PLAYING', kind: 'game' },
  ]
  const app: DisplayTypeCandidate = { key: 'app_rpc', name: '10X App', appId: '999', configuredType: 'PLAYING' }
  // rpc-daemon: fullSelection (slots then games) → SORTED games-first.
  const daemonView = assignDisplayTypes([...slots, ...games, app].sort(
    (a, b) => (a.kind === 'game' ? 0 : 1) - (b.kind === 'game' ? 0 : 1)
  ), new Set(['app_rpc']))
  // application-rpc-daemon (Task 107): pushes games FIRST, then slots, then app_rpc.
  const appView = assignDisplayTypes([...games, ...slots, app], new Set(['app_rpc']))
  check('both sides assign app_rpc the SAME type', daemonView.get('app_rpc') === appView.get('app_rpc'),
    `daemon=${daemonView.get('app_rpc')} app=${appView.get('app_rpc')}`)
  check('app_rpc never PLAYING while rotating', appView.get('app_rpc') !== 'PLAYING')
}

// ─── 5. Degenerate same-name config still yields distinct triples ────────────
console.log('\n[5] same-name slots + game (worst case) — no substitute collision')
{
  const inputs: DisplayTypeCandidate[] = [
    { key: 'g1', name: 'GTA VI', appId: null, configuredType: 'PLAYING', kind: 'game' },
    { key: 's1', name: '10X RPC', appId: null, configuredType: 'PLAYING' },
    { key: 's2', name: '10X RPC', appId: null, configuredType: 'PLAYING' },
    { key: 's3', name: '10X RPC', appId: null, configuredType: 'PLAYING' },
  ]
  const dt = assignDisplayTypes(inputs)
  const types = [dt.get('g1'), dt.get('s1'), dt.get('s2'), dt.get('s3')]
  check('all four cards distinct types', new Set(types).size === 4, JSON.stringify(types))
}

console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`)
process.exit(fail > 0 ? 1 : 0)
