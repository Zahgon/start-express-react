#!/usr/bin/env bash
# Framework-neutral peer-to-peer round-trip harness for start-express-react.
#
# Two peers (independent sessions, independent accounts, independent CSRF
# tokens) exchange state through the shared server: A publishes an item, B
# observes it, B is refused ownership-scoped mutations, each peer sees the
# other's writes, and deletions propagate both ways. Drives real HTTP with
# curl only, so an Express run and a Fastify run can be diffed.
#
# Usage: sxr_p2p.sh <base_url> <server_log> <output_file>
set -uo pipefail

BASE="$1"
LOG="$2"
OUT="$3"

TMP="$(mktemp -d)"
: >"$OUT"

norm() {
  LC_ALL=C tr -c '[:print:]\n' '.' | LC_ALL=C sed -E \
    -e 's/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/<UUID>/g' \
    -e 's/[Ee][Yy][Jj][A-Za-z0-9_.-]+/<JWT>/g' \
    -e 's/[0-9a-f]{64}/<TOKEN>/g' \
    -e 's/"stack":"[^"]*"/"stack":"<STACK>"/g' \
    -e 's/\r$//'
}

say() { printf '\n### %s\n' "$1" >>"$OUT"; }

# req <label> <curl args...>
req() {
  local label="$1"; shift
  local code
  code=$(curl -s -o "$TMP/b" -w '%{http_code}' "$@")
  { printf '%s -> %s\nbody: ' "$label" "$code"; head -c 300 "$TMP/b"; printf '\n'; } | norm >>"$OUT"
}

# login <email> <csrf-token> -- echoes the auth cookie value
login() {
  local email="$1" tok="$2" jar="$TMP/jar-$2"
  curl -s -o /dev/null -X POST -H "X-CSRF-Token: $tok" -b "__Host-x-csrf-token=$tok" \
    -H 'Content-Type: application/json' -d "{\"email\":\"$email\"}" "$BASE/api/auth/magic-link"
  sleep 1
  local magic
  magic=$(grep -o 'verify?token=[0-9a-f]*' "$LOG" | tail -1 | cut -d= -f2)
  curl -s -o /dev/null -c "$jar" -X POST -H "X-CSRF-Token: $tok" -b "__Host-x-csrf-token=$tok" \
    -H 'Content-Type: application/json' -d "{\"token\":\"$magic\"}" "$BASE/api/auth/verify"
  grep '__Host-auth' "$jar" | awk '{print $NF}'
}

say "peer sessions"
A_TOKEN="peer-a-csrf"
B_TOKEN="peer-b-csrf"
A_AUTH=$(login "jdoe@mail.com" "$A_TOKEN")
B_AUTH=$(login "peer-b@mail.com" "$B_TOKEN")
A=(-H "X-CSRF-Token: $A_TOKEN" -b "__Host-x-csrf-token=$A_TOKEN; __Host-auth=$A_AUTH")
B=(-H "X-CSRF-Token: $B_TOKEN" -b "__Host-x-csrf-token=$B_TOKEN; __Host-auth=$B_AUTH")

req "A identity" "${A[@]}" "$BASE/api/users/me"
req "B identity" "${B[@]}" "$BASE/api/users/me"

say "A publishes, B observes"
A_CREATE=$(curl -s -X POST "${A[@]}" -H 'Content-Type: application/json' -d '{"title":"from peer A"}' "$BASE/api/items")
printf 'A creates item -> %s\n' "$A_CREATE" | norm >>"$OUT"
A_ITEM=$(printf '%s' "$A_CREATE" | tr -dc '0-9')
req "B reads A's item" "${B[@]}" "$BASE/api/items/$A_ITEM"
req "B lists items" -H 'Range: items=0-99' "${B[@]}" "$BASE/api/items"

say "ownership is enforced across peers"
req "B edits A's item" -X PUT "${B[@]}" -H 'Content-Type: application/json' -d '{"title":"hijacked"}' "$BASE/api/items/$A_ITEM"
req "B deletes A's item" -X DELETE "${B[@]}" "$BASE/api/items/$A_ITEM"
req "A re-reads own item (unchanged)" "${A[@]}" "$BASE/api/items/$A_ITEM"

say "B publishes, A observes"
B_CREATE=$(curl -s -X POST "${B[@]}" -H 'Content-Type: application/json' -d '{"title":"from peer B"}' "$BASE/api/items")
printf 'B creates item -> %s\n' "$B_CREATE" | norm >>"$OUT"
B_ITEM=$(printf '%s' "$B_CREATE" | tr -dc '0-9')
req "A reads B's item" "${A[@]}" "$BASE/api/items/$B_ITEM"
req "A edits B's item" -X PUT "${A[@]}" -H 'Content-Type: application/json' -d '{"title":"hijacked"}' "$BASE/api/items/$B_ITEM"

say "writes propagate to the other peer"
req "A edits own item" -X PUT "${A[@]}" -H 'Content-Type: application/json' -d '{"title":"from peer A v2"}' "$BASE/api/items/$A_ITEM"
req "B sees A's edit" "${B[@]}" "$BASE/api/items/$A_ITEM"
req "B edits own item" -X PUT "${B[@]}" -H 'Content-Type: application/json' -d '{"title":"from peer B v2"}' "$BASE/api/items/$B_ITEM"
req "A sees B's edit" "${A[@]}" "$BASE/api/items/$B_ITEM"

say "cross-peer CSRF isolation"
req "B's auth cookie without CSRF header" -X PUT -b "__Host-auth=$B_AUTH" -H 'Content-Type: application/json' -d '{"title":"x"}' "$BASE/api/items/$B_ITEM"
req "B's auth cookie with mismatched CSRF pair" -X PUT -H "X-CSRF-Token: $A_TOKEN" -b "__Host-x-csrf-token=$B_TOKEN; __Host-auth=$B_AUTH" -H 'Content-Type: application/json' -d '{"title":"x"}' "$BASE/api/items/$B_ITEM"
req "A's CSRF token with B's auth cookie (stateless: allowed)" -X PUT -H "X-CSRF-Token: $A_TOKEN" -b "__Host-x-csrf-token=$A_TOKEN; __Host-auth=$B_AUTH" -H 'Content-Type: application/json' -d '{"title":"from peer B v3"}' "$BASE/api/items/$B_ITEM"

say "deletions propagate"
req "A deletes own item" -X DELETE "${A[@]}" "$BASE/api/items/$A_ITEM"
req "B reads deleted item" "${B[@]}" "$BASE/api/items/$A_ITEM"
req "B deletes own item" -X DELETE "${B[@]}" "$BASE/api/items/$B_ITEM"
req "A reads deleted item" "${A[@]}" "$BASE/api/items/$B_ITEM"
req "final listing" -H 'Range: items=0-99' "$BASE/api/items"

say "session teardown is per-peer"
req "B logs out" -X POST "${B[@]}" "$BASE/api/auth/logout"
req "A still authenticated" "${A[@]}" "$BASE/api/users/me"

rm -rf "$TMP"
