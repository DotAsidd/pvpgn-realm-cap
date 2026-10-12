#!/usr/bin/env bash
# ==============================================================================
# DotA & Friends - Player Hierarchy & Role Manager
# Usage: ./set_role.sh <username> <owner|admin|moderator|mvp|svip|vvip|vip|player>
# ==============================================================================
set -euo pipefail

TARGET_USER="${1:-}"
ROLE="${2:-}"

if [ -z "$TARGET_USER" ] || [ -z "$ROLE" ]; then
    echo "Usage: $0 <username> <owner|admin|moderator|mvp|svip|vvip|vip|player>"
    echo ""
    echo "Hierarchy Roles:"
    echo "  5. owner     (group 255: full root)"
    echo "  4. admin     (group 254: ban/kick/moderation)"
    echo "  3. moderator (group 128: mute/warn/topic)"
    echo "  2. mvp       (group  96: Most Valuable Player)"
    echo "     svip      (group  64: Super VIP)"
    echo "     vvip      (group  48: Very Very Important Person)"
    echo "     vip       (group  32: Very Important Person)"
    echo "  1. player    (group   1: default player)"
    exit 1
fi

ROLE=$(echo "$ROLE" | tr '[:upper:]' '[:lower:]')

case "$ROLE" in
    owner)
        ADMIN="true"; OP="true"; CMD_GROUPS="255" ;;
    admin)
        ADMIN="true"; OP="true"; CMD_GROUPS="254" ;;
    moderator|mod)
        ADMIN="false"; OP="true"; CMD_GROUPS="128" ;;
    mvp)
        ADMIN="false"; OP="false"; CMD_GROUPS="96" ;;
    svip)
        ADMIN="false"; OP="false"; CMD_GROUPS="64" ;;
    vvip)
        ADMIN="false"; OP="false"; CMD_GROUPS="48" ;;
    vip)
        ADMIN="false"; OP="false"; CMD_GROUPS="32" ;;
    player|default)
        ADMIN="false"; OP="false"; CMD_GROUPS="1" ;;
    *)
        echo "Error: Unknown role '$ROLE'."
        echo "Valid roles: owner, admin, moderator, mvp, svip, vvip, vip, player"
        exit 1
        ;;
esac

echo "==> Setting role '$ROLE' (admin=$ADMIN, op=$OP, groups=$CMD_GROUPS) for: $TARGET_USER"

docker exec -i pvpgn-mysql mysql -uroot -p${MYSQL_PASSWORD} pvpgn <<EOF
UPDATE pvpgn_BNET 
SET auth_admin = '${ADMIN}', 
    auth_operator = '${OP}', 
    auth_command_groups = '${CMD_GROUPS}' 
WHERE username = LOWER('${TARGET_USER}');
SELECT uid, username, auth_admin, auth_operator, auth_command_groups 
FROM pvpgn_BNET 
WHERE username = LOWER('${TARGET_USER}');
EOF

echo "==> Role '$ROLE' successfully granted to $TARGET_USER!"
