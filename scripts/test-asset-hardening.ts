// Diagnostic: verify the wire-format asset resolver end-to-end (offline logic).
// Usage: npx tsx scripts/test-asset-hardening.ts
const { resolveAssetRef, sanitizeActivities } = await import('../src/lib/discord-assets')

const EXPIRED_URL = 'https://cdn.discordapp.com/attachments/1543677777872687277/1555635779898704033/lv_0_20260721093239.gif?backend=b2&ex=6ac3e138&is=6ac28fb8&hm=7437e723f811dbdd768794fd2ae076ae56241f91f0cc06acf576b5fb597769cb&'

async function main() {
  console.log('--- sanitizeActivities keeps wire formats, strips raw URLs ---')
  const activities = [
    { name: 'ok', assets: { large_image: '1556496377242984529' } },                       // asset ID → kept
    { name: 'ok2', assets: { large_image: 'mp:external/abc/https/x/y.gif' } },            // mp:external → kept
    { name: 'bad', assets: { large_image: 'https://cdn.example.net/a.gif' } },            // raw URL → stripped
    { name: 'legacy', assets: { large_image: 'img-c55d38e101' } },                        // legacy key → kept by sanitizer (resolver upgrades it)
  ] as any
  const out = sanitizeActivities(activities)
  for (const a of out) console.log(`${a.name}: ${JSON.stringify(a.assets ?? null)}`)

  console.log('\n--- resolveAssetRef: wire formats pass through ---')
  console.log('asset id   :', await resolveAssetRef('1556496377242984529'))
  console.log('mp:external:', await resolveAssetRef('mp:external/abc/https/x/y.gif'))

  console.log('\n--- resolveAssetRef: key → asset id (needs bot token) ---')
  console.log('vscode     :', await resolveAssetRef('vscode'))

  console.log('\n--- resolveAssetRef: expired signed URL (needs DB/mirror/user token) ---')
  // Without a user token this resolves via DB cache/legacy upload → asset id.
  console.log('expired url:', await resolveAssetRef(EXPIRED_URL))
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

export {}
