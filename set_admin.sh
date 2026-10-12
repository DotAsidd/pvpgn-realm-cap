#!/usr/bin/env bash
# ==============================================================================
# DotA & Friends - Grant Server Administrator Privileges
# Usage: ./set_admin.sh <username>
# ==============================================================================
set -euo pipefail

if [ -z "${1:-}" ]; then
    echo "Usage: $0 <username>"
    exit 1
fi

ADMIN_USER="$1"
echo "==> Granting Administrator permissions to: $ADMIN_USER"

docker exec -i pvpgn-mysql mysql -uroot -p${MYSQL_PASSWORD} pvpgn <<EOF
UPDATE pvpgn_BNET 
SET auth_admin = 'true', 
    auth_operator = 'true', 
    auth_command_groups = '255' 
WHERE username = LOWER('${ADMIN_USER}');
SELECT uid, username, auth_admin, auth_operator, auth_command_groups 
FROM pvpgn_BNET 
WHERE username = LOWER('${ADMIN_USER}');
EOF

echo "==> Administrator permissions successfully applied!"
