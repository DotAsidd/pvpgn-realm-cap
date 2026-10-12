#!/bin/bash
set -e

echo "[*] Killing rogue processes on 6112 and 6200..."
sudo fuser -k 6112/tcp 6112/udp 6200/tcp 2>/dev/null || true

echo "[*] Stopping any conflicting containers..."
sudo docker ps -q --filter "publish=6112" | xargs -r sudo docker stop || true
sudo docker ps -q --filter "publish=16112" | xargs -r sudo docker stop || true
sudo docker stop pvpgn-server 2>/dev/null || true
sudo docker rm pvpgn-server 2>/dev/null || true

echo "[*] Updating firewall for 6112 & 6200..."
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 6112 -j ACCEPT 2>/dev/null || true
sudo iptables -I INPUT 6 -m state --state NEW -p udp --dport 6112 -j ACCEPT 2>/dev/null || true
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 6200 -j ACCEPT 2>/dev/null || true
sudo netfilter-persistent save 2>/dev/null || true

echo "[*] Starting production stack..."
sudo docker compose up -d

echo "[+] Active ports:"
sudo ss -tulpn | grep -E '6112|6200'
