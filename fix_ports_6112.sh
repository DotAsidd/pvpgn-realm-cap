#!/bin/bash
set -e

echo "[*] Killing rogue processes on 6112 and 6200..."
sudo fuser -k 6112/tcp 6112/udp 6200/tcp 2>/dev/null || true

echo "[*] Stopping any conflicting containers..."
sudo docker ps -q --filter "publish=6112" | xargs -r sudo docker stop || true
sudo docker ps -q --filter "publish=16112" | xargs -r sudo docker stop || true
sudo docker stop pvpgn-server 2>/dev/null || true
sudo docker rm pvpgn-server 2>/dev/null || true

echo "[*] Opening all ports on host firewall..."
sudo iptables -P INPUT ACCEPT 2>/dev/null || true
sudo iptables -P FORWARD ACCEPT 2>/dev/null || true
sudo iptables -P OUTPUT ACCEPT 2>/dev/null || true
sudo iptables -F 2>/dev/null || true
sudo netfilter-persistent save 2>/dev/null || true

echo "[*] Starting production stack..."
sudo docker compose up -d --build

echo "[+] Active ports:"
sudo ss -tulpn | grep -E '6112|6200'
