#!/usr/bin/env bash
# ==============================================================================
# DotA & Friends - Production Deployment Script for 138.2.71.11
# ==============================================================================
set -euo pipefail

echo "==> Deploying DotA & Friends Production Server (138.2.71.11)..."

command -v docker >/dev/null 2>&1 || { echo "Error: docker not installed"; exit 1; }

if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
else
    COMPOSE="docker-compose"
fi

chmod +x ./pvpgn-entrypoint.sh ./backup_db.sh ./set_bot.sh ./set_admin.sh ./ban_user.sh ./set_role.sh ./fix_ports_6112.sh

if [ -f .env ]; then
    MYSQL_PASS=$(grep -E '^MYSQL_PASSWORD=' .env | cut -d '=' -f2- | tr -d '"'\''\r')
    if [ -n "$MYSQL_PASS" ] && [ -f ./pvpgn/etc/bnetd.conf ]; then
        sed -i "s|pass=[^;]*;|pass=${MYSQL_PASS};|g" ./pvpgn/etc/bnetd.conf
    fi
fi

echo "==> Building pvpgn-patched:latest..."
docker build -f pvpgn-patched.Dockerfile -t pvpgn-patched:latest .

echo "==> Starting production stack..."
$COMPOSE up -d --build

echo "==> Deploying in-game text assets and Lua scripts..."
docker cp ./pvpgn/files/. pvpgn-server:/var/pvpgn/files/
docker cp ./pvpgn/lua/. pvpgn-server:/var/pvpgn/lua/
docker exec --user root pvpgn-server chown -R pvpgn:pvpgn /var/pvpgn/files /var/pvpgn/lua
docker exec --user root pvpgn-server chmod 755 /var/pvpgn/files
docker exec --user root pvpgn-server chmod 644 /var/pvpgn/files/*.txt
docker exec --user root pvpgn-server chmod -R 755 /var/pvpgn/lua
docker restart pvpgn-server

echo "==> Configuring automated daily database backup..."
chmod +x ./backup_db.sh ./set_bot.sh ./set_admin.sh ./ban_user.sh ./set_role.sh
if command -v crontab >/dev/null 2>&1; then
    DEPLOY_DIR="$(pwd)"
    CRON_CMD="0 3 * * * $DEPLOY_DIR/backup_db.sh >> $DEPLOY_DIR/backup.log 2>&1"
    (crontab -l 2>/dev/null | grep -Fv "$DEPLOY_DIR/backup_db.sh" ; echo "$CRON_CMD") | crontab -
    echo "==> Daily backup cron installed (03:00 UTC)."
fi

echo "==> Verifying fail2ban SSH protection..."
if ! command -v fail2ban-client >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
        echo "Installing fail2ban..."
        sudo apt-get update -qq && sudo apt-get install -y -qq fail2ban
        sudo systemctl enable --now fail2ban
        echo "==> fail2ban enabled."
    fi
else
    echo "==> fail2ban is already active."
fi

echo "==> Verifying services:"
$COMPOSE ps

echo "==> Production server 138.2.71.11 ready!"
