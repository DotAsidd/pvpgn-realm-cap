#!/bin/sh

set -eu

echo "=========================================="
echo "Starting PvPGN"
echo "=========================================="

CONFIG="/opt/pvpgn/etc/pvpgn/bnetd.conf"

echo "Configuring MySQL storage..."

# Remove any existing active storage_path
sed -i '/^[[:space:]]*storage_path[[:space:]]*=/d' "$CONFIG"

# Add the SQL storage configuration
cat >> "$CONFIG" <<EOF

storage_path = "sql:mode=mysql;host=${DB_HOST};name=${DB_NAME};user=${DB_USER};pass=${DB_PASSWORD};default=0;prefix=pvpgn_"
EOF

echo "PvPGN MySQL storage configured:"
grep '^storage_path' "$CONFIG"

echo "Starting PvPGN..."

exec /opt/pvpgn/sbin/bnetd -f