# DNS setup — 10xrpc.shop → production website

Goal: make **https://10xrpc.shop** (and **https://www.10xrpc.shop**) serve the
10X RPC website that deploys to Vercel on every push to `main`.

Current facts (checked 2026-10-24):

| Thing | State |
|---|---|
| Registrar / DNS host | **BigRock** — nameservers `dns1–dns4.bigrock.in` |
| Existing records | **None** (domain points nowhere yet) |
| Production host | **Vercel** (auto-deploy from this repo's `main` branch) |
| Old URL | `https://10x-rpc.vercel.app` (currently `DEPLOYMENT_NOT_FOUND` — a redeploy from `main` restores it) |

---

## Step 1 — Add the domain on the Vercel side (automated ✅)

The **Deploy to Vercel** workflow now attaches `10xrpc.shop` + `www.10xrpc.shop`
to the project automatically on every deploy (uses the existing
`VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` repo secrets) and prints
the expected DNS records + verification state in the run summary.

`www.10xrpc.shop` is attached with a **redirect to the apex**, so
`https://10xrpc.shop` is the canonical URL.

Nothing to do manually here — the next push to `main` (or a manual
*Actions → Deploy to Vercel* run) does it.

## Step 2 — Add DNS records at BigRock (manual, ~2 minutes)

1. Log in at **manage.bigrock.in**.
2. **Domains → My Domains → 10xrpc.shop → DNS Management (Manage DNS)**.
3. Add exactly two records (delete any conflicting A/CNAME for the same hosts first):

| Type | Host Name | Value | TTL |
|---|---|---|---|
| **A** | `@` | `216.198.79.195` | 1 Hour (or default) |
| **CNAME** | `www` | `cname.vercel-dns.com` | 1 Hour (or default) |

> `216.198.79.195` is Vercel's current recommended apex address. The legacy
> `76.76.21.21` also works — either is accepted, don't add both unless Vercel's
> run summary says so.
> BigRock does **not** support CNAME flattening at the apex — use the **A**
> record for `@` exactly as above.

### Alternative (one-time switch, then Vercel manages everything)

Instead of maintaining records at BigRock you can switch the domain's
**nameservers** at BigRock to:

```
ns1.vercel-dns.com
ns2.vercel-dns.com
```

Then Vercel hosts the zone and auto-creates the needed records once the domain
is attached to the project (Step 1). Choose this only if you don't need other
BigRock DNS entries (MX/mail etc.) — moving NS moves the whole zone.

## Step 3 — Verify

- **Actions → Check DNS for 10xrpc.shop → Run workflow** — resolves the domain
  from GitHub's runners and probes HTTPS; the run summary shows a pass/fail
  table.
- Or locally: `dig +short 10xrpc.shop A` → `216.198.79.195`, and open
  https://10xrpc.shop.

Propagation: minutes up to 48h (BigRock default TTL 1–2h). Vercel issues the
TLS certificate automatically once records resolve — first visit may take a
few extra seconds while the cert is minted.

## Step 4 — After the domain goes live (important)

1. **Vercel env**: set `NEXT_PUBLIC_APP_URL=https://10xrpc.shop` (project →
   Settings → Environment Variables → Production), then redeploy.
2. **Discord OAuth**: in the [Discord developer portal](https://discord.com/developers/applications)
   add/update the redirect URI to `https://10xrpc.shop/auth/callback` (keep the
   old one until the switch is confirmed). Mirror it in the Vercel env var
   `DISCORD_REDIRECT_URI`.
3. **Razorpay dashboard**: add `https://10xrpc.shop` to allowed origins/redirect
   domains if the old `.vercel.app` URL was listed there.

## Troubleshooting

- **Run summary says `verified: false`** → records not visible to Vercel yet;
  wait for propagation, then re-run the DNS check workflow.
- **`misconfigured: true`** → a conflicting record exists (e.g. a parked-domain
  A record BigRock pre-created). Delete it and keep only the two records above.
- **Deploy workflow fails with a Vercel API 404** → the `VERCEL_PROJECT_ID`
  secret points at a deleted/renamed project. Recreate the project on Vercel
  and update the three repo secrets.
- **Old `10x-rpc.vercel.app` shows `DEPLOYMENT_NOT_FOUND`** → no production
  deployment exists. Trigger *Actions → Deploy to Vercel* (branch `main`); the
  same run re-attaches the custom domains.
