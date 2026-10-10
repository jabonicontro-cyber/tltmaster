#!/usr/bin/env bash
# Lightweight local backend for development and CI when the Supabase CLI /
# Docker images are not available:
#   PostgreSQL 15+ (you provide it)  +  Supabase Auth (GoTrue)  +  PostgREST
#   + a tiny gateway that serves them at http://127.0.0.1:54321 like Supabase.
#
# Usage:
#   scripts/dev-stack/stack.sh up        # download binaries, start services
#   scripts/dev-stack/stack.sh db-reset  # recreate schema, run migrations + seed
#   scripts/dev-stack/stack.sh env       # print values for .env.local
#   scripts/dev-stack/stack.sh down
#
# Environment:
#   DEV_PG_URL   superuser connection (default postgres://postgres@127.0.0.1:54322/postgres)
#
# The recommended setup is still `npx supabase start` (see docs/SETUP.md).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE="$ROOT/.dev-stack"
BIN="$STATE/bin"
PG_URL="${DEV_PG_URL:-postgres://postgres@127.0.0.1:54322/postgres}"
PG_HOSTPORT="$(echo "$PG_URL" | sed -E 's#^[a-z]+://[^@]*@([^/]+)/.*#\1#')"
GATEWAY_PORT=54321
AUTH_PORT=9999
REST_PORT=54330
POSTGREST_VERSION=v12.2.12
AUTH_VERSION=v2.180.0

mkdir -p "$STATE" "$BIN"

ensure_binaries() {
  if [[ ! -x "$BIN/postgrest" ]]; then
    echo "Downloading PostgREST $POSTGREST_VERSION…"
    curl -sSfL "https://github.com/PostgREST/postgrest/releases/download/$POSTGREST_VERSION/postgrest-$POSTGREST_VERSION-linux-static-x86-64.tar.xz" \
      | tar -xJ -C "$BIN"
  fi
  if [[ ! -x "$BIN/auth" ]]; then
    echo "Downloading Supabase Auth $AUTH_VERSION…"
    curl -sSfL "https://github.com/supabase/auth/releases/download/$AUTH_VERSION/auth-$AUTH_VERSION-x86.tar.gz" \
      | tar -xz -C "$BIN"
  fi
}

ensure_keys() {
  if [[ ! -f "$STATE/keys.env" ]]; then
    node "$ROOT/scripts/dev-stack/keys.mjs" > "$STATE/keys.env"
  fi
  # shellcheck disable=SC1091
  source "$STATE/keys.env"
}

psql_admin() { PGOPTIONS="-c client_min_messages=warning" psql "$PG_URL" -v ON_ERROR_STOP=1 -q "$@"; }

auth_env() {
  export GOTRUE_DB_DRIVER=postgres
  export DATABASE_URL="postgres://supabase_auth_admin:dev-auth-admin@$PG_HOSTPORT/postgres?sslmode=disable"
  export GOTRUE_DB_MIGRATIONS_PATH="$BIN/migrations"
  export GOTRUE_SITE_URL="${APP_BASE_URL:-http://localhost:3000}"
  export GOTRUE_URI_ALLOW_LIST="http://localhost:3000/**,http://127.0.0.1:3000/**"
  export API_EXTERNAL_URL="http://127.0.0.1:$GATEWAY_PORT/auth/v1"
  export GOTRUE_API_HOST=127.0.0.1
  export PORT=$AUTH_PORT
  export GOTRUE_JWT_SECRET="$DEV_JWT_SECRET"
  export GOTRUE_JWT_EXP=3600
  export GOTRUE_JWT_AUD=authenticated
  export GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated
  export GOTRUE_JWT_ADMIN_ROLES=service_role
  export GOTRUE_DISABLE_SIGNUP=true
  export GOTRUE_EXTERNAL_EMAIL_ENABLED=true
  export GOTRUE_MAILER_AUTOCONFIRM=true
  export GOTRUE_LOG_LEVEL=warn
}

start_bg() {
  local name="$1"; shift
  if [[ -f "$STATE/$name.pid" ]] && kill -0 "$(cat "$STATE/$name.pid")" 2>/dev/null; then
    echo "$name already running"
    return
  fi
  nohup "$@" > "$STATE/$name.log" 2>&1 &
  echo $! > "$STATE/$name.pid"
  echo "started $name (log: .dev-stack/$name.log)"
}

stop_bg() {
  local name="$1"
  if [[ -f "$STATE/$name.pid" ]]; then
    kill "$(cat "$STATE/$name.pid")" 2>/dev/null || true
    rm -f "$STATE/$name.pid"
    echo "stopped $name"
  fi
}

write_postgrest_conf() {
  cat > "$STATE/postgrest.conf" <<EOF
db-uri = "postgres://authenticator:dev-authenticator@$PG_HOSTPORT/postgres"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$DEV_JWT_SECRET"
server-host = "127.0.0.1"
server-port = $REST_PORT
db-pool = 10
EOF
}

migrate_auth() {
  auth_env
  (cd "$BIN" && ./auth migrate >/dev/null)
}

apply_migrations() {
  for f in "$ROOT"/supabase/migrations/*.sql; do
    echo "applying $(basename "$f")"
    psql_admin -f "$f"
  done
  # Supabase gives service_role full access; mirror that for the admin API paths.
  psql_admin -c "grant all on all tables in schema public to service_role; grant all on all sequences in schema public to service_role;"
}

cmd_up() {
  ensure_binaries
  ensure_keys
  pg_isready -d "$PG_URL" >/dev/null || { echo "PostgreSQL is not reachable at $PG_URL"; exit 1; }
  psql_admin -f "$ROOT/scripts/dev-stack/roles.sql"
  migrate_auth
  write_postgrest_conf
  auth_env
  start_bg auth bash -c "cd '$BIN' && exec ./auth serve"
  start_bg postgrest "$BIN/postgrest" "$STATE/postgrest.conf"
  GATEWAY_PORT=$GATEWAY_PORT AUTH_PORT=$AUTH_PORT REST_PORT=$REST_PORT \
    start_bg gateway node "$ROOT/scripts/dev-stack/gateway.mjs"
  echo "Supabase-compatible API at http://127.0.0.1:$GATEWAY_PORT"
}

cmd_db_reset() {
  ensure_binaries
  ensure_keys
  psql_admin <<'SQL'
drop schema if exists public cascade;
drop schema if exists private cascade;
drop schema if exists auth cascade;
create schema public;
grant usage on schema public to public;
SQL
  psql_admin -f "$ROOT/scripts/dev-stack/roles.sql"
  migrate_auth
  apply_migrations
  if [[ "${SKIP_SEED:-}" != "1" ]]; then
    echo "applying seed.sql"
    psql_admin -f "$ROOT/supabase/seed.sql"
  fi
  psql_admin -c "notify pgrst, 'reload schema';"
  echo "database reset complete"
}

cmd_env() {
  ensure_keys
  cat <<EOF
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:$GATEWAY_PORT
NEXT_PUBLIC_SUPABASE_ANON_KEY=$DEV_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$DEV_SERVICE_ROLE_KEY
TEST_DATABASE_URL=$PG_URL
EOF
}

cmd_down() {
  stop_bg gateway
  stop_bg postgrest
  stop_bg auth
}

case "${1:-}" in
  up) cmd_up ;;
  db-reset) cmd_db_reset ;;
  env) cmd_env ;;
  down) cmd_down ;;
  *) echo "usage: $0 {up|db-reset|env|down}"; exit 1 ;;
esac
