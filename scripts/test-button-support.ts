// 10X RPC — Comprehensive Button Support Verification Test
import { buildPresenceActivities } from '../src/lib/rpc-manager'
import { db } from '../src/lib/db'

async function runButtonTests() {
  console.log('🧪 Starting Button Support Verification Tests...\n')

  // Test 1: Single button payload includes both buttons array and metadata.button_urls
  const singleBtnCfg: any = {
    name: '10X RPC Test',
    type: 'PLAYING',
    platform: 'desktop',
    button1Label: 'Join Discord',
    button1Url: 'https://discord.gg/bZkB6Vb4H',
    enabled: true,
  }

  const act1 = await buildPresenceActivities({ rpcConfig: singleBtnCfg })
  console.log('Act 1:', JSON.stringify(act1, null, 2))
  const rpcAct1: any = act1[0]
  if (!rpcAct1) throw new Error('Failed: Activity was not generated')
  if (!Array.isArray(rpcAct1.buttons) || rpcAct1.buttons.length !== 1) {
    throw new Error('Failed: Expected 1 button in activity.buttons')
  }
  if (rpcAct1.buttons[0].label !== 'Join Discord' || rpcAct1.buttons[0].url !== 'https://discord.gg/bZkB6Vb4H') {
    throw new Error('Failed: Button 1 content mismatch')
  }
  if (!rpcAct1.metadata?.button_urls || rpcAct1.metadata.button_urls[0] !== 'https://discord.gg/bZkB6Vb4H') {
    throw new Error('Failed: metadata.button_urls missing or incorrect')
  }
  console.log('✓ Test 1 Passed: Single button payload formatted correctly with buttons array and metadata.button_urls')

  // Test 2: Two buttons payload includes both
  const twoBtnCfg: any = {
    name: 'Custom App',
    type: 'PLAYING',
    platform: 'desktop',
    button1Label: 'Website',
    button1Url: 'https://10xrpc.com',
    button2Label: 'Join Server',
    button2Url: 'https://discord.gg/server',
    enabled: true,
  }

  const act2 = await buildPresenceActivities({ rpcConfig: twoBtnCfg })
  const rpcAct2: any = act2[0]
  if (rpcAct2.buttons.length !== 2) throw new Error('Failed: Expected 2 buttons')
  if (rpcAct2.metadata.button_urls.length !== 2) throw new Error('Failed: Expected 2 metadata button_urls')
  console.log('✓ Test 2 Passed: Dual buttons payload formatted correctly with both labels and URLs')

  // Test 3: Missing URL or missing label does NOT create incomplete button
  const incompleteCfg: any = {
    name: 'Test Incomplete',
    type: 'PLAYING',
    platform: 'desktop',
    button1Label: 'No URL',
    button1Url: null,
    button2Label: null,
    button2Url: 'https://orphan-url.com',
    enabled: true,
  }

  const act3 = await buildPresenceActivities({ rpcConfig: incompleteCfg })
  const rpcAct3: any = act3[0]
  if (rpcAct3.buttons != null || rpcAct3.metadata?.button_urls != null) {
    throw new Error('Failed: Incomplete buttons should not be included in payload')
  }
  console.log('✓ Test 3 Passed: Incomplete button configs are safely omitted')

  console.log('\n🎉 ALL BUTTON SUPPORT TESTS PASSED WITH 100% SUCCESS!')
}

runButtonTests().catch(err => {
  console.error('❌ Test failed:', err)
  process.exit(1)
})
