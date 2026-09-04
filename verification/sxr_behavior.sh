#!/usr/bin/env bash
# Framework-neutral behavior harness for start-express-react.
#
# Drives the whole HTTP surface (API + SSR + static) with curl only, so an
# Express run and a Fastify run produce transcripts that can be diffed.
#
# Usage: sxr_behavior.sh <base_url> <server_log> <output_file>
set -uo pipefail

BASE="$1"
LOG="$2"
OUT="$3"

CJ="$(mktemp)"          # cookie jar
TMP="$(mktemp -d)"
CSRF="a-b-c-d-e"

: >"$OUT"

norm() {
  LC_ALL=C tr -c '[:print:]\n' '.' | LC_ALL=C sed -E \
    -e 's/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/<UUID>/g' \
    -e 's/[Ee][Yy][Jj][A-Za-z0-9_.-]+/<JWT>/g' \
    -e 's/[0-9a-f]{64}/<TOKEN>/g' \
    -e 's/"stack":"[^"]*"/"stack":"<STACK>"/g' \
    -e 's/\r$//'
}

# say <label> -- prints a section header
say() { printf '\n### %s\n' "$1" >>"$OUT"; }

# req <label> <curl args...> -- prints status, selected headers and body
req() {
  local label="$1"; shift
  local hdr body code
  hdr="$TMP/h"; body="$TMP/b"
  code=$(curl -s -o "$body" -D "$hdr" -w '%{http_code}' "$@")
  {
    printf '%s -> %s\n' "$label" "$code"
    grep -iE '^(content-type|content-range|accept-ranges|cache-control|content-security-policy|x-frame-options|x-content-type-options|set-cookie):' "$hdr" \
      | tr 'A-Z' 'a-z' | sed -E 's/; *expires=[^;]*//' | sort
    printf 'body: '
    head -c 400 "$body"
    printf '\n'
  } | norm >>"$OUT"
}

csrf_hdr=(-H "X-CSRF-Token: $CSRF" -b "__Host-x-csrf-token=$CSRF")

say "health"
req "GET /api/health" "$BASE/api/health"
req "POST /api/health (csrf ok)" -X POST "${csrf_hdr[@]}" -H 'Content-Type: application/json' -d '{"hello":"world"}' "$BASE/api/health"
req "POST /api/health (no csrf)" -X POST -H 'Content-Type: application/json' -d '{"hello":"world"}' "$BASE/api/health"
req "DELETE /api/health (csrf ok)" -X DELETE "${csrf_hdr[@]}" "$BASE/api/health"
req "DELETE /api/health (no csrf)" -X DELETE "$BASE/api/health"
req "PUT /api/health (unrouted method)" -X PUT "${csrf_hdr[@]}" "$BASE/api/health"

say "items (public)"
req "GET /api/items (range 0-9)" -H 'Range: items=0-9' "$BASE/api/items"
req "GET /api/items (no range)" "$BASE/api/items"
req "GET /api/items (range 9999-9999)" -H 'Range: items=9999-9999' "$BASE/api/items"
req "GET /api/items (bad range syntax)" -H 'Range: items=abc' "$BASE/api/items"
req "GET /api/items/1" "$BASE/api/items/1"
req "GET /api/items/NaN" "$BASE/api/items/NaN"

say "items (unauthenticated writes)"
req "POST /api/items (no auth)" -X POST "${csrf_hdr[@]}" -H 'Content-Type: application/json' -d '{"title":"x"}' "$BASE/api/items"
req "PUT /api/items/1 (no auth)" -X PUT "${csrf_hdr[@]}" -H 'Content-Type: application/json' -d '{"title":"x"}' "$BASE/api/items/1"
req "DELETE /api/items/1 (no auth)" -X DELETE "${csrf_hdr[@]}" "$BASE/api/items/1"

say "users (unauthenticated)"
req "GET /api/users/me (no auth)" "$BASE/api/users/me"
req "PUT /api/users/me (no auth)" -X PUT "${csrf_hdr[@]}" -H 'Content-Type: application/json' -d '{"email":"a@b.c","name":"n"}' "$BASE/api/users/me"
req "DELETE /api/users/me (no auth)" -X DELETE "${csrf_hdr[@]}" "$BASE/api/users/me"
req "POST /api/users/me/avatar (no auth)" -X POST "${csrf_hdr[@]}" "$BASE/api/users/me/avatar"

say "auth"
req "POST /api/auth/magic-link (empty body)" -X POST "${csrf_hdr[@]}" -H 'Content-Type: application/json' -d '{}' "$BASE/api/auth/magic-link"
req "POST /api/auth/verify (empty body)" -X POST "${csrf_hdr[@]}" -H 'Content-Type: application/json' -d '{}' "$BASE/api/auth/verify"
req "POST /api/auth/verify (unknown token)" -X POST "${csrf_hdr[@]}" -H 'Content-Type: application/json' -d '{"token":"deadbeef"}' "$BASE/api/auth/verify"
req "POST /api/auth/magic-link (jdoe@mail.com)" -X POST "${csrf_hdr[@]}" -H 'Content-Type: application/json' -d '{"email":"jdoe@mail.com"}' "$BASE/api/auth/magic-link"
sleep 1
TOKEN=$(grep -o 'verify?token=[0-9a-f]*' "$LOG" | tail -1 | cut -d= -f2)
req "POST /api/auth/verify (fresh token)" -X POST "${csrf_hdr[@]}" -c "$CJ" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\"}" "$BASE/api/auth/verify"
req "POST /api/auth/verify (token replay)" -X POST "${csrf_hdr[@]}" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\"}" "$BASE/api/auth/verify"

AUTH=$(grep '__Host-auth' "$CJ" | awk '{print $NF}')
auth_hdr=(-H "X-CSRF-Token: $CSRF" -b "__Host-x-csrf-token=$CSRF; __Host-auth=$AUTH")

say "users (authenticated)"
req "GET /api/users/me" "${auth_hdr[@]}" "$BASE/api/users/me"
req "PUT /api/users/me" -X PUT "${auth_hdr[@]}" -H 'Content-Type: application/json' -d '{"email":"jdoe@mail.com","name":"J. Doe"}' "$BASE/api/users/me"
req "PUT /api/users/me (invalid email)" -X PUT "${auth_hdr[@]}" -H 'Content-Type: application/json' -d '{"email":"not-an-email","name":"x"}' "$BASE/api/users/me"

say "items (authenticated)"
req "POST /api/items (bad body)" -X POST "${auth_hdr[@]}" -H 'Content-Type: application/json' -d '{}' "$BASE/api/items"
req "POST /api/items (ok)" -X POST "${auth_hdr[@]}" -H 'Content-Type: application/json' -d '{"title":"harness item"}' "$BASE/api/items"
NEWID=$(curl -s -X POST "${auth_hdr[@]}" -H 'Content-Type: application/json' -d '{"title":"harness item 2"}' "$BASE/api/items" | tr -dc '0-9')
req "PUT /api/items/<new> (owner)" -X PUT "${auth_hdr[@]}" -H 'Content-Type: application/json' -d '{"title":"harness edited"}' "$BASE/api/items/$NEWID"
req "GET /api/items/<new> after edit" "$BASE/api/items/$NEWID"
req "PUT /api/items/2 (not owner)" -X PUT "${auth_hdr[@]}" -H 'Content-Type: application/json' -d '{"title":"nope"}' "$BASE/api/items/2"
req "DELETE /api/items/2 (not owner)" -X DELETE "${auth_hdr[@]}" "$BASE/api/items/2"
req "PUT /api/items/NaN (not found)" -X PUT "${auth_hdr[@]}" -H 'Content-Type: application/json' -d '{"title":"x"}' "$BASE/api/items/NaN"
req "DELETE /api/items/NaN (idempotent)" -X DELETE "${auth_hdr[@]}" "$BASE/api/items/NaN"
req "DELETE /api/items/<new>" -X DELETE "${auth_hdr[@]}" "$BASE/api/items/$NEWID"
req "GET /api/items/<new> after delete" "$BASE/api/items/$NEWID"

say "avatar"
printf 'RIFF$\0\0\0WEBPVP8 \x18\0\0\x000\x01\0\x9d\x01\x2a\x01\0\x01\0\x03\0\x34\x25\xa4\0\x03p\0\xfe\xfb\x94\0\0' > "$TMP/a.webp"
printf 'plain text' > "$TMP/a.txt"
head -c 3000000 /dev/zero > "$TMP/big.webp"
req "POST /api/users/me/avatar (no file)" -X POST "${auth_hdr[@]}" "$BASE/api/users/me/avatar"
req "POST /api/users/me/avatar (bad type)" -X POST "${auth_hdr[@]}" -F "avatar=@$TMP/a.txt;type=text/plain" "$BASE/api/users/me/avatar"
req "POST /api/users/me/avatar (too large)" -X POST "${auth_hdr[@]}" -F "avatar=@$TMP/big.webp;type=image/webp" "$BASE/api/users/me/avatar"
req "POST /api/users/me/avatar (ok)" -X POST "${auth_hdr[@]}" -F "avatar=@$TMP/a.webp;type=image/webp" "$BASE/api/users/me/avatar"
AVATAR=$(curl -s "${auth_hdr[@]}" "$BASE/api/users/me" | sed -E 's/.*"avatar_url":"([^"]*)".*/\1/')
req "GET <avatar url>" "$BASE$AVATAR"
req "GET /uploads/does-not-exist.webp" "$BASE/uploads/does-not-exist.webp"
req "DELETE /api/users/me/avatar" -X DELETE "${auth_hdr[@]}" "$BASE/api/users/me/avatar"
req "GET /api/users/me after avatar delete" "${auth_hdr[@]}" "$BASE/api/users/me"

say "ssr"
req "GET /" "$BASE/"
req "GET /items" "$BASE/items"
req "GET /account (authenticated)" "${auth_hdr[@]}" "$BASE/account"
req "GET /no-such-page" "$BASE/no-such-page"

say "session teardown"
req "POST /api/auth/logout" -X POST "${auth_hdr[@]}" "$BASE/api/auth/logout"
req "DELETE /api/users/me" -X DELETE "${auth_hdr[@]}" "$BASE/api/users/me"
req "GET /api/users/me after account delete" "${auth_hdr[@]}" "$BASE/api/users/me"

rm -rf "$TMP" "$CJ"
