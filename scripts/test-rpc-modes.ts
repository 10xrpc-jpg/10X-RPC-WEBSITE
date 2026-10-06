// Task 16 — unit test: Normal RPC vs Gamer RPC mutual exclusivity + config isolation
import { selectActiveRpc, buildPresenceActivities } from '../src/lib/rpc-manager'
import { GAME_SPOOF } from '../src/lib/games'

function assert(cond: boolean, label: string) {
  if (!cond) throw new Error(`FAIL: ${label}`)
  console.log(`PASS: ${label}`)
}

async function main() {
  const normalCfg = {
    id: 'rpc1', userId: 'u1', name: 'Visual Studio Code', type: 'PLAYING', platform: 'desktop',
    state: 'Editing page.tsx', details: 'Workspace: 10X RPC', enabled: true, startMinsAgo: 0,
  } as any
  const gameCfg = {
    id: 'g1', userId: 'u1', gameSlug: 'minecraft', gameName: 'Minecraft', enabled: true,
    platform: 'xbox', state: 'Survival', details: 'Survival Mode', startMinsAgo: 0,
  } as any

  // 1. GAME MODE WINS when a game is enabled — daemon uses ONLY the game's own config
  const s1 = selectActiveRpc(true, normalCfg, gameCfg)
  assert(s1.active && s1.mode === 'game', 'game enabled → mode=game, active')
  assert(s1.config?.name === 'Minecraft', 'game mode config name = gameName (Minecraft)')
  assert(s1.config?.platform === 'xbox', 'game mode config platform = GameConfig platform')
  assert(s1.config?.details === 'Survival Mode', 'game mode uses GameConfig details (not normal details)')
  assert(s1.gameSlug === 'minecraft', 'game mode exposes slug for spoofing')
  assert(!(s1.config as any).state?.includes?.('page.tsx'), 'no normal-config field leaked into game mode')

  // 2. NORMAL MODE when no game enabled + RpcConfig.enabled
  const s2 = selectActiveRpc(true, normalCfg, null)
  assert(s2.active && s2.mode === 'normal', 'no game + normal enabled → mode=normal')
  assert(s2.config?.name === 'Visual Studio Code', 'normal mode uses RpcConfig fields')
  assert(s2.gameSlug === null, 'normal mode never spoofs (slug null)')

  // 3. NORMAL ENABLED → GAME AUTO-DISABLED semantics: game row disabled → normal owns presence
  const s3 = selectActiveRpc(true, normalCfg, { ...gameCfg, enabled: false })
  assert(s3.active && s3.mode === 'normal', 'game disabled → normal mode active')

  // 4. GAME ENABLED → NORMAL AUTO-DISABLED semantics: RpcConfig.enabled=false, game owns presence
  const s4 = selectActiveRpc(true, { ...normalCfg, enabled: false }, gameCfg)
  assert(s4.active && s4.mode === 'game', 'normal disabled + game enabled → game mode active')

  // 5. Master OFF → nothing active (both configs stay remembered)
  const s5 = selectActiveRpc(false, normalCfg, null)
  assert(!s5.active && s5.mode === 'normal', 'master off → inactive (mode data still normal)')
  const s5b = selectActiveRpc(false, normalCfg, gameCfg)
  assert(!s5b.active && s5b.mode === 'game', 'master off + game enabled → inactive (game data kept)')

  // 6. Nothing enabled → null mode
  const s6 = selectActiveRpc(true, { ...normalCfg, enabled: false }, null)
  assert(!s6.active && s6.mode === null && s6.config === null, 'nothing enabled → mode null')

  // 7. End-to-end: game mode presence uses ONLY GameConfig fields + spoof app identity
  const acts = await buildPresenceActivities({
    rpcConfig: selectActiveRpc(true, normalCfg, gameCfg).config,
    placeholderCtx: { timezone: 'UTC', rpcStartedAt: Date.now() },
    selectedGameSlug: selectActiveRpc(true, normalCfg, gameCfg).gameSlug,
  })
  const rpc = acts.find(a => (a as any).type !== 4) as any
  assert(rpc?.application_id === GAME_SPOOF['minecraft'].appId, 'game mode presence spoofed to official Minecraft app')
  assert(rpc?.name === 'Minecraft', 'game mode presence name = Minecraft')
  assert(rpc?.state === 'Survival', 'game mode presence state from GameConfig')

  // 8. End-to-end: normal mode presence uses ONLY RpcConfig fields, NO spoof
  const acts2 = await buildPresenceActivities({
    rpcConfig: selectActiveRpc(true, normalCfg, null).config,
    placeholderCtx: { timezone: 'UTC', rpcStartedAt: Date.now() },
    selectedGameSlug: null,
  })
  const rpc2 = acts2.find(a => (a as any).type !== 4) as any
  assert(rpc2?.name === 'Visual Studio Code' && !rpc2?.application_id, 'normal mode presence = RpcConfig, no spoofing')
  assert(rpc2?.state === 'Editing page.tsx', 'normal mode state from RpcConfig')

  console.log('\nALL TESTS PASSED (8/8 scenarios)')
}

main().catch(e => { console.error(e); process.exit(1) })
