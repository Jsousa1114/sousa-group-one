#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL est requis}"
OUT="${1:-backup-$(date -u +%Y%m%dT%H%M%SZ).dump}"

command -v pg_dump >/dev/null || { echo "pg_dump introuvable"; exit 1; }
command -v pg_restore >/dev/null || { echo "pg_restore introuvable"; exit 1; }

umask 077
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" --file="$OUT"
pg_restore --list "$OUT" >/dev/null

echo "Sauvegarde PostgreSQL vérifiée: $OUT"
