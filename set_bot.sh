#!/usr/bin/env bash
# ==============================================================================
# DotA & Friends - Grant Hosting Bot / Operator Privileges
# Usage: ./set_bot.sh <bot_username>
# ==============================================================================
set -euo pipefail

if [ -z "${1:-}" ]; then
    echo "Usage: $0 <bot_username>"
    exit 1
fi

BOT_USER="$1"
echo "==> Granting bot & operator permissions to: $BOT_USER"

docker exec -i pvpgn-mysql mysql -uroot -psiddnoob pvpgn <<EOF
UPDATE pvpgn_BNET 
SET auth_botlogin = 'true', 
    auth_operator = 'true', 
    auth_command_groups = '255' 
WHERE username = LOWER('${BOT_USER}');
SELECT uid, username, auth_botlogin, auth_operator, auth_command_groups 
FROM pvpgn_BNET 
WHERE username = LOWER('${BOT_USER}');
EOF

echo "==> Permissions successfully applied!"
