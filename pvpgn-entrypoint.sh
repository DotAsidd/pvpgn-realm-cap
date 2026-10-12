#!/bin/sh
set -e

# Initialize required runtime directories and permissions
mkdir -p /var/pvpgn/status /var/pvpgn/ladders /var/pvpgn/users /var/pvpgn/clans /var/pvpgn/teams /var/pvpgn/files /var/pvpgn/lua
touch /var/pvpgn/status/server.dat
chown -R 1001:1001 /var/pvpgn /etc/pvpgn 2>/dev/null || true
chmod -R 775 /var/pvpgn 2>/dev/null || true

# Dynamically set DB password in bnetd.conf
if [ -n "${MYSQL_PASSWORD}" ] && [ -f /etc/pvpgn/bnetd.conf ]; then
    sed -i "s|pass=[^;]*;|pass=${MYSQL_PASSWORD};|g" /etc/pvpgn/bnetd.conf 2>/dev/null || true
fi

# Dynamically set public IP in realm.conf
if [ -n "${SERVER_PUBLIC_IP}" ] && [ -f /etc/pvpgn/realm.conf ]; then
    sed -i "s|18\.140\.238\.236|${SERVER_PUBLIC_IP}|g" /etc/pvpgn/realm.conf 2>/dev/null || true
fi

if [ "$1" = "bnetd" ]; then
    shift
    exec su-exec pvpgn:pvpgn bnetd -f "$@"
fi

exec su-exec pvpgn:pvpgn "$@"
