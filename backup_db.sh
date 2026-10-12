#!/bin/bash
# ==============================================================================
# DotA & Friends - Automated Daily MySQL Backup & Rotation Script
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$SCRIPT_DIR/backups}"
mkdir -p "$BACKUP_DIR"

DATE=$(date +'%Y-%m-%d_%H%M%S')
BACKUP_FILE="$BACKUP_DIR/backup_$DATE.sql"

# Check if pvpgn-mysql is running
if ! docker ps --format '{{.Names}}' | grep -q '^pvpgn-mysql$'; then
    echo "[$(date)] Error: pvpgn-mysql container is not running." >&2
    exit 1
fi

# Run mysqldump from mysql container
docker exec pvpgn-mysql mysqldump -uroot -p${MYSQL_PASSWORD} --all-databases --single-transaction --quick > "$BACKUP_FILE"

# Compress backup
gzip -f "$BACKUP_FILE"

# Keep last 7 days of backups
find "$BACKUP_DIR" -type f -name "backup_*.sql.gz" -mtime +7 -delete

echo "[$(date)] Backup successful: ${BACKUP_FILE}.gz"
