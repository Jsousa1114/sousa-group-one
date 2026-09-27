#!/usr/bin/env bash
set -euo pipefail

: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL est requis}"
: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL est requis}"

TMP="$(mktemp -t sgo-migration-XXXXXX.dump)"
trap 'rm -f "$TMP"' EXIT

command -v pg_dump >/dev/null || { echo "pg_dump introuvable"; exit 1; }
command -v pg_restore >/dev/null || { echo "pg_restore introuvable"; exit 1; }
command -v psql >/dev/null || { echo "psql introuvable"; exit 1; }

echo "1/4 Sauvegarde de la base source..."
pg_dump --format=custom --no-owner --no-privileges "$SOURCE_DATABASE_URL" --file="$TMP"

echo "2/4 Vérification du dump..."
pg_restore --list "$TMP" >/dev/null

echo "3/4 Restauration vers la base cible..."
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$TARGET_DATABASE_URL" "$TMP"

echo "4/4 Contrôle de la base cible..."
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT 1;" >/dev/null
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT count(*) AS users FROM users;" 
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT revision,updated_at FROM app_state WHERE id=1;"

echo "Migration terminée. Ne basculez DATABASE_URL qu'après validation fonctionnelle de la cible."
