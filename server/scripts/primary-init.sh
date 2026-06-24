#!/bin/bash
# Runs once on first init of the PRIMARY. Creates a replication role + slot and
# allows the replica to connect for streaming replication.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '${REPL_PASSWORD}';
  SELECT pg_create_physical_replication_slot('replica_slot');
EOSQL

# Allow the replica (any host on the compose network) to authenticate for replication.
{
  echo "host replication replicator all scram-sha-256"
} >> "$PGDATA/pg_hba.conf"
