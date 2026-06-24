#!/bin/bash
# Brings up a streaming hot-standby replica of the primary (service name: db).
set -e
PGDATA=/var/lib/postgresql/data

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "[replica] base-backing up from primary…"
  until pg_isready -h db -U replicator; do echo "[replica] waiting for primary…"; sleep 3; done
  rm -rf "${PGDATA:?}/"*
  PGPASSWORD="$PGPASSWORD" pg_basebackup -h db -D "$PGDATA" -U replicator -Fp -Xs -P -R -S replica_slot
  chmod 0700 "$PGDATA"
  echo "[replica] base backup complete; starting as hot standby."
fi

exec docker-entrypoint.sh postgres -c hot_standby=on
