#!/bin/bash
# Periodic logical backups of the primary with retention.
# Dumps land in /backups (bind-mounted). Ship this directory offsite (S3/GCS)
# for true geographic redundancy.
set -e
INTERVAL="${BACKUP_INTERVAL_SECONDS:-21600}"
RETAIN="${BACKUP_RETENTION:-28}"
mkdir -p /backups

echo "[backup] starting; interval=${INTERVAL}s retention=${RETAIN}"
while true; do
  until pg_isready -h db -U wcapp; do echo "[backup] waiting for primary…"; sleep 5; done
  TS=$(date -u +%Y%m%dT%H%M%SZ)
  OUT="/backups/woundcare_${TS}.sql.gz"
  echo "[backup] dumping -> ${OUT}"
  if pg_dump -h db -U wcapp -d woundcare | gzip > "${OUT}.tmp"; then
    mv "${OUT}.tmp" "${OUT}"
    echo "[backup] ok ($(du -h "${OUT}" | cut -f1))"
  else
    echo "[backup] FAILED"; rm -f "${OUT}.tmp"
  fi
  # prune: keep newest $RETAIN
  ls -1t /backups/woundcare_*.sql.gz 2>/dev/null | tail -n +$((RETAIN+1)) | xargs -r rm -f
  sleep "${INTERVAL}"
done
