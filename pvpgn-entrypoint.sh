#!/bin/sh
set -e

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
    exec bnetd -f "$@"
fi

exec "$@"
