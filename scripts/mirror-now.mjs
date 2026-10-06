import crypto from 'crypto'
import fs from 'fs'
const rows = [
  'https://cdn.discordapp.com/attachments/1543677777872687277/1555635779898704033/lv_0_20260721093239.gif?backend=b2&ex=6ac3e138&is=6ac28fb8&hm=7437e723f811dbdd768794fd2ae076ae56241f91f0cc06acf576b5fb597769cb&',
  'https://cdn.discordapp.com/attachments/1543677777872687277/1551575153639555163/Picsart_26-08-29_18-01-17-499.jpg?ex=6ac4&is=6ac4&hm=abc',
]
const DIR = 'public/asset-mirror'
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true })
for (const url of rows) {
  const u = new URL(url)
  const hash = crypto.createHash('sha1').update(u.pathname).digest('hex').slice(0, 16)
  const ext = (u.pathname.match(/\.(png|jpe?g|gif|webp)$/i) || [,'png'])[1].toLowerCase().replace('jpeg','jpg')
  const file = `${DIR}/${hash}.${ext}`
  if (fs.existsSync(file)) { console.log(`exists: ${file}`); continue }
  const res = await fetch(url, { headers: { 'User-Agent': '10X-RPC/2.0 (asset mirror)' } })
  if (!res.ok) { console.log(`download failed ${res.status} for ${u.pathname}`); continue }
  const ct = res.headers.get('content-type') || ''
  if (!ct.startsWith('image/')) { console.log(`non-image ${ct}`); continue }
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(file, buf)
  console.log(`mirrored ${u.pathname} → ${file} (${buf.length} bytes, ${ct})`)
}
