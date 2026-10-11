# DotA & Friends — Production Server (138.2.71.11)

Production package configured for public IP **138.2.71.11** and permanent DDNS host **dotaandfriends.ddns.net**.

---

## Architecture

| Component | Host / Domain | Port | Purpose |
|---|---|---|---|
| **PvPGN (Battle.net)** | `dotaandfriends.ddns.net` | `6112` (TCP/UDP) | Warcraft III login, chat, lobbies |
| **PvPGN Route** | `138.2.71.11` | `6200` (TCP) | Arranged team / game route |
| **Web Face** | `https://dotaandfriends.xyz` | `80` / `443` | Website, /register, /forgot-password |
| **Caddy Proxy** | `dotaandfriends.ddns.net` | `80` / `443` | Reverse proxy `/api/*` + 302 redirect browser to web face |
| **MySQL 8.0** | Internal (`pvpgn-mysql`) | `3306` | Player accounts, tokens, indexes |

---

## Configured Files

- **`pvpgn/etc/address_translation.conf`**: Configured with `0.0.0.0:6200 -> 138.2.71.11:6200`.
- **`pvpgn/etc/bnetd.conf`**: Configured with `sync_on_logoff = true`, `helpfile = bnhelp.conf`, and metadata.
- **`pvpgn/etc/bnhelp.conf`**: Full in-game `/help` command definitions.
- **`pvpgn/etc/bnmotd.txt`**: Directs players to `dotaandfriends.ddns.net` and `https://dotaandfriends.xyz`.
- **`pvpgn/files/`**: 10 client text assets (`chathelp-*`, `tos.txt`, `newaccount-*`, `termsofservice-*`).
- **`caddy/Caddyfile`**: Automatic Let's Encrypt SSL, handles `dotaandfriends.ddns.net` (302 redirect to active web face), `dotaandfriends.xyz`, and raw IP.
- **`mysql/init/`**: Includes `01-init.sql`, `03-tokens.sql`, `04-indexes.sql`, and `05-arrangedteam.sql` (MySQL 8.0 rank fix).
- **`realm_presence_status.patch`**: Native DND/Away broadcast (0x66), clan/channel prefixes, and MySQL 8.0 backtick query fix.
- **`pvpgn/lua/`**: Moderation commands (`/mute`, `/unmute`, `/warn`, `/topic`), presence piping, and Realm Chat bridge.
- **`web/`**: Node.js API with admin overview, chat moderation sync, and user presence badges.
- **`deploy.sh`**: One-click deployment script on the Linux server.

---

## Deployment to 138.2.71.11

1. Copy this folder to the production server:
   ```bash
   scp -r pvpgn-server-prod user@138.2.71.11:~/
   ```
2. SSH into `138.2.71.11`:
   ```bash
   cd ~/pvpgn-server-prod
   chmod +x deploy.sh
   ./deploy.sh
   ```
