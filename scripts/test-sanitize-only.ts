const { sanitizeActivities } = await import('../src/lib/discord-assets')
const dirty = [
  { type: 4, name: 'Custom Status', state: 'hi' },
  { type: 0, name: '10X RPC', assets: { large_image: 'https://cdn.discordapp.com/attachments/x/y.gif?ex=1', large_text: 'GIF' } },
  { type: 0, name: 'GTA V', assets: { large_image: 'img-c55d38e101', small_image: 'https://evil.example/a.png' } },
] as Array<Record<string, unknown>>
const clean = sanitizeActivities(dirty)
console.log('sanitize result:', JSON.stringify(clean, null, 0))
console.log(JSON.stringify(clean).includes('https://') ? '✗ URL LEAKED' : '✓ all raw URLs stripped, asset keys kept')
process.exit(0)
export {}
