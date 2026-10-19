#!/usr/bin/env bash
# migrate-neon-to-docker-pg.sh
# Dump the legacy Neon Postgres database and restore it into the
# self-hosted Postgres defined in docker-compose.yml.
#
# Usage:
#   NEON_DATABASE_URL="postgresql://neondb_owner:..." ./scripts/migrate-neon-to-docker-pg.sh
# Or set NEON_DATABASE_URL in backend/.env and run from repo root.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_ROOT/backend/.env"

cd "$REPO_ROOT"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

NEON_URL="${NEON_DATABASE_URL:-}"
if [[ -z "$NEON_URL" ]]; then
  echo "ERROR: Set NEON_DATABASE_URL (e.g. in backend/.env) or pass it on the command line."
  echo "Example: NEON_DATABASE_URL='postgresql://neondb_owner:...' $0"
  exit 1
fi

# Defaults match docker-compose.yml
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-blindmarket}"
TARGET_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:5432/${POSTGRES_DB}?sslmode=disable"

DUMP_FILE="/tmp/neon-to-docker-pg-$(date +%Y%m%d-%H%M%S).dump"

echo "==> Neon source: ${NEON_URL//:*@/@***@}"
echo "==> Target:      postgresql://${POSTGRES_USER}:***@localhost:5432/${POSTGRES_DB}?sslmode=disable"
echo "==> Dump file:   $DUMP_FILE"

# Ensure the local Postgres container is running.
echo "==> Starting/ensuring docker-compose postgres is up..."
docker compose up -d postgres redis

echo "==> Waiting for postgres to be healthy..."
for i in {1..30}; do
  if docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Dump Neon.
echo "==> Dumping Neon database..."
pg_dump "$NEON_URL" --format=custom --file="$DUMP_FILE"

# Recreate target database fresh.
echo "==> Recreating target database..."
PGPASSWORD="$POSTGRES_PASSWORD" psql "postgresql://${POSTGRES_USER}@localhost:5432/postgres?sslmode=disable" \
  -c "DROP DATABASE IF EXISTS \"${POSTGRES_DB}\";" \
  -c "CREATE DATABASE \"${POSTGRES_DB}\";" >/dev/null

# Restore to the new local Postgres.
echo "==> Restoring into docker-compose Postgres..."
pg_restore --dbname="$TARGET_URL" --no-owner --no-privileges --verbose "$DUMP_FILE" || true

echo "==> Verifying row counts..."
PGPASSWORD="$POSTGRES_PASSWORD" psql "$TARGET_URL" -c "\dt"
PGPASSWORD="$POSTGRES_PASSWORD" psql "$TARGET_URL" -c "SELECT schemaname, relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC;"

echo "==> Migration complete."
echo "    Remove the dump when ready: rm $DUMP_FILE"
