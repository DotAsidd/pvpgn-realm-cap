#!/usr/bin/env bash
# ==============================================================================
# DotA & Friends - Player Ban / Unban Management Script
# Usage: 
#   ./ban_user.sh ban <username> [reason]
#   ./ban_user.sh unban <username>
# ==============================================================================
set -euo pipefail

ACTION="${1:-}"
TARGET_USER="${2:-}"
REASON="${3:-Banned by server administrator}"

if [ -z "$ACTION" ] || [ -z "$TARGET_USER" ]; then
    echo "Usage:"
    echo "  $0 ban <username> [reason]"
    echo "  $0 unban <username>"
    exit 1
fi

case "$ACTION" in
    ban)
        echo "==> Banning user: $TARGET_USER (Reason: $REASON)"
        docker exec -i pvpgn-mysql mysql -uroot -p${MYSQL_PASSWORD} pvpgn <<EOF
UPDATE pvpgn_BNET 
SET auth_lock = 'true', 
    auth_lockreason = '${REASON}', 
    auth_locktime = UNIX_TIMESTAMP() 
WHERE username = LOWER('${TARGET_USER}');
SELECT uid, username, auth_lock, auth_lockreason, auth_locktime 
FROM pvpgn_BNET 
WHERE username = LOWER('${TARGET_USER}');
EOF
        # Kick player from PvPGN server if currently connected
        if [ -p /var/pvpgn/web_to_bnet.pipe ]; then
            echo "/kick ${TARGET_USER} ${REASON}" > /var/pvpgn/web_to_bnet.pipe 2>/dev/null || true
        fi
        echo "==> Player $TARGET_USER is now BANNED."
        ;;

    unban)
        echo "==> Unbanning user: $TARGET_USER"
        docker exec -i pvpgn-mysql mysql -uroot -p${MYSQL_PASSWORD} pvpgn <<EOF
UPDATE pvpgn_BNET 
SET auth_lock = 'false', 
    auth_lockreason = NULL, 
    auth_locktime = 0 
WHERE username = LOWER('${TARGET_USER}');
SELECT uid, username, auth_lock 
FROM pvpgn_BNET 
WHERE username = LOWER('${TARGET_USER}');
EOF
        echo "==> Player $TARGET_USER is now UNBANNED."
        ;;

    *)
        echo "Error: Unknown action '$ACTION'. Use 'ban' or 'unban'."
        exit 1
        ;;
esac
