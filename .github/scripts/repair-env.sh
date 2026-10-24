#!/usr/bin/env bash
# 10X RPC — repair-env.sh: copy missing production env vars from sibling
# Vercel projects on the same account.
#
# Used by:
#   - deploy.yml  (auto: only when critical env names are missing)
#   - repair-env-copy.yml (manual full run)
#
# Required env:
#   VERCEL_TOKEN      — Vercel API token (repo secret)
#   VERCEL_ORG_ID     — team/user id
#   MAIN_PROJECT_ID   — current project id (VERCEL_PROJECT_ID accepted too)
#   SUMMARY_FILE      — where to append markdown (usually $GITHUB_STEP_SUMMARY)
# Optional env:
#   CRITICAL_VARS     — space-separated names to ensure (default below)
#
# Guarantees: values are copied file→env inside the runner and are NEVER
# printed — neither in logs nor in the summary. Existing env vars are never
# overwritten — only MISSING ones get filled (except the two domain-correct
# vars in the alignment section at the end).
#
# NOTE: GitHub Actions runs steps with `bash -e`; we deliberately switch that
# OFF below — a repair glitch must never fail the whole deploy. The script
# always exits 0 and reports its outcome in the run summary.
set -u
set +e

SUMMARY="${SUMMARY_FILE:?SUMMARY_FILE required}"
TOKEN="${VERCEL_TOKEN:?VERCEL_TOKEN required}"
ORG="${VERCEL_ORG_ID:?VERCEL_ORG_ID required}"
# Accept MAIN_PROJECT_ID or VERCEL_PROJECT_ID (workflows pass the latter).
MAIN_PROJECT_ID="${MAIN_PROJECT_ID:-${VERCEL_PROJECT_ID:-}}"
[ -n "$MAIN_PROJECT_ID" ] || { echo "::error::repair-env.sh: neither MAIN_PROJECT_ID nor VERCEL_PROJECT_ID is set"; exit 1; }
CRITICAL_VARS="${CRITICAL_VARS:-DATABASE_URL DATABASE_URL_UNPOOLED SESSION_SECRET DISCORD_CLIENT_ID DISCORD_CLIENT_SECRET DISCORD_BOT_TOKEN}"

# Diagnostic EXIT trap — if the script dies unexpectedly (fatal expansion,
# set -u kill, CLI crash), record WHERE in the run summary AND as a workflow
# annotation (::error:: lines are visible on the run page even without auth).
trap 'rc=$?; if [ "$rc" -ne 0 ]; then { echo ""; echo "> ⚠️ repair-env.sh exited early: rc=$rc near line ${LINENO:-?}"; } >> "$SUMMARY" 2>/dev/null; echo "::error::repair-env.sh exited rc=$rc near line ${LINENO:-?}" || true; fi; exit $rc' EXIT

missing_names() {
  local missing="" out code body
  out=$(env_api GET "/v9/projects/${MAIN_PROJECT_ID}/env?")
  code=$(printf '%s' "$out" | tail -n1)
  if [ "$code" != 200 ]; then
    echo "::error::repair: env list failed (HTTP $code) — falling back to pulled-file presence" || true
    for v in $CRITICAL_VARS; do
      grep -qE "^${v}=" .env.local 2>/dev/null || missing="$missing $v"
    done
    echo "$missing"
    return 0
  fi
  body=$(printf '%s' "$out" | sed '$d')
  for v in $CRITICAL_VARS; do
    printf '%s' "$body" | python3 -c "
import json,sys
d = json.load(sys.stdin)
sys.exit(0 if any(e.get('key') == '$v' and 'production' in (e.get('target') or []) for e in d.get('envs', [])) else 1)" || missing="$missing $v"
  done
  echo "$missing"
}

present_names() {
  local out=""
  for v in $CRITICAL_VARS; do
    grep -qE "^${v}=" .env.local 2>/dev/null && out="$out $v"
  done
  echo "$out"
}

pull_current() {
  vercel pull --yes --environment=production --token="$TOKEN" >/dev/null 2>&1 || true
}

link_main() {
  mkdir -p .vercel
  printf '{"projectId":"%s","orgId":"%s"}' "$MAIN_PROJECT_ID" "$ORG" > .vercel/project.json
}

# ─── REST-based env upsert (no CLI-version roulette) ────────────────────
# env_api <method> <path> [json] → "code\nbody"
env_api() {
  local method="$1" path="$2" json="${3:-}"
  if [ -n "$json" ]; then
    curl -sS -X "$method" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d "$json" -w $'\n%{http_code}' "https://api.vercel.com${path}teamId=${ORG}" 2>/dev/null
  else
    curl -sS -X "$method" -H "Authorization: Bearer $TOKEN" \
      -w $'\n%{http_code}' "https://api.vercel.com${path}teamId=${ORG}" 2>/dev/null
  fi
}

# env_upsert NAME VALUE → sets/creates the var for production only.
env_upsert() {
  local name="$1" value="$2" out code body id
  out=$(env_api GET "/v9/projects/${MAIN_PROJECT_ID}/env?")
  code=$(printf '%s' "$out" | tail -n1)
  body=$(printf '%s' "$out" | sed '$d')
  if [ "$code" != 200 ]; then
    echo "::error::repair: env list failed (HTTP $code) — cannot upsert $name" || true
    return 1
  fi
  id=$(printf '%s' "$body" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    for e in d.get('envs', []):
        if e.get('key') == '$name' and 'production' in (e.get('target') or []):
            print(e['id']); break
except Exception:
    pass")
  if [ -n "$id" ]; then
    out=$(env_api DELETE "/v9/projects/${MAIN_PROJECT_ID}/env/${id}?")
    code=$(printf '%s' "$out" | tail -n1)
    if [ "$code" != 200 ]; then
      echo "::error::repair: env delete failed for $name (HTTP $code)" || true
      return 1
    fi
  fi
  out=$(env_api POST "/v10/projects/${MAIN_PROJECT_ID}/env?" "{\"key\":\"$name\",\"value\":$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$value"),\"type\":\"encrypted\",\"target\":[\"production\"]}")
  code=$(printf '%s' "$out" | tail -n1)
  if [ "$code" = 200 ]; then
    echo "::notice::repair: $name set ✅ (REST)" || true
    return 0
  fi
  body=$(printf '%s' "$out" | sed '$d')
  echo "::error::repair: env add failed for $name (HTTP $code) $(printf '%s' "$body" | head -c 160)" || true
  return 1
}

# env_exists NAME → 0/1 via the REST list (values are never returned by the API)
env_exists() {
  local name="$1" out code body
  out=$(env_api GET "/v9/projects/${MAIN_PROJECT_ID}/env?")
  code=$(printf '%s' "$out" | tail -n1)
  [ "$code" = 200 ] || return 1
  body=$(printf '%s' "$out" | sed '$d')
  printf '%s' "$body" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    sys.exit(0 if any(e.get('key') == '$name' and 'production' in (e.get('target') or []) for e in d.get('envs', [])) else 1)
except Exception:
    sys.exit(1)" && return 0 || return 1
}

link_main
pull_current

MISSING=$(missing_names | xargs)
COPIED=""

echo "::notice::repair: missing=[${MISSING:-none}]" || true

if [ -z "$MISSING" ]; then
  {
    echo "### Env auto-repair: nothing to do"
    echo ""
    echo "All critical env vars present — no changes made."
    echo ""
  } >> "$SUMMARY"
  exit 0
fi

echo "### Env auto-repair — missing names: $(echo "$MISSING" | tr ' ' '\n' | sed 's/^/`/;s/$/`/' | tr '\n' ' ')" >> "$SUMMARY"
echo "" >> "$SUMMARY"
echo "Searching sibling projects on the account (names only — values are never shown):" >> "$SUMMARY"
echo "" >> "$SUMMARY"

vercel projects ls --json --token="$TOKEN" > /tmp/projects.json 2>/dev/null || echo "[]" > /tmp/projects.json
python3 - <<'PYEOF' > /tmp/siblings.tsv
import json
try:
    data = json.load(open('/tmp/projects.json'))
except Exception:
    data = []
projects = data.get('projects', data) if isinstance(data, dict) else data
for p in projects:
    pid = p.get('id')
    name = p.get('name')
    if pid and name:
        print(f"{pid}\t{name}")
PYEOF
grep -v "^${MAIN_PROJECT_ID}$(printf '\t')" /tmp/siblings.tsv > /tmp/siblings.filtered || true
mv /tmp/siblings.filtered /tmp/siblings.tsv

if [ ! -s /tmp/siblings.tsv ]; then
  echo "- (no sibling projects found)" >> "$SUMMARY"
  exit 0
fi

while IFS="$(printf '\t')" read -r PID PNAME; do
  echo "- \`$PNAME\`" >> "$SUMMARY"
  [ -z "$MISSING" ] && break
  printf '{"projectId":"%s","orgId":"%s"}' "$PID" "$ORG" > .vercel/project.json
  if ! vercel pull --yes --environment=production --file=/tmp/sibling.env --token="$TOKEN" >/dev/null 2>&1; then
    continue
  fi
  NEW_MISSING=""
  for v in $MISSING; do
    if grep -qE "^${v}=" /tmp/sibling.env 2>/dev/null; then
      VALUE=$(grep -E "^${v}=" /tmp/sibling.env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')
      if [ -n "$VALUE" ]; then
        link_main
        if env_upsert "$v" "$VALUE"; then
          echo "  - copied \`$v\` ✅" >> "$SUMMARY"
          COPIED="$COPIED $v"
        else
          echo "  - \`$v\` ❌ failed to set (see logs)" >> "$SUMMARY"
          NEW_MISSING="$NEW_MISSING $v"
        fi
        printf '{"projectId":"%s","orgId":"%s"}' "$PID" "$ORG" > .vercel/project.json
      else
        NEW_MISSING="$NEW_MISSING $v"
      fi
    else
      NEW_MISSING="$NEW_MISSING $v"
    fi
  done
  MISSING="$NEW_MISSING"
  rm -f /tmp/sibling.env
done < /tmp/siblings.tsv

echo "::notice::repair: copied=[${COPIED:-none}] remaining=[${MISSING:-none}]" || true

link_main
pull_current

echo "" >> "$SUMMARY"
if [ -n "$COPIED" ]; then
  echo "Copied from siblings: $(echo "${COPIED# }" | tr ' ' '\n' | sed 's/^/`/;s/$/`/' | tr '\n' ' ')" >> "$SUMMARY"
else
  echo "No sibling project had the missing values." >> "$SUMMARY"
fi
REMAINING=$(missing_names | xargs)
if [ -n "$REMAINING" ]; then
  echo "" >> "$SUMMARY"
  echo "**Still missing:** $(echo "${REMAINING# }" | tr ' ' '\n' | sed 's/^/`/;s/$/`/' | tr '\n' ' ')" >> "$SUMMARY"
  echo "" >> "$SUMMARY"
  echo "Add these values as GitHub repo secrets (SAME names) and run **Fix production env (set missing vars + redeploy)**." >> "$SUMMARY"
fi

# ─── SESSION_SECRET self-service ─────────────────────────────────────────
# If it's still missing (no sibling had it), generate a fresh one right here —
# the user never needs to supply it. Only generated when absent (a rotation
# would log every existing session out).
if echo "$MISSING" | grep -qw "SESSION_SECRET"; then
  GEN=$(openssl rand -base64 48 | tr -d '\n')
  if [ -n "$GEN" ] && env_upsert SESSION_SECRET "$GEN"; then
    echo "- \`SESSION_SECRET\` ✅ generated fresh (48-byte random)" >> "$SUMMARY"
    MISSING=$(echo "$MISSING" | tr ' ' '\n' | grep -vx "SESSION_SECRET" | tr '\n' ' ' | xargs)
    COPIED="$COPIED SESSION_SECRET"
  else
    echo "- \`SESSION_SECRET\` ❌ generation failed — set it manually" >> "$SUMMARY"
  fi
fi

# ─── Domain alignment ────────────────────────────────────────────────────
# These two MUST match the live custom domain or OAuth lands users on a dead
# host. Safe to refresh on every repair: the values are derived, not secret.
CANONICAL_URL="https://www.10xrpc.shop"
CANONICAL_REDIRECT="https://www.10xrpc.shop/auth/callback"
need_url=1
need_redirect=1
grep -qE "^NEXT_PUBLIC_APP_URL=\"?${CANONICAL_URL}\"?" .env.local 2>/dev/null && need_url=0
grep -qE "^DISCORD_REDIRECT_URI=\"?${CANONICAL_REDIRECT}\"?" .env.local 2>/dev/null && need_redirect=0
if [ "$need_url" = 1 ] || [ "$need_redirect" = 1 ]; then
  echo "" >> "$SUMMARY"
  echo "Domain alignment:" >> "$SUMMARY"
  for pair in "NEXT_PUBLIC_APP_URL:$CANONICAL_URL:$need_url" "DISCORD_REDIRECT_URI:$CANONICAL_REDIRECT:$need_redirect"; do
    name="${pair%%:*}"; rest="${pair#*:}"; value="${rest%:*}"; need="${rest##*:}"
    if [ "$need" = 1 ]; then
      if env_upsert "$name" "$value"; then
        echo "- \`$name\` ✅ aligned to $value" >> "$SUMMARY"
      else
        echo "- \`$name\` ❌ failed to align (set it manually to \`$value\`)" >> "$SUMMARY"
      fi
    fi
  done
fi

echo "::notice::repair: alignment done (url=$need_url redirect=$need_redirect)" || true

echo "" >> "$SUMMARY"
exit 0
