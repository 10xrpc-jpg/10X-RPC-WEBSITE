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
#   MAIN_PROJECT_ID   — current project id
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
MAIN_PROJECT_ID="${MAIN_PROJECT_ID:?MAIN_PROJECT_ID required}"
CRITICAL_VARS="${CRITICAL_VARS:-DATABASE_URL DATABASE_URL_UNPOOLED SESSION_SECRET DISCORD_CLIENT_ID DISCORD_CLIENT_SECRET DISCORD_BOT_TOKEN}"

# Diagnostic EXIT trap — if the script dies unexpectedly (fatal expansion,
# set -u kill, CLI crash), record WHERE in the run summary AND as a workflow
# annotation (::error:: lines are visible on the run page even without auth).
trap 'rc=$?; if [ "$rc" -ne 0 ]; then { echo ""; echo "> ⚠️ repair-env.sh exited early: rc=$rc near line ${LINENO:-?}"; } >> "$SUMMARY" 2>/dev/null; echo "::error::repair-env.sh exited rc=$rc near line ${LINENO:-?}" || true; fi; exit $rc' EXIT

missing_names() {
  local missing=""
  for v in $CRITICAL_VARS; do
    grep -qE "^${v}=" .env.local 2>/dev/null || missing="$missing $v"
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
        vercel env rm "$v" production --yes --token="$TOKEN" >/dev/null 2>&1 || true
        if printf '%s' "$VALUE" | vercel env add "$v" production --token="$TOKEN" >/dev/null 2>&1; then
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
  echo "Copied from siblings: $(echo "$COPIED" | tr ' ' '\n' | sed 's/^/`/;s/$/`/' | tr '\n' ' ')" >> "$SUMMARY"
else
  echo "No sibling project had the missing values." >> "$SUMMARY"
fi
REMAINING=$(missing_names | xargs)
if [ -n "$REMAINING" ]; then
  echo "" >> "$SUMMARY"
  echo "**Still missing:** $(echo "$REMAINING" | tr ' ' '\n' | sed 's/^/`/;s/$/`/' | tr '\n' ' ')" >> "$SUMMARY"
  echo "" >> "$SUMMARY"
  echo "Add these values as GitHub repo secrets (SAME names) and run **Fix production env (set missing vars + redeploy)**." >> "$SUMMARY"
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
      vercel env rm "$name" production --yes --token="$TOKEN" >/dev/null 2>&1
      if printf '%s' "$value" | vercel env add "$name" production --token="$TOKEN" >/dev/null 2>&1; then
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
