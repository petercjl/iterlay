#!/usr/bin/env bash
set -euo pipefail
umask 077
deployment=${1:?Pass the Tuda deployment directory}
cd "$deployment"
test -f compose.yaml
test -f config/runtime.env
mkdir -p backups
snapshot=$(mktemp -d "$deployment/backups/snapshot-$(date +%Y%m%d-%H%M%S)-XXXXXX")
# Files are immutable and written before their database registration; copying assets
# after the database snapshot preserves every referenced file without stopping editors.
docker compose --env-file config/runtime.env exec -T db pg_dump -U tuda -d tuda -Fc > "$snapshot/database.dump"
tar -czf "$snapshot/assets.tar.gz" -C storage assets
cp -p config/runtime.env "$snapshot/runtime.env"
cp -p compose.yaml "$snapshot/compose.yaml"
docker image inspect tuda-enterprise:dev --format '{{.Id}}' > "$snapshot/image-id.txt"
(cd "$snapshot" && sha256sum database.dump assets.tar.gz runtime.env compose.yaml image-id.txt > SHA256SUMS)
chmod 600 "$snapshot"/*
test -s "$snapshot/database.dump"
test -s "$snapshot/assets.tar.gz"
printf 'Tuda backup saved: %s\n' "$snapshot"
