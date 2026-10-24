# 10X RPC — 24/7 Node Kit

Everything a fresh hosting-panel server (e.g. panel.softhost.net) needs to run
one 24/7 daemon node. The kit is self-provisioning: **first boot runs
`npm install` + `prisma generate` automatically** — no build step, no
node_modules upload.

## What's inside (built by the "Build node kit" GitHub workflow)

| Path | Purpose |
|---|---|
| `index.js` | Supervisor — spawns the daemon child, watchdog, `/health` + `/sync` |
| `package.json` | Runtime deps ONLY: `@prisma/client`, `prisma`, `tsx`, `ws`, `dotenv` |
| `tsconfig.json` | Minimal TS config (`@/*` → `src/*` path alias for tsx) |
| `env.example` | Server config template → rename to `.env` and edit |
| `prisma/schema.prisma` | Database schema (client is generated at first boot) |
| `scripts/rpc-daemon-standalone.ts` | The daemon child entrypoint |
| `scripts/failover-decisions.js` | Pillar-failover decision core |
| `src/lib/**` | The daemon's runtime modules (21 files) |

## Panel setup (panel.softhost.net or any Pterodactyl panel)

1. **Server** — create/reuse a Node.js server (any egg that runs `node` and
   exposes a public allocation). Note its primary **IP:port** (Network tab).
2. **Upload** — panel → Files → upload `10x-node-kit.zip` → **Extract** here
   (the files must land in the server ROOT, `index.js` next to the panel's
   default files is fine). Delete the archive afterwards.
3. **Configure** — Files → copy `env.example` to `.env` → edit:
   - `DATABASE_URL` + `DATABASE_URL_UNPOOLED` — your production Postgres
     (Neon: prefer the **pooled** URL in `DATABASE_URL` and the **unpooled**
     one in `DATABASE_URL_UNPOOLED` — the supervisor gives long-lived daemon
     children the direct endpoint automatically).
   - `DAEMON_ROLE` — `status` / `rpc` / `game` (multi-node split) or `all`
     (single node).
   - `DAEMON_SYNC_SECRET` — the value from the website admin dashboard:
     **Admin → Settings → Backend Nodes → Instant-sync secret** (reveal/copy).
4. **Start** — press Start. First boot shows:
   `First boot detected — installing runtime dependencies…` then
   `Generating Prisma client…` then the 10X RPC banner + daemon child spawn.
   (2–5 minutes on free plans; later boots are instant.)
5. **Verify** — open `http://<IP>:<PORT>/health` in a browser → must return
   `{"status":"ok",...}` with a fresh `daemon.heartbeatAgeSec`.
6. **Wire into the website** — Admin → Settings → Backend Nodes → paste
   `http://<IP>:<PORT>` → Save nodes → **Health check** must be green.
   Done — instant presence syncs and the uptime page use the node immediately.

## Notes

- The panel's Cloudflare protection only covers the panel website — the
  server's allocation (`IP:port`) is reachable directly; that is the URL the
  dashboard needs.
- Keep `.env` **out of any public repo** — it contains the database URL.
- Update the node later by re-downloading the newest kit and re-extracting
  (keep `.env`), then press Restart.
