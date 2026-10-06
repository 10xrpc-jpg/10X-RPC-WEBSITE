// Task 15 — unit test: game spoof in buildPresenceActivities
import { buildPresenceActivities } from '../src/lib/rpc-manager'
import { GAME_SPOOF } from '../src/lib/games'

async function main() {
  const ctx = { timezone: 'UTC', rpcStartedAt: Date.now() }

  // 1. Minecraft spoof (no user token → no icon, but app_id + name spoofed)
  const mc = await buildPresenceActivities({
    rpcConfig: { name: 'Minecraft', type: 'PLAYING', enabled: true, platform: 'desktop' } as any,
    placeholderCtx: ctx,
    selectedGameSlug: 'minecraft',
  })
  const mcRpc = mc.find(a => (a as any).type !== 4) as any
  console.log('TEST1 minecraft:', JSON.stringify({ app: mcRpc?.application_id, name: mcRpc?.name, assets: mcRpc?.assets }))
  if (mcRpc?.application_id !== GAME_SPOOF['minecraft'].appId) throw new Error('FAIL: minecraft application_id not spoofed')
  if (mcRpc?.name !== 'Minecraft') throw new Error('FAIL: minecraft name wrong')

  // 2. GTA V spoof — const name is "GTA5"
  const gta = await buildPresenceActivities({
    rpcConfig: { name: 'Grand Theft Auto V', type: 'PLAYING', enabled: true, platform: 'desktop' } as any,
    placeholderCtx: ctx,
    selectedGameSlug: 'gta-v',
  })
  const gtaRpc = gta.find(a => (a as any).type !== 4) as any
  console.log('TEST2 gta-v:', JSON.stringify({ app: gtaRpc?.application_id, name: gtaRpc?.name }))
  if (gtaRpc?.application_id !== '1402418714716143646' || gtaRpc?.name !== 'GTA5') throw new Error('FAIL: gta-v spoof wrong')

  // 3. Stale-game guard: slug enabled but custom RPC has a non-preset name → NO spoof
  const custom = await buildPresenceActivities({
    rpcConfig: { name: 'Spotify', type: 'LISTENING', enabled: true, platform: 'desktop' } as any,
    placeholderCtx: ctx,
    selectedGameSlug: 'minecraft',
  })
  const customRpc = custom.find(a => (a as any).type !== 4) as any
  console.log('TEST3 stale-guard:', JSON.stringify({ app: customRpc?.application_id, name: customRpc?.name }))
  if (customRpc?.application_id === GAME_SPOOF['minecraft'].appId) throw new Error('FAIL: stale game spoofed custom RPC')

  // 4. No enabled game → application_id stays 10X client id
  const none = await buildPresenceActivities({
    rpcConfig: { name: 'Minecraft', type: 'PLAYING', enabled: true, platform: 'desktop' } as any,
    placeholderCtx: ctx,
  })
  const noneRpc = none.find(a => (a as any).type !== 4) as any
  console.log('TEST4 no-slug:', JSON.stringify({ app: noneRpc?.application_id, name: noneRpc?.name }))
  if (noneRpc?.application_id === GAME_SPOOF['minecraft'].appId) throw new Error('FAIL: spoofed without slug')

  // 5. All 9 spoof entries present with correct shapes
  const expected: Record<string, string> = {
    'minecraft': '1402418491272986635',
    'genshin-impact': '762434991303950386',
    'wuthering-waves': '1247227126416146462',
    'forza-horizon-5': '905961880789590076',
    'arknights': '1461154307171811401',
    'valorant': '700136079562375258',
    'gta-v': '1402418714716143646',
    'vrchat': '398632010442211348',
    'cs2': '1158877933042143272',
  }
  for (const [slug, appId] of Object.entries(expected)) {
    const e = GAME_SPOOF[slug]
    if (!e || e.appId !== appId || !e.name || !e.icon.startsWith('https://cdn.discordapp.com/app-icons/')) {
      throw new Error(`FAIL: GAME_SPOOF entry invalid for ${slug}`)
    }
  }
  console.log('TEST5 all 9 spoof entries OK')

  // 6. Custom status coexists with spoofed game activity
  const both = await buildPresenceActivities({
    rpcConfig: { name: 'Counter-Strike 2', type: 'PLAYING', enabled: true, platform: 'desktop' } as any,
    customStatus: 'brb dinner',
    placeholderCtx: ctx,
    selectedGameSlug: 'cs2',
  })
  const cs = both.find(a => (a as any).type === 0) as any
  const cst = both.find(a => (a as any).type === 4) as any
  console.log('TEST6 cs2+status:', JSON.stringify({ app: cs?.application_id, name: cs?.name, custom: cst?.state }))
  if (cs?.application_id !== '1158877933042143272' || cst?.state !== 'brb dinner') throw new Error('FAIL: custom status + spoof coexistence')

  // 7. CUSTOM game with an Application ID → spoofed to that application
  const cust = await buildPresenceActivities({
    rpcConfig: { name: 'Elden Ring Nightreign', type: 'PLAYING', enabled: true, platform: 'desktop', largeImage: 'https://cdn.discordapp.com/app-icons/9999/abc.png' } as any,
    placeholderCtx: ctx,
    selectedGameSlug: 'custom-deadbeefdeadbeef',
    selectedGameAppId: '1234567890123456789',
  })
  const custRpc = cust.find(a => (a as any).type !== 4) as any
  console.log('TEST7 custom-appid:', JSON.stringify({ app: custRpc?.application_id, name: custRpc?.name }))
  if (custRpc?.application_id !== '1234567890123456789') throw new Error('FAIL: custom appId not spoofed')
  if (custRpc?.name !== 'Elden Ring Nightreign') throw new Error('FAIL: custom spoof name wrong')

  // 8. CUSTOM game WITHOUT an Application ID → legacy 10X identity (no application_id spoof)
  const plain = await buildPresenceActivities({
    rpcConfig: { name: 'My Game', type: 'PLAYING', enabled: true, platform: 'desktop' } as any,
    placeholderCtx: ctx,
    selectedGameSlug: 'custom-deadbeefdeadbeef',
  })
  const plainRpc = plain.find(a => (a as any).type !== 4) as any
  console.log('TEST8 custom-noid:', JSON.stringify({ app: plainRpc?.application_id, name: plainRpc?.name }))
  if (plainRpc?.application_id) throw new Error('FAIL: spoofed without appId')

  // 9. Preset spoof unaffected by an unrelated custom appId option
  const preset = await buildPresenceActivities({
    rpcConfig: { name: 'Minecraft', type: 'PLAYING', enabled: true, platform: 'desktop' } as any,
    placeholderCtx: ctx,
    selectedGameSlug: 'minecraft',
    selectedGameAppId: '9999999999999999999',
  })
  const presetRpc = preset.find(a => (a as any).type !== 4) as any
  console.log('TEST9 preset-priority:', JSON.stringify({ app: presetRpc?.application_id }))
  if (presetRpc?.application_id !== GAME_SPOOF['minecraft'].appId) throw new Error('FAIL: preset spoof overridden by custom appId')

  console.log('ALL SPOOF TESTS PASSED')
  process.exit(0)
}

main().catch(e => { console.error(e.message); process.exit(1) })
