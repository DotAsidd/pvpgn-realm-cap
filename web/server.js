import express from "express";
import fs from "fs";
import mysql from "mysql2/promise";
import nodemailer from "nodemailer";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import http from "http";
import dns from "dns";
import net from "net";
import { getAdminHtml } from "./admin_view.js";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


// Pure JS implementation of PvPGN Battle.net v1.0 SHA-1 hash (cross-platform, ARM64 & x86_64)
function pvpgn_hash(str) {
    str = String(str || "").toLowerCase();
    const nblk = ((str.length + 8) >> 6) + 1;
    const blks = new Array(nblk * 16).fill(0);
    for (let i = 0; i < str.length; i++) {
        blks[i >> 2] |= str.charCodeAt(i) << ((i % 4) * 8);
    }
    const safe_add = (x, y) => ((x & 0xFFFFFFFF) + (y & 0xFFFFFFFF)) | 0;
    const safe_rol = (num, amt) => ((num << amt) | (num >>> (32 - amt))) | 0;
    const ft = (t, b, c, d) => {
        if (t < 20) return (b & c) | ((~b) & d);
        if (t < 40) return d ^ c ^ b;
        if (t < 60) return (c & b) | (d & c) | (d & b);
        return d ^ c ^ b;
    };
    const kt = (t) => {
        if (t < 20) return 0x5a827999 | 0;
        if (t < 40) return 0x6ed9eba1 | 0;
        if (t < 60) return 0x8f1bbcdc | 0;
        return 0xca62c1d6 | 0;
    };

    let a = 0x67452301 | 0, b = 0xefcdab89 | 0, c = 0x98badcfe | 0, d = 0x10325476 | 0, e = 0xc3d2e1f0 | 0;
    for (let i = 0; i < blks.length; i += 16) {
        const olda = a, oldb = b, oldc = c, oldd = d, olde = e;
        const w = new Array(80).fill(0);
        for (let j = 0; j < 16; j++) w[j] = blks[i + j];
        for (let j = 0; j < 64; j++) {
            const ww = w[j] ^ w[j + 8] ^ w[j + 2] ^ w[j + 13];
            w[j + 16] = (1 << (ww >>> 0 % 32)) | 0;
        }
        for (let j = 0; j < 80; j++) {
            const t = safe_add(safe_add(safe_rol(a, 5), ft(j, b, c, d)), safe_add(safe_add(e, w[j]), kt(j)));
            e = d;
            d = c;
            c = safe_rol(b, 30);
            b = a;
            a = t;
        }
        a = safe_add(a, olda);
        b = safe_add(b, oldb);
        c = safe_add(c, oldc);
        d = safe_add(d, oldd);
        e = safe_add(e, olde);
    }
    const toHex = (n) => ((n >>> 0).toString(16).padStart(8, "0"));
    return toHex(a) + toHex(b) + toHex(c) + toHex(d) + toHex(e);
}

async function getBnPassHash(password) {
    try {
        if (fs.existsSync("/usr/local/bin/bnpass")) {
            const { stdout } = await execFileAsync("/usr/local/bin/bnpass", [password]);
            const match = stdout.match(/"BNET\\\\acct\\\\passhash1"="([a-fA-F0-9]{40})"/);
            if (match) return match[1];
        }
    } catch (_) { }
    return pvpgn_hash(password);
}

const app = express();
app.set("trust proxy", 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/theme", express.static(path.join(__dirname, "public", "theme")));

// -----------------------------
// Rate Limiter Middleware (Safe, In-Memory)
// -----------------------------
function createRateLimiter(windowMs, maxRequests, message) {
    const hits = new Map();
    setInterval(() => {
        const now = Date.now();
        for (const [ip, record] of hits.entries()) {
            if (now > record.resetAt) hits.delete(ip);
        }
    }, 60000).unref();

    return (req, res, next) => {
        const ip = req.ip || req.socket?.remoteAddress || "unknown";
        if (ip === "127.0.0.1" || ip === "::1") return next();

        const now = Date.now();
        let record = hits.get(ip);
        if (!record || now > record.resetAt) {
            record = { count: 1, resetAt: now + windowMs };
            hits.set(ip, record);
            return next();
        }

        record.count++;
        if (record.count > maxRequests) {
            const retrySec = Math.ceil((record.resetAt - now) / 1000);
            res.set("Retry-After", String(retrySec));
            return res.status(429).json({ error: message || "Too many requests. Please wait.", retryAfter: retrySec });
        }
        next();
    };
}

const authLimiter = createRateLimiter(10 * 60 * 1000, 10, "Too many attempts. Please try again in 10 minutes.");
const generalApiLimiter = createRateLimiter(60 * 1000, 120, "Rate limit exceeded. Please wait a moment.");

app.use(["/api/register", "/api/forgot-password", "/api/reset-password"], authLimiter);
app.use("/api/", generalApiLimiter);

// -----------------------------
// Games API (started/open lobbies) - cached parse, live duration
// -----------------------------

let gamesCache = {
    games: [],
    gameUsers: {},
    status: { users: 0, games: 0, channels: 0, uptime: "" },
    war3Users: 0,
    war3Games: 0,
    at: 0
};
const GAMES_CACHE_MS = 5000;

function parseStatusFile() {

    const statusFile = "/var/pvpgn/status/server.dat";
    const games = [];
    const gameUsers = {};
    const gameUserCount = {};
    const activeUsers = [];
    const channels = [];
    const status = { users: 0, games: 0, channels: 0, uptime: "", version: "1.99.7.2.1-PRO" };
    let war3Users = 0;
    let war3Games = 0;

    if (!fs.existsSync(statusFile)) {
        return { games, gameUsers, activeUsers, channels, status, war3Users, war3Games };
    }

    const content = fs.readFileSync(statusFile, "utf-8");
    let section = "";

    for (const line of content.split("\n")) {

        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith("[")) {
            section = trimmed.replace(/[\[\]]/g, "").toUpperCase();
            continue;
        }

        if (section === "STATUS") {
            const eqIdx = trimmed.indexOf("=");
            if (eqIdx !== -1) {
                const k = trimmed.slice(0, eqIdx).trim().toLowerCase();
                const v = trimmed.slice(eqIdx + 1).trim();
                if (k === "users") status.users = parseInt(v, 10) || 0;
                else if (k === "games") status.games = parseInt(v, 10) || 0;
                else if (k === "channels") status.channels = parseInt(v, 10) || 0;
                else if (k === "uptime") status.uptime = v;
                else if (k === "version") status.version = v;
            }
        } else if (section === "CHANNELS") {
            const eqIdx = trimmed.indexOf("=");
            if (eqIdx !== -1) {
                const cname = trimmed.slice(eqIdx + 1).trim();
                if (cname && !channels.includes(cname)) channels.push(cname);
            }
        } else if (section === "GAMES") {

            const patched = trimmed.match(/^game\d+=([A-Za-z0-9_]+),(\d+),(.+?),(open|started|full|loaded|done),(\d+),(\d+),(\d+)$/);
            const simple = trimmed.match(/^game\d+=([A-Za-z0-9_]+),(\d+),(.+)$/);

            if (patched) {
                const tag = patched[1];
                if (tag === "PX3W" || tag === "W3XP" || tag === "3RAW" || tag === "WAR3") {
                    war3Games++;
                }
                games.push({
                    id: patched[2],
                    name: patched[3],
                    tag: tag,
                    status: patched[4],
                    count: parseInt(patched[5], 10) || 0,
                    slots: parseInt(patched[6], 10) || 0,
                    starttime: parseInt(patched[7], 10) || 0
                });
            } else if (simple) {
                const tag = simple[1];
                if (tag === "PX3W" || tag === "W3XP" || tag === "3RAW" || tag === "WAR3") {
                    war3Games++;
                }
                games.push({
                    id: simple[2],
                    name: simple[3],
                    tag: tag,
                    status: "open",
                    count: 0,
                    slots: 0,
                    starttime: 0
                });
            }

        } else if (section === "USERS") {

            const eqIdx = trimmed.indexOf("=");
            if (eqIdx !== -1) {
                const parts = trimmed.slice(eqIdx + 1).split(",");
                const tag = parts[0] || "";
                if (tag === "PX3W" || tag === "W3XP" || tag === "3RAW" || tag === "WAR3") {
                    war3Users++;
                }
                const uname = parts[1] || "";
                const clientVer = parts[2] || "";
                const country = parts[3] || "";
                const gameId = parts[4] || "0";
                const channel = (parts[5] && parts[5] !== "-") ? parts[5] : "";
                const presence = parts[6] || "online";

                if (uname) {
                    activeUsers.push({
                        username: uname,
                        tag: tag,
                        client: (tag === "PX3W" || tag === "W3XP") ? "Warcraft III TFT" : ((tag === "WAR3" || tag === "3RAW") ? "Warcraft III RoC" : (tag || "Battle.net")),
                        version: clientVer,
                        country: country,
                        gameId: gameId,
                        channel: channel,
                        presence: presence
                    });
                }

                if (gameId && gameId !== "0") {
                    gameUserCount[gameId] = (gameUserCount[gameId] || 0) + 1;
                    if (!gameUsers[gameId]) gameUsers[gameId] = [];
                    if (uname && !gameUsers[gameId].includes(uname)) {
                        gameUsers[gameId].push(uname);
                    }
                }
            }

        }

    }

    for (const g of games) {
        if (g.id != null && g.count === 0) {
            g.count = gameUserCount[g.id] || 0;
        }
        g.players = gameUsers[g.id] || [];
    }

    if (status.games === 0 && games.length > 0) status.games = games.length;
    if (war3Games === 0 && games.length > 0) war3Games = games.length;
    if (war3Users === 0 && status.users > 0) war3Users = status.users;

    return { games, gameUsers, activeUsers, channels, status, war3Users, war3Games };
}

app.get(["/api/games", "/lobby/api/games", "/new/api/pvpgn/games/json"], (req, res) => {

    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.set("Cache-Control", "max-age=5");

    if (Date.now() - gamesCache.at >= GAMES_CACHE_MS) {
        const parsed = parseStatusFile();
        gamesCache = { ...parsed, at: Date.now() };
    }

    try {

        const { games, gameUsers } = gamesCache;
        const DEFAULT_SLOTS = 10;
        const nowSec = Math.floor(Date.now() / 1000);

        const open = games
            .filter(g => g.status === "open" || g.status === "full")
            .map(g => ({
                name: g.name,
                status: "open",
                players: g.count,
                playerNames: gameUsers[g.id] || [],
                slots: g.slots || DEFAULT_SLOTS,
                started_at: g.starttime > 0 ? g.starttime : null,
                duration_seconds: 0,
                count: Math.max(0, (g.slots || DEFAULT_SLOTS) - g.count)
            }));

        const started = games
            .filter(g => g.status === "started" || g.status === "loaded" || g.status === "done")
            .map(g => ({
                name: g.name,
                status: "started",
                players: g.count,
                playerNames: gameUsers[g.id] || [],
                slots: g.slots || DEFAULT_SLOTS,
                started_at: g.starttime > 0 ? g.starttime : null,
                duration_seconds: g.starttime > 0 ? Math.max(0, nowSec - g.starttime) : 0,
                count: Math.max(0, (g.slots || DEFAULT_SLOTS) - g.count)
            }));

        res.json({ open, started });

    } catch (error) {

        console.error("Games API error:", error);
        res.json({ open: [], started: [] });

    }

});

// -----------------------------
// Status & Users Online API
// -----------------------------

app.get("/api/status", (req, res) => {

    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.set("Cache-Control", "max-age=5");

    if (Date.now() - gamesCache.at >= GAMES_CACHE_MS) {
        const parsed = parseStatusFile();
        gamesCache = { ...parsed, at: Date.now() };
    }

    const { status, war3Users, war3Games } = gamesCache;
    const users = status.users || 0;
    const games = status.games || 0;
    const channels = status.channels || 0;
    const w3Users = war3Users != null && war3Users > 0 ? war3Users : users;
    const w3Games = war3Games != null && war3Games > 0 ? war3Games : games;

    const response = [
        `There are currently ${users} users online, in ${games} games and ${channels} channels.`,
        `There are currently ${w3Users} user(s) in ${w3Games} games of Warcraft III Frozen Throne`
    ];

    res.json(response);

});

app.get("/api/users", (req, res) => {

    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.set("Cache-Control", "max-age=5");

    if (Date.now() - gamesCache.at >= GAMES_CACHE_MS) {
        const parsed = parseStatusFile();
        gamesCache = { ...parsed, at: Date.now() };
    }

    const { status, war3Users, war3Games } = gamesCache;
    const users = status.users || 0;
    const games = status.games || 0;
    const channels = status.channels || 0;
    const w3Users = war3Users != null && war3Users > 0 ? war3Users : users;
    const w3Games = war3Games != null && war3Games > 0 ? war3Games : games;

    res.json([
        `There are currently ${users} users online, in ${games} games and ${channels} channels.`,
        `There are currently ${w3Users} user(s) in ${w3Games} games of Warcraft III Frozen Throne`
    ]);

});


const pool = mysql.createPool({
    host: process.env.DB_HOST || "mysql",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "pvpgn",
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || "pvpgn",

    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// -----------------------------
// Channel Users & Topic API (DotA & Friends)
// -----------------------------

let channelStateCache = {
    userChannels: {},
    onlineUsers: [],
    at: 0
};
const CHANNEL_CACHE_MS = 3000;

function getBaseUrl(req) {
    const host = req.get("x-forwarded-host") || req.get("host");
    if (host) {
        const proto = req.get("x-forwarded-proto") || req.protocol || "https";
        return `${proto}://${host}`;
    }
    if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/+$/, "");
    if (process.env.FRONTEND_URL) return process.env.FRONTEND_URL.replace(/\/+$/, "");
    return "https://dotaandfriends.ddns.net";
}

function getChannelTopic(channelName) {
    const paths = [
        "/etc/pvpgn/topics.conf",
        "/var/pvpgn/topics.conf",
        "/var/pvpgn/etc/topics.conf",
        path.join(__dirname, "topics.conf"),
        path.join(__dirname, "../pvpgn/etc/topics.conf")
    ];

    let topicText = "";
    let matchedName = channelName;
    for (const p of paths) {
        if (fs.existsSync(p)) {
            try {
                const content = fs.readFileSync(p, "utf-8");
                for (const line of content.split("\n")) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith("#")) continue;
                    const parts = line.split("\t");
                    if (parts.length >= 2 && parts[0].trim().toLowerCase() === channelName.toLowerCase()) {
                        matchedName = parts[0].trim();
                        topicText = parts.slice(1).join("\t").trim();
                        break;
                    }
                }
            } catch (e) {
                // ignore read error
            }
            if (topicText) break;
        }
    }

    if (topicText) {
        return { topic: ` "${matchedName} topic: ${topicText}"` };
    }
    return {};
}

function parseChannelState() {
    const statusFile = "/var/pvpgn/status/server.dat";
    const logFile = "/var/pvpgn/bnetd.log";

    const onlineUsers = [];
    if (fs.existsSync(statusFile)) {
        try {
            const content = fs.readFileSync(statusFile, "utf-8");
            let section = "";
            for (const line of content.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                if (trimmed.startsWith("[")) {
                    section = trimmed.replace(/[\[\]]/g, "").toUpperCase();
                    continue;
                }
                if (section === "USERS") {
                    const eqIdx = trimmed.indexOf("=");
                    if (eqIdx !== -1) {
                        const parts = trimmed.slice(eqIdx + 1).split(",");
                        const uname = (parts[1] || "").trim();
                        const gameId = parts[4] ? parts[4].trim() : "0";
                        const channel = (parts[5] && parts[5].trim() !== "-") ? parts[5].trim() : "";
                        const presence = parts[6] ? parts[6].trim() : "online";
                        if (uname) {
                            onlineUsers.push({ name: uname, gameId, channel, presence });
                            if (channel) {
                                userChannels[uname.toLowerCase()] = channel;
                            }
                            if (presence && presence !== "online") {
                                userPresenceMap[uname.toLowerCase()] = {
                                    state: presence,
                                    reason: presence === "dnd" ? "Do Not Disturb" : "Away",
                                    at: Date.now()
                                };
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error("Error reading statusFile for channels:", e.message);
        }
    }

    const userChannels = {};
    const sockUser = {};
    if (fs.existsSync(logFile)) {
        try {
            const stat = fs.statSync(logFile);
            const readSize = Math.min(stat.size, 512 * 1024);
            const buffer = Buffer.alloc(readSize);
            const fd = fs.openSync(logFile, "r");
            fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
            fs.closeSync(fd);

            const text = buffer.toString("utf-8");
            for (const line of text.split("\n")) {
                const loginMatch = line.match(/\[(\d+)\]\s+\([A-Za-z0-9]+\)\s+"([^"]+)"\s+logged in/);
                if (loginMatch) {
                    const sock = loginMatch[1];
                    const uname = loginMatch[2];
                    sockUser[sock] = uname;
                    userChannels[uname.toLowerCase()] = "DotA and Friends";
                }

                const chMatch = line.match(/conn_set_channel:\s+\[(\d+)\]\s+joined channel\s+"([^"]+)"/);
                if (chMatch) {
                    const sock = chMatch[1];
                    const ch = chMatch[2];
                    const uname = sockUser[sock];
                    if (uname) {
                        userChannels[uname.toLowerCase()] = ch;
                    }
                }

                const logoutMatch = line.match(/conn_destroy:\s+\[(\d+)\]\s+"([^"]+)"\s+logged out/);
                if (logoutMatch) {
                    const sock = logoutMatch[1];
                    const uname = logoutMatch[2];
                    delete sockUser[sock];
                    delete userChannels[uname.toLowerCase()];
                    delete userPresenceMap[uname.toLowerCase()];
                }
            }
        } catch (e) {
            console.error("Error reading logFile for channels:", e.message);
        }
    }

    return { onlineUsers, userChannels };
}

async function handleChannelRequest(req, res) {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.set("Cache-Control", "max-age=3");

    const channelParam = req.params.channelname ? decodeURIComponent(req.params.channelname).trim() : "";
    if (!channelParam) {
        return res.status(400).json({ error: "Channel name required" });
    }

    const now = Date.now();
    if (now - channelStateCache.at >= CHANNEL_CACHE_MS) {
        const state = parseChannelState();
        channelStateCache = { ...state, at: now };
    }

    const { onlineUsers, userChannels } = channelStateCache;
    const targetChannelLower = channelParam.toLowerCase();

    // Filter users currently online, not in game, and matching channel
    const matchedUsers = [];
    for (const u of onlineUsers) {
        if (u.gameId && u.gameId !== "0") {
            continue;
        }
        const userCh = (userChannels[u.name.toLowerCase()] || "DotA and Friends").toLowerCase();
        if (userCh === targetChannelLower) {
            matchedUsers.push(u.name);
        }
    }

    // Determine op / admin icons
    const opSet = new Set();
    if (matchedUsers.length > 0 && pool) {
        try {
            const [rows] = await pool.query(
                "SELECT username FROM pvpgn_BNET WHERE (auth_admin = 'true' OR auth_operator = 'true') AND username IN (?)",
                [matchedUsers]
            );
            for (const r of rows) {
                if (r.username) opSet.add(r.username.toLowerCase());
            }
        } catch (e) {
            // fallback
        }
    }

    const baseUrl = getBaseUrl(req);
    const users = matchedUsers.map(name => ({
        name,
        icon: opSet.has(name.toLowerCase())
            ? `${baseUrl}/theme/assets/images/icons/op.png`
            : `${baseUrl}/theme/assets/images/icons/game.png`
    }));

    const topicObj = getChannelTopic(channelParam);
    const response = {
        users,
        ...topicObj
    };

    res.json(response);
}

app.get("/api/channel/:channelname", handleChannelRequest);
app.get("/new/api/channel/:channelname", handleChannelRequest);

// GProxy admin badge highlighting endpoint (MainGUI.cpp:9760)
app.get("/api/admins", async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    try {
        const [rows] = await pool.execute(
            "SELECT acct_username FROM pvpgn_BNET WHERE auth_admin = 'true' ORDER BY acct_username ASC"
        );
        const admins = rows.map(r => r.acct_username).filter(Boolean);
        res.json({ success: true, admins });
    } catch (err) {
        console.error("Admins API error:", err.message);
        res.status(500).json({ success: false, admins: [] });
    }
});

// GProxy modern QML host bot list endpoint (QmlBridge.cpp:3673)
app.get("/api/bots", async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    try {
        const [rows] = await pool.query(
            "SELECT acct_username AS name FROM pvpgn_BNET WHERE auth_botlogin = 'true' ORDER BY uid ASC"
        );
        res.json({ data: rows });
    } catch (err) {
        console.error("Bots API error:", err.message);
        res.status(500).json({ error: err.message, data: [] });
    }
});

// -----------------------------
// VPS Realm Chat Service with MySQL Persistence & Moderation
// -----------------------------
const realmChatSessions = new Map(); // token -> { username, createdAt }
const realmChatMessages = [];        // ring buffer: { id, username, text, created_at }
let realmChatCursor = 0;
const REALM_CHAT_MAX_MESSAGES = 200;
const REALM_CHAT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function getBearerToken(req) {
    const auth = req.headers.authorization || "";
    if (auth.startsWith("Bearer ")) {
        return auth.slice(7).trim();
    }
    return "";
}

function cleanRealmChatSessions() {
    const now = Date.now();
    for (const [token, session] of realmChatSessions.entries()) {
        if (now - session.createdAt > REALM_CHAT_SESSION_TTL_MS) {
            realmChatSessions.delete(token);
        }
    }
}
setInterval(cleanRealmChatSessions, 10 * 60 * 1000);

async function initChatTables() {
    if (!pool) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS pvpgn_chat_logs (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                source VARCHAR(16) NOT NULL DEFAULT 'web',
                username VARCHAR(64) NOT NULL,
                channel VARCHAR(64) NOT NULL DEFAULT 'DotA and Friends',
                message VARCHAR(512) NOT NULL,
                ip_address VARCHAR(45) DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_created (created_at),
                INDEX idx_user (username)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS pvpgn_chat_mutes (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(64) NOT NULL UNIQUE,
                muted_by VARCHAR(64) NOT NULL,
                reason VARCHAR(255) DEFAULT '',
                expires_at TIMESTAMP NULL DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_user (username)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS pvpgn_ip_bans (
                id INT AUTO_INCREMENT PRIMARY KEY,
                ip VARCHAR(64) NOT NULL,
                username VARCHAR(64) DEFAULT NULL,
                banned_by VARCHAR(64) NOT NULL DEFAULT 'Admin',
                reason VARCHAR(255) DEFAULT 'Banned by admin',
                banned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_active TINYINT(1) DEFAULT 1,
                INDEX idx_ip (ip),
                INDEX idx_username (username)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS pvpgn_account_ips (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(64) NOT NULL,
                ip_address VARCHAR(45) NOT NULL,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_user_ip (username, ip_address),
                INDEX idx_ip (ip_address),
                INDEX idx_user (username)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS reg_tokens (
                username VARCHAR(32) NOT NULL,
                kind VARCHAR(16) NOT NULL,
                token VARCHAR(64) NOT NULL,
                expires_ts BIGINT NOT NULL,
                PRIMARY KEY (username, kind),
                INDEX idx_reg_tokens_token (token)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        // Seed in-memory buffer from database on startup so history persists across restarts
        const [rows] = await pool.query(
            "SELECT id, source, username, message, created_at FROM pvpgn_chat_logs ORDER BY id DESC LIMIT 50"
        );
        if (rows && rows.length > 0) {
            rows.reverse();
            for (const r of rows) {
                const displayName = r.source === "bnet" ? `[BNet] ${r.username}` : r.username;
                realmChatMessages.push({
                    id: ++realmChatCursor,
                    username: displayName,
                    text: r.message,
                    created_at: new Date(r.created_at).getTime()
                });
            }
        }
    } catch (err) {
        console.error("Failed to init chat tables:", err.message);
    }
}
initChatTables();

async function isUserMuted(username) {
    if (!pool || !username) return false;
    try {
        const [rows] = await pool.query(
            "SELECT id, reason, expires_at FROM pvpgn_chat_mutes WHERE LOWER(username) = LOWER(?) LIMIT 1",
            [username]
        );
        if (!rows || rows.length === 0) return false;
        const mute = rows[0];
        if (mute.expires_at && new Date(mute.expires_at).getTime() <= Date.now()) {
            await pool.execute("DELETE FROM pvpgn_chat_mutes WHERE id = ?", [mute.id]);
            return false;
        }
        return mute;
    } catch (err) {
        return false;
    }
}

app.options(["/api/realm-chat/session", "/api/realm-chat/send", "/api/realm-chat/poll", "/api/realm-chat/users", "/api/realm-chat/history"], (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.sendStatus(204);
});

app.post("/api/realm-chat/session", (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
    if (!username) {
        return res.status(400).json({ ok: false, error: "Username required" });
    }
    const token = crypto.randomBytes(16).toString("hex");
    realmChatSessions.set(token, { username, createdAt: Date.now() });
    res.json({ ok: true, token, cursor: realmChatCursor });
});

const userPresenceMap = {};
const BNET_TO_WEB_PIPE = "/var/pvpgn/bnet_to_web.pipe";
const WEB_TO_BNET_PIPE = "/var/pvpgn/web_to_bnet.pipe";

// bnetd segfaults on SIGHUP in this build; bnban.conf is auto-checked every 10s via ipban_check_int
// and account lock/unlock is piped in real-time via WEB_TO_BNET_PIPE.
async function signalPvpgnRehash() {
    return true;
}

function pollBnetIncomingMessages() {
    try {
        if (!fs.existsSync(BNET_TO_WEB_PIPE)) return;
        const content = fs.readFileSync(BNET_TO_WEB_PIPE, "utf-8");
        if (!content || !content.trim()) return;

        fs.writeFileSync(BNET_TO_WEB_PIPE, "", { mode: 0o666 });

        const lines = content.split("\n");
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const parts = trimmed.split("\t");

            if (parts[0] === "__PRESENCE__") {
                const uname = (parts[1] || "").toLowerCase().trim();
                const presType = (parts[2] || "ONLINE").toUpperCase().trim();
                const reason = parts.slice(3).join("\t").trim();

                if (uname) {
                    if (presType === "OFFLINE") {
                        delete userPresenceMap[uname];
                    } else if (presType === "DND") {
                        if (!reason && userPresenceMap[uname]?.state === "dnd") {
                            delete userPresenceMap[uname];
                        } else {
                            userPresenceMap[uname] = { state: "dnd", reason: reason || "Do Not Disturb", at: Date.now() };
                        }
                    } else if (presType === "AWAY") {
                        if (!reason && userPresenceMap[uname]?.state === "away") {
                            delete userPresenceMap[uname];
                        } else {
                            userPresenceMap[uname] = { state: "away", reason: reason || "Away", at: Date.now() };
                        }
                    } else {
                        delete userPresenceMap[uname];
                    }
                }
                continue;
            }

            if (parts[0] === "__MUTE__") {
                const targetUser = (parts[1] || "").trim();
                const mutedBy = (parts[2] || "BNet Moderator").trim();
                const reason = (parts[3] || "Violation").trim();
                const minutes = parseInt(parts[4], 10) || 0;
                if (targetUser && pool) {
                    const expiresAt = minutes > 0 ? new Date(Date.now() + minutes * 60000) : null;
                    pool.execute(
                        `INSERT INTO pvpgn_chat_mutes (username, muted_by, reason, expires_at)
                         VALUES (?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE muted_by = VALUES(muted_by), reason = VALUES(reason), expires_at = VALUES(expires_at)`,
                        [targetUser, mutedBy, reason, expiresAt]
                    ).catch(e => console.error("Error syncing in-game mute to DB:", e.message));
                }
                continue;
            }

            if (parts[0] === "__UNMUTE__") {
                const targetUser = (parts[1] || "").trim();
                if (targetUser && pool) {
                    pool.execute("DELETE FROM pvpgn_chat_mutes WHERE LOWER(username) = LOWER(?)", [targetUser])
                        .catch(e => console.error("Error syncing in-game unmute to DB:", e.message));
                }
                continue;
            }

            if (parts[0] === "__BAN__" || parts[0] === "__LOCK__") {
                let targetUser = (parts[1] || "").trim();
                const bannedBy = (parts[2] || "BNet Moderator").trim();
                const reason = (parts[3] || "Server Ban").trim();
                let targetIp = (parts[4] || "").trim();
                const durationSeconds = parseInt(parts[5] || "0", 10) || 0;

                if (targetUser && pool) {
                    if (!isRootIdentity(targetUser)) {
                        (async () => {
                            try {
                                if (/^[\d\.\:\/]+$/.test(targetUser) && !targetIp) {
                                    targetIp = targetUser;
                                    targetUser = "";
                                }

                                // 1. If target IP not provided from in-game, resolve from DB
                                if ((!targetIp || targetIp === "N/A") && targetUser) {
                                    const [rows] = await pool.query(
                                        "SELECT acct_lastlogin_ip FROM pvpgn_BNET WHERE LOWER(username) = LOWER(?) OR LOWER(acct_username) = LOWER(?) LIMIT 1",
                                        [targetUser, targetUser]
                                    );
                                    if (rows && rows.length > 0 && rows[0].acct_lastlogin_ip) {
                                        targetIp = rows[0].acct_lastlogin_ip.trim();
                                    }
                                }
                                if ((!targetIp || targetIp === "N/A") && targetUser) {
                                    const [ipRows] = await pool.query(
                                        "SELECT ip_address FROM pvpgn_account_ips WHERE LOWER(username) = LOWER(?) ORDER BY last_seen DESC LIMIT 1",
                                        [targetUser]
                                    );
                                    if (ipRows && ipRows.length > 0 && ipRows[0].ip_address) {
                                        targetIp = ipRows[0].ip_address.trim();
                                    }
                                }
                                const effectiveIp = targetIp || "N/A";
                                const lockTime = durationSeconds > 0 ? Math.floor(Date.now() / 1000) + durationSeconds : 0;
                                const expiresAt = durationSeconds > 0 ? new Date(Date.now() + durationSeconds * 1000) : null;

                                // 2. Lock target user account in database (if username provided)
                                if (targetUser) {
                                    await pool.execute(
                                        "UPDATE pvpgn_BNET SET auth_lock = 'true', auth_lockreason = ?, auth_locktime = ? WHERE LOWER(username) = LOWER(?) OR LOWER(acct_username) = LOWER(?)",
                                        [reason, lockTime, targetUser, targetUser]
                                    );
                                }

                                // 3. Always record in admin database table (pvpgn_ip_bans)
                                await pool.execute(
                                    `INSERT INTO pvpgn_ip_bans (ip, username, banned_by, reason, is_active, expires_at) 
                                     VALUES (?, ?, ?, ?, 1, ?)`,
                                    [effectiveIp, targetUser || null, bannedBy, reason, expiresAt]
                                );

                                // 4. Only enforce IP ban in bnban.conf if target was explicitly an IP (not an account ban)
                                if (!targetUser && effectiveIp !== "N/A" && /^[\d\.\:\/]+$/.test(effectiveIp)) {
                                    const banFile = "/etc/pvpgn/bnban.conf";
                                    let exists = false;
                                    if (fs.existsSync(banFile)) {
                                        const lines = fs.readFileSync(banFile, "utf-8").split("\n");
                                        exists = lines.some(l => l.trim().startsWith(effectiveIp));
                                    }
                                    if (!exists) {
                                        fs.appendFileSync(banFile, `${effectiveIp}\n`, "utf-8");
                                    }
                                }
                            } catch (e) {
                                console.error("Error syncing in-game ban to DB:", e.message);
                            }
                        })();
                    }
                }
                continue;
            }

            if (parts[0] === "__UNBAN__" || parts[0] === "__UNLOCK__") {
                const targetUser = (parts[1] || "").trim();
                if (targetUser && pool) {
                    (async () => {
                        try {
                            await pool.execute(
                                "UPDATE pvpgn_BNET SET auth_lock = 'false', auth_lockreason = '' WHERE LOWER(username) = LOWER(?) OR LOWER(acct_username) = LOWER(?)",
                                [targetUser, targetUser]
                            );
                            await pool.execute(
                                "UPDATE pvpgn_ip_bans SET is_active = 0 WHERE LOWER(username) = LOWER(?)",
                                [targetUser]
                            );

                            const [ipRows] = await pool.query(
                                "SELECT ip FROM pvpgn_ip_bans WHERE LOWER(username) = LOWER(?) AND ip != 'N/A'",
                                [targetUser]
                            );
                            if (ipRows && ipRows.length > 0) {
                                const banFile = "/etc/pvpgn/bnban.conf";
                                if (fs.existsSync(banFile)) {
                                    const bannedIps = new Set(ipRows.map(r => r.ip.trim()));
                                    const lines = fs.readFileSync(banFile, "utf-8").split("\n");
                                    const kept = lines.filter(l => {
                                        const trimmed = l.trim();
                                        if (!trimmed || trimmed.startsWith("#")) return true;
                                        return !bannedIps.has(trimmed.split(/\s+/)[0]);
                                    });
                                    fs.writeFileSync(banFile, kept.join("\n"), "utf-8");
                                }
                            }
                            await signalPvpgnRehash();
                        } catch (e) {
                            console.error("Error syncing in-game unban to DB:", e.message);
                        }
                    })();
                }
                continue;
            }

            if (parts[0] === "__IPBAN__") {
                const targetIp = (parts[1] || "").trim();
                const bannedBy = (parts[2] || "BNet Moderator").trim();
                const reason = (parts[3] || "IP Banned").trim();

                if (targetIp && pool) {
                    (async () => {
                        try {
                            const banFile = "/etc/pvpgn/bnban.conf";
                            let exists = false;
                            if (fs.existsSync(banFile)) {
                                const lines = fs.readFileSync(banFile, "utf-8").split("\n");
                                exists = lines.some(l => l.trim().startsWith(targetIp));
                            }
                            if (!exists) {
                                fs.appendFileSync(banFile, `${targetIp}\n`, "utf-8");
                                await signalPvpgnRehash();
                            }

                            // Lock all accounts associated with this IP
                            await pool.execute(
                                `UPDATE pvpgn_BNET SET auth_lock = 'true', auth_lockreason = ? 
                                 WHERE (
                                     acct_lastlogin_ip = ? OR username IN (
                                         SELECT username FROM pvpgn_account_ips WHERE ip_address = ?
                                     )
                                 )`,
                                [`Associated with banned IP: ${targetIp}`, targetIp, targetIp]
                            );

                            await pool.execute(
                                `INSERT INTO pvpgn_ip_bans (ip, username, banned_by, reason) 
                                 VALUES (?, NULL, ?, ?)`,
                                [targetIp, bannedBy, reason]
                            );
                        } catch (e) {
                            console.error("Error executing IPBAN sync:", e.message);
                        }
                    })();
                } else {
                    signalPvpgnRehash().catch(() => { });
                }
                continue;
            }

            if (parts[0] === "__LOGIN__") {
                const uname = (parts[1] || "").trim();
                const uip = (parts[2] || "").trim();
                if (uname && uip && pool) {
                    (async () => {
                        try {
                            await pool.execute(
                                `INSERT INTO pvpgn_account_ips (username, ip_address) 
                                 VALUES (?, ?) 
                                 ON DUPLICATE KEY UPDATE last_seen = NOW()`,
                                [uname, uip]
                            );

                            // Check if account is locked in pvpgn_BNET
                            const [acctRows] = await pool.query(
                                `SELECT auth_lock, auth_lockreason FROM pvpgn_BNET 
                                 WHERE LOWER(username) = LOWER(?) OR LOWER(acct_username) = LOWER(?) LIMIT 1`,
                                [uname, uname]
                            );
                            const isAcctLocked = acctRows && acctRows.length > 0 && acctRows[0].auth_lock === "true";

                            // Anti-VPN check: is this account or IP active in pvpgn_ip_bans?
                            const [banRows] = await pool.query(
                                `SELECT id, ip, reason FROM pvpgn_ip_bans 
                                 WHERE is_active = 1 AND (ip = ? OR LOWER(username) = LOWER(?)) LIMIT 1`,
                                [uip, uname]
                            );
                            const isIpBanned = banRows && banRows.length > 0;

                            if ((isAcctLocked || isIpBanned) && !isRootIdentity(uname)) {
                                const reason = (banRows && banRows[0]?.reason) || acctRows[0]?.auth_lockreason || "Account locked by administrator";
                                const cleanReason = reason.replace(/[\r\n\t]+/g, " ");
                                const lockMsg = `__LOCK__\t${uname}\t${cleanReason}\n`;
                                fs.appendFileSync(WEB_TO_BNET_PIPE, lockMsg, { mode: 0o666 });

                                // If IP is banned, also make sure it's in bnban.conf and signal rehash
                                if (isIpBanned && uip) {
                                    const banFile = "/etc/pvpgn/bnban.conf";
                                    let exists = false;
                                    if (fs.existsSync(banFile)) {
                                        const lines = fs.readFileSync(banFile, "utf-8").split("\n");
                                        exists = lines.some(l => l.trim().startsWith(uip));
                                    }
                                    if (!exists) {
                                        fs.appendFileSync(banFile, `${uip}\n`, "utf-8");
                                        await signalPvpgnRehash();
                                    }
                                }
                            }
                        } catch (e) {
                            console.error("Login tracking error:", e.message);
                        }
                    })();
                }
                continue;
            }

            if (parts[0] === "__WARN__") {
                const targetUser = (parts[1] || "").trim();
                const adminUser = (parts[2] || "Admin").trim();
                const reason = parts.slice(3).join("\t").trim();
                console.log(`[WARN] Admin ${adminUser} warned ${targetUser}: ${reason}`);
                continue;
            }

            if (parts[0] === "__TOPIC__") {
                const adminUser = (parts[1] || "Admin").trim();
                const topic = parts.slice(2).join("\t").trim();
                console.log(`[TOPIC] Admin ${adminUser} set topic: ${topic}`);
                continue;
            }

            let sender = "";
            let channel = "DotA and Friends";
            let text = "";
            if (parts.length >= 3) {
                sender = parts[0].trim();
                channel = parts[1].trim() || "DotA and Friends";
                text = parts.slice(2).join("\t").trim();
            } else if (parts.length === 2) {
                sender = parts[0].trim();
                text = parts[1].trim();
            } else {
                continue;
            }

            if (sender && text) {
                const msg = {
                    id: ++realmChatCursor,
                    username: `[BNet] ${sender}`,
                    text: text.slice(0, 300),
                    channel: channel,
                    created_at: Date.now()
                };
                realmChatMessages.push(msg);
                if (realmChatMessages.length > REALM_CHAT_MAX_MESSAGES) {
                    realmChatMessages.shift();
                }

                // Persist BNet message to MySQL
                if (pool) {
                    pool.query(
                        "INSERT INTO pvpgn_chat_logs (source, username, channel, message) VALUES ('bnet', ?, ?, ?)",
                        [sender, channel, text.slice(0, 512)]
                    ).catch(e => console.error("Chat log error:", e.message));
                }
            }
        }
    } catch (err) {
        // pipe read/write lock tolerance
    }
}
setInterval(pollBnetIncomingMessages, 500);

// -----------------------------
// Real-Time Database Lock Sync Watcher
// Auto-detects direct MySQL/Adminer changes to auth_lock and syncs to bnetd RAM
// -----------------------------
const LOCKED_ACCOUNTS_FILE = "/var/pvpgn/locked_accounts.txt";
let previousLockedUsers = new Set();
let isInitialLockSync = true;

async function syncDatabaseLocksWithBnetd() {
    if (!pool) return;
    try {
        // Auto-unlock expired bans in pvpgn_BNET and pvpgn_ip_bans
        await pool.execute(
            `UPDATE pvpgn_BNET 
             SET auth_lock = 'false', auth_lockreason = '', auth_locktime = 0 
             WHERE auth_lock = 'true' AND auth_locktime > 0 AND auth_locktime <= UNIX_TIMESTAMP()`
        );
        await pool.execute(
            `UPDATE pvpgn_ip_bans 
             SET is_active = 0 
             WHERE is_active = 1 AND expires_at IS NOT NULL AND expires_at <= NOW()`
        );

        const [rows] = await pool.query(
            "SELECT LOWER(username) AS username, auth_lockreason FROM pvpgn_BNET WHERE auth_lock = 'true'"
        );
        const currentLocked = new Map();
        for (const r of rows) {
            const u = (r.username || "").trim().toLowerCase();
            if (u && !isRootIdentity(u)) {
                currentLocked.set(u, r.auth_lockreason || "Account locked in database");
            }
        }

        // 1. Update /var/pvpgn/locked_accounts.txt for direct Lua fast-path check
        const lines = Array.from(currentLocked.keys()).join("\n");
        try {
            fs.writeFileSync(LOCKED_ACCOUNTS_FILE, lines + "\n", { mode: 0o666 });
        } catch (e) { }

        // 2. Check for newly locked accounts (set directly in MySQL / Adminer)
        for (const [u, reason] of currentLocked.entries()) {
            if (!previousLockedUsers.has(u) && !isInitialLockSync) {
                const cleanReason = (reason || "Account locked in database").replace(/[\r\n\t]+/g, " ");
                const pipeLine = `__LOCK__\t${u}\t${cleanReason}\n`;
                try {
                    fs.appendFileSync(WEB_TO_BNET_PIPE, pipeLine, { mode: 0o666 });
                } catch (e) { }
            }
        }

        // 3. Check for newly unlocked accounts (unlocked directly in MySQL / Adminer)
        if (!isInitialLockSync) {
            for (const prev of previousLockedUsers) {
                if (!currentLocked.has(prev)) {
                    const pipeLine = `__UNLOCK__\t${prev}\n`;
                    try {
                        fs.appendFileSync(WEB_TO_BNET_PIPE, pipeLine, { mode: 0o666 });
                    } catch (e) { }
                }
            }
        }

        previousLockedUsers = new Set(currentLocked.keys());
        isInitialLockSync = false;
    } catch (err) {
        // tolerate db transient err
    }
}
setInterval(syncDatabaseLocksWithBnetd, 1000);
setTimeout(syncDatabaseLocksWithBnetd, 500);

app.post("/api/realm-chat/send", async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    const token = getBearerToken(req);
    let session = token ? realmChatSessions.get(token) : null;

    // Support Admin Portal authentication via admin_token cookie
    if (!session) {
        const cookies = parseCookies(req);
        if (verifyAdminToken(cookies.admin_token)) {
            session = { username: req.body.username || "Server Admin", isAdmin: true };
        }
    }

    // Support direct username for authorized callers / GProxy client
    if (!session && typeof req.body.username === "string" && req.body.username.trim()) {
        const uname = req.body.username.trim();
        session = { username: uname, createdAt: Date.now() };
        const autoToken = crypto.randomBytes(16).toString("hex");
        realmChatSessions.set(autoToken, session);
    }

    if (!session) {
        return res.status(401).json({ ok: false, error: "Invalid or expired session" });
    }

    // Check if user is muted (admin is never muted)
    if (!session.isAdmin) {
        const muteInfo = await isUserMuted(session.username);
        if (muteInfo) {
            const reason = muteInfo.reason ? ` Reason: ${muteInfo.reason}` : "";
            const exp = muteInfo.expires_at ? ` (Expires: ${new Date(muteInfo.expires_at).toLocaleString()})` : " (Permanent)";
            return res.status(403).json({
                ok: false,
                error: `You are muted from Realm Chat.${reason}${exp}`
            });
        }
    }

    const text = (
        typeof req.body.text === "string" ? req.body.text :
            (typeof req.body.message === "string" ? req.body.message : "")
    ).trim();

    if (!text) {
        return res.status(400).json({ ok: false, error: "Message text required" });
    }

    const targetChannel = (
        typeof req.body.channel === "string" && req.body.channel.trim() && req.body.channel !== "all"
    ) ? req.body.channel.trim() : "DotA and Friends";

    const cleanText = text.slice(0, 300);
    const msg = {
        id: ++realmChatCursor,
        username: session.username,
        text: cleanText,
        channel: targetChannel,
        created_at: Date.now()
    };
    realmChatMessages.push(msg);
    if (realmChatMessages.length > REALM_CHAT_MAX_MESSAGES) {
        realmChatMessages.shift();
    }

    // Persist Web message to MySQL
    const clientIp = getClientIp(req);
    if (pool) {
        pool.query(
            "INSERT INTO pvpgn_chat_logs (source, username, channel, message, ip_address) VALUES ('web', ?, ?, ?, ?)",
            [session.username, targetChannel, cleanText, clientIp || null]
        ).catch(e => console.error("Chat log error:", e.message));
    }

    // Forward to Battle.net channel pipe for PvPGN Lua to broadcast
    try {
        const pipeLine = `${session.username}\t${cleanText.replace(/[\r\n\t]+/g, " ")}\n`;
        fs.appendFileSync(WEB_TO_BNET_PIPE, pipeLine, { mode: 0o666 });
    } catch (err) {
        console.error("Failed to forward to Battle.net pipe:", err.message);
    }

    res.json({ ok: true, success: true });
});

app.get("/api/realm-chat/poll", (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    const token = getBearerToken(req);
    let session = token ? realmChatSessions.get(token) : null;
    if (!session) {
        const cookies = parseCookies(req);
        if (verifyAdminToken(cookies.admin_token)) {
            session = { username: "Server Admin", isAdmin: true };
        }
    }
    const clientCursor = parseInt(req.query.cursor, 10) || 0;
    const newMessages = realmChatMessages.filter(m => m.id > clientCursor);
    res.json({
        ok: true,
        cursor: realmChatCursor,
        messages: newMessages
    });
});

app.get("/api/realm-chat/history", async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    try {
        if (!pool) return res.json({ ok: true, logs: [] });
        const [rows] = await pool.query(
            "SELECT id, source, username, channel, message, created_at FROM pvpgn_chat_logs ORDER BY id DESC LIMIT ?",
            [limit]
        );
        res.json({ ok: true, logs: rows });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Admin Moderation API
app.get("/api/admin/chat/logs", requireAdminAuth, async (req, res) => {
    try {
        const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
        const username = typeof req.query.username === "string" ? req.query.username.trim() : "";
        const channel = typeof req.query.channel === "string" ? req.query.channel.trim() : "";
        const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

        let query = "SELECT id, source, username, channel, message, ip_address, created_at FROM pvpgn_chat_logs ";
        let params = [];
        const conditions = [];
        if (search) {
            conditions.push("(LOWER(username) LIKE LOWER(?) OR LOWER(message) LIKE LOWER(?) OR LOWER(channel) LIKE LOWER(?))");
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }
        if (username) {
            conditions.push("LOWER(username) LIKE LOWER(?)");
            params.push(`%${username}%`);
        }
        if (channel && channel !== "all") {
            conditions.push("LOWER(channel) = LOWER(?)");
            params.push(channel);
        }
        if (conditions.length > 0) {
            query += "WHERE " + conditions.join(" AND ") + " ";
        }
        query += "ORDER BY id DESC LIMIT ?";
        params.push(limit);

        const [rows] = await pool.query(query, params);
        res.json({ success: true, logs: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/admin/chat/channels", requireAdminAuth, async (req, res) => {
    try {
        const [rows] = await pool.query(
            "SELECT DISTINCT channel FROM pvpgn_chat_logs WHERE channel IS NOT NULL AND channel != '' ORDER BY channel ASC"
        );
        res.json({ success: true, channels: rows.map(r => r.channel) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/admin/chat/logs/purge", requireAdminAuth, async (req, res) => {
    try {
        const range = req.body.range;
        let deleted = 0;
        if (range === "7d") {
            const [result] = await pool.query("DELETE FROM pvpgn_chat_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)");
            deleted = result.affectedRows;
        } else if (range === "30d") {
            const [result] = await pool.query("DELETE FROM pvpgn_chat_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL 30 DAY)");
            deleted = result.affectedRows;
        } else if (range === "all") {
            const [result] = await pool.query("TRUNCATE TABLE pvpgn_chat_logs");
            deleted = result.affectedRows || 0;
        } else {
            return res.status(400).json({ error: "Invalid purge range" });
        }
        res.json({ success: true, message: `Purged chat logs (${range}).`, deleted });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/admin/chat/mutes", requireAdminAuth, async (req, res) => {
    try {
        const [rows] = await pool.query(
            "SELECT id, username, muted_by, reason, expires_at, created_at, (expires_at IS NULL OR expires_at > NOW()) AS is_active FROM pvpgn_chat_mutes ORDER BY id DESC"
        );
        res.json({ success: true, mutes: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/admin/chat/mute", requireAdminAuth, async (req, res) => {
    try {
        const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
        const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : "Rule violation";
        const minutes = parseInt(req.body.minutes, 10) || 0;

        if (!username) return res.status(400).json({ error: "Username required" });

        const adminName = req.admin?.username || "Admin";
        let expiresAt = null;
        if (minutes > 0) {
            expiresAt = new Date(Date.now() + minutes * 60 * 1000);
        }

        // 1. Insert/update pvpgn_chat_mutes for web audit & tracking
        await pool.execute(
            `INSERT INTO pvpgn_chat_mutes (username, muted_by, reason, expires_at)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE muted_by = VALUES(muted_by), reason = VALUES(reason), expires_at = VALUES(expires_at)`,
            [username, adminName, reason, expiresAt]
        );

        // 2. Update PvPGN native table pvpgn_BNET so server core enforces mute
        const mutetimeSec = minutes > 0 ? Math.floor(Date.now() / 1000) + (minutes * 60) : 0;
        await pool.execute(
            `UPDATE pvpgn_BNET SET auth_mute = 'true', auth_mutetime = ?, auth_mutereason = ? WHERE LOWER(acct_username) = LOWER(?)`,
            [mutetimeSec, reason, username]
        );

        // 3. Pipe command into PvPGN Lua VM to update in-memory active session & send instant fallback message
        try {
            if (fs.existsSync(path.dirname(WEB_TO_BNET_PIPE))) {
                fs.appendFileSync(WEB_TO_BNET_PIPE, `__MUTE__\t${username}\t${reason}\t${minutes}\n`, { mode: 0o666 });
            }
        } catch (pipeErr) {
            console.error("Pipe write error on mute:", pipeErr);
        }

        res.json({ success: true, message: `User "${username}" muted${minutes > 0 ? ` for ${minutes}m` : " permanently"}.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/admin/chat/unmute", requireAdminAuth, async (req, res) => {
    try {
        const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
        if (!username) return res.status(400).json({ error: "Username required" });

        // 1. Remove from pvpgn_chat_mutes
        await pool.execute("DELETE FROM pvpgn_chat_mutes WHERE LOWER(username) = LOWER(?)", [username]);

        // 2. Restore PvPGN native table pvpgn_BNET
        await pool.execute(
            "UPDATE pvpgn_BNET SET auth_mute = 'false', auth_mutetime = 0, auth_mutereason = NULL WHERE LOWER(acct_username) = LOWER(?)",
            [username]
        );

        // 3. Pipe command into PvPGN Lua VM to restore live session
        try {
            if (fs.existsSync(path.dirname(WEB_TO_BNET_PIPE))) {
                fs.appendFileSync(WEB_TO_BNET_PIPE, `__UNMUTE__\t${username}\n`, { mode: 0o666 });
            }
        } catch (pipeErr) {
            console.error("Pipe write error on unmute:", pipeErr);
        }

        res.json({ success: true, message: `User "${username}" unmuted.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/realm-chat/users", (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.set("Cache-Control", "no-cache");

    if (Date.now() - gamesCache.at >= GAMES_CACHE_MS) {
        const parsed = parseStatusFile();
        gamesCache = { ...parsed, at: Date.now() };
    }

    if (Date.now() - channelStateCache.at >= CHANNEL_CACHE_MS) {
        const state = parseChannelState();
        channelStateCache = { ...state, at: Date.now() };
    }

    const { games, activeUsers } = gamesCache;
    const { userChannels } = channelStateCache;

    const gameMap = new Map();
    for (const g of games) {
        if (g.id) gameMap.set(String(g.id), g.name);
    }

    const users = activeUsers.map(u => {
        const pres = userPresenceMap[u.username.toLowerCase()];
        const inGame = u.gameId && u.gameId !== "0";
        const gameName = inGame ? (gameMap.get(String(u.gameId)) || "Custom Game") : "";
        const chName = (!inGame && userChannels && userChannels[u.username.toLowerCase()])
            ? userChannels[u.username.toLowerCase()]
            : "DotA and Friends";

        let state = inGame ? "ingame" : "channel";
        let statusText = inGame ? `In Game: ${gameName}` : `In Channel: ${chName}`;
        if (pres) {
            state = pres.state;
            statusText = `${pres.state.toUpperCase()}: ${pres.reason}`;
        }

        return {
            username: u.username,
            client: u.client,
            country: u.country,
            state: state,
            location: inGame ? gameName : chName,
            status_text: statusText,
            reason: pres ? pres.reason : ""
        };
    });

    res.json({
        ok: true,
        count: users.length,
        users
    });
});



// -----------------------------
// Rate limiting (per-IP and per-Email, in-memory)
// -----------------------------

const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_MAX = 10;                   // 10 requests per window
const rateMap = new Map();

function isRegisterRateLimited(ip) {

    const now = Date.now();
    const entry = rateMap.get(ip);

    if (!entry || now - entry.start >= RATE_WINDOW_MS) {
        rateMap.set(ip, { start: now, count: 1 });
        return false;
    }

    if (entry.count >= RATE_MAX) {
        return true;
    }

    entry.count += 1;
    return false;

}

// Normalize an email address for duplicate checking & rate limiting (lowercase + trim)
function normalizeEmail(email) {

    return typeof email === "string" ? email.trim().toLowerCase() : "";

}

const EMAIL_RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const EMAIL_RATE_MAX = 3;                   // Max 3 verification / reset requests per email per 15 min
const emailRateMap = new Map();

function isEmailRateLimited(rawEmail) {

    const email = normalizeEmail(rawEmail);
    if (!email) return false;

    const now = Date.now();
    const entry = emailRateMap.get(email);

    if (!entry || now - entry.start >= EMAIL_RATE_WINDOW_MS) {
        emailRateMap.set(email, { start: now, count: 1 });
        return false;
    }

    if (entry.count >= EMAIL_RATE_MAX) {
        return true;
    }

    entry.count += 1;
    return false;

}


// -----------------------------
// Anti-Evasion & VPN Detection
// -----------------------------

const vpnCache = new Map();
const VPN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const KNOWN_VPN_ASN_REGEX = /digitalocean|ovh|hetzner|linode|choopa|vultr|m247|datacamp|amazon|google\s*cloud|microsoft|oracle|contabo|leaseweb|fastly|akamai|packethub|cogent|hostinger|pureservers|vpn|hosting/i;

const DISPOSABLE_EMAIL_DOMAINS = new Set([
    "tempmail.com", "temp-mail.org", "10minutemail.com", "guerrillamail.com",
    "guerrillamail.net", "guerrillamail.biz", "guerrillamail.org", "sharklasers.com",
    "yopmail.com", "yopmail.fr", "yopmail.net", "mailinator.com", "dispostable.com",
    "trashmail.com", "trashmail.net", "throwawaymail.com", "getairmail.com",
    "fakemailgenerator.com", "mohmal.com", "crazymailing.com", "inboxkitten.com",
    "tempmailo.com", "maildrop.cc", "getnada.com", "disposablemail.com"
]);

function getClientIp(req) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) {
        const parts = xff.split(",");
        const first = parts[0].trim();
        if (first) return first;
    }
    return req.headers["x-real-ip"] || req.socket?.remoteAddress || req.ip || "";
}

function isPrivateIp(ip) {
    if (!ip) return true;
    const clean = ip.replace(/^::ffff:/, "").trim();
    if (clean === "127.0.0.1" || clean === "::1" || clean === "localhost") return true;
    if (clean.startsWith("10.") || clean.startsWith("192.168.")) return true;
    const m172 = clean.match(/^172\.(\d+)\./);
    if (m172) {
        const octet = parseInt(m172[1], 10);
        if (octet >= 16 && octet <= 31) return true;
    }
    return false;
}

async function checkVpnOrProxy(ip) {
    if (!ip || isPrivateIp(ip)) {
        return { isVpn: false, provider: "Private/Local", reason: "local_network" };
    }
    const cleanIp = ip.replace(/^::ffff:/, "").trim();
    const cached = vpnCache.get(cleanIp);
    if (cached && (Date.now() - cached.timestamp < VPN_CACHE_TTL_MS)) {
        return cached.result;
    }

    let result = { isVpn: false, provider: "", reason: "" };

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3500);

        const res = await fetch(`http://ip-api.com/json/${cleanIp}?fields=status,message,proxy,hosting,asn,org,isp`, {
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (res.ok) {
            const data = await res.json();
            if (data.status === "success") {
                const orgIsp = `${data.as || ""} ${data.org || ""} ${data.isp || ""}`;
                if (data.proxy) {
                    result = { isVpn: true, provider: data.org || data.isp || "Proxy", reason: "Identified as active Proxy or VPN exit node" };
                } else if (data.hosting) {
                    result = { isVpn: true, provider: data.org || data.isp || "Datacenter", reason: "Datacenter / Cloud hosting IP range" };
                } else if (KNOWN_VPN_ASN_REGEX.test(orgIsp)) {
                    result = { isVpn: true, provider: data.org || data.isp || "Known VPN ASN", reason: "Known VPN / Hosting ASN match" };
                }
            }
        }
    } catch (err) {
        console.warn(`[VPN Check] Lookup for ${cleanIp} failed:`, err.message);
    }

    vpnCache.set(cleanIp, { timestamp: Date.now(), result });
    return result;
}


// -----------------------------
// Validation helpers
// -----------------------------

function isValidUsername(username) {
    if (typeof username !== "string") return false;
    if (/^\s|\s$/.test(username) || /\s{2,}/.test(username)) return false;
    return /^[A-Za-z0-9 _\-\[\]!?@#$,.~\+\(\)]{3,15}$/.test(username);
}

function isValidPassword(password) {

    return typeof password === "string" &&
        password.length >= 6 &&
        password.length <= 12 &&
        /^[\x21-\x7E]+$/.test(password);

}

async function hasValidMxRecord(domain) {
    if (!domain || typeof domain !== "string") return false;
    try {
        const mxRecords = await Promise.race([
            dns.promises.resolveMx(domain),
            new Promise((_, reject) => setTimeout(() => reject(new Error("DNS Timeout")), 2500))
        ]);
        return Array.isArray(mxRecords) && mxRecords.length > 0;
    } catch (err) {
        if (err.code === "ENOTFOUND" || err.code === "ENODATA") {
            return false;
        }
        console.warn(`[DNS MX Check Warning] Domain ${domain} check failed (${err.message}), failing open.`);
        return true;
    }
}

function isValidEmail(email) {

    return typeof email === "string" &&
        email.length <= 128 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

}




// -----------------------------
// Email sending
// -----------------------------

const APP_BASE_URL = process.env.APP_BASE_URL || "https://dotaandfriends.xyz";
const FRONTEND_URL = process.env.FRONTEND_URL || "https://dotaandfriends.xyz";
const MAIL_FROM = process.env.MAIL_FROM || "DotA & Friends <no-reply@dotaandfriends.xyz>";
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAILJET_API_KEY = process.env.MAILJET_API_KEY;
const MAILJET_SECRET_KEY = process.env.MAILJET_SECRET_KEY;
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

// Email providers are tried in order (HTTPS port 443 first to bypass cloud SMTP port 587 blocks):
//   1. Mailjet REST API (HTTPS port 443)
//   2. Resend REST API  (HTTPS port 443)
//   3. Generic SMTP     (with strict 3s timeout)
async function sendEmail(to, subject, html) {
    const errors = [];

    // 1. Mailjet REST API (HTTPS port 443 - bypasses Oracle Cloud port 587 block)
    if (MAILJET_API_KEY && MAILJET_SECRET_KEY) {
        try {
            const res = await fetch("https://api.mailjet.com/v3.1/send", {
                method: "POST",
                headers: {
                    "Authorization": "Basic " + Buffer.from(`${MAILJET_API_KEY}:${MAILJET_SECRET_KEY}`).toString("base64"),
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    Messages: [{
                        From: { Email: "no-reply@dotaandfriends.xyz", Name: "DotA & Friends" },
                        To: [{ Email: to }],
                        Subject: subject,
                        HTMLPart: html
                    }]
                }),
                signal: AbortSignal.timeout(5000)
            });

            if (res.ok) {
                console.log(`[MAIL] Sent to ${to} via Mailjet HTTPS: ${subject}`);
                return true;
            }
            const errText = await res.text().catch(() => "");
            console.error("[MAIL] Mailjet HTTP error:", res.status, errText);
            errors.push(`mailjet:${res.status}`);
        } catch (error) {
            console.error("[MAIL] Mailjet failed:", error.message);
            errors.push(`mailjet:${error.message}`);
        }
    }

    // 2. Resend REST API (HTTPS port 443)
    if (RESEND_API_KEY) {
        try {
            const res = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${RESEND_API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    from: MAIL_FROM,
                    to,
                    subject,
                    html
                }),
                signal: AbortSignal.timeout(5000)
            });

            if (res.ok) {
                console.log(`[MAIL] Sent to ${to} via Resend HTTPS: ${subject}`);
                return true;
            }
            const text = await res.text().catch(() => "");
            console.error("[MAIL] Resend HTTP error:", res.status, text);
            errors.push(`resend:${res.status}`);
        } catch (error) {
            console.error("[MAIL] Resend failed:", error.message);
            errors.push(`resend:${error.message}`);
        }
    }

    // 3. Fallback SMTP (Brevo) with strict 3-second timeout
    if (SMTP_HOST && SMTP_USER) {
        try {
            const transporter = nodemailer.createTransport({
                host: SMTP_HOST,
                port: SMTP_PORT,
                secure: SMTP_PORT === 465,
                connectionTimeout: 3000,
                greetingTimeout: 3000,
                socketTimeout: 3000,
                auth: {
                    user: SMTP_USER,
                    pass: SMTP_PASS
                }
            });

            await transporter.sendMail({
                from: MAIL_FROM,
                to,
                subject,
                html
            });

            console.log(`[MAIL] Sent to ${to} via SMTP ${SMTP_HOST}: ${subject}`);
            return true;
        } catch (error) {
            console.error("[MAIL] SMTP failed:", error.message);
            errors.push(`smtp:${error.message}`);
        }
    }

    console.log("[mail][all-providers-failed]", { to, subject, errors });
    return false;
}


// -----------------------------
// Token helpers
// -----------------------------

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function generateToken() {

    return crypto.randomBytes(32).toString("hex");

}

async function createToken(username, kind) {

    const token = generateToken();
    const expires = Date.now() + TOKEN_TTL_MS;

    await pool.execute(
        `
        INSERT INTO reg_tokens (username, kind, token, expires_ts)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE token = ?, expires_ts = ?
        `,
        [username, kind, token, expires, token, expires]
    );

    return token;

}

async function consumeToken(kind, token) {

    const [rows] = await pool.execute(
        `
        SELECT username, expires_ts
        FROM reg_tokens
        WHERE kind = ? AND token = ?
        LIMIT 1
        `,
        [kind, token]
    );

    if (rows.length === 0) {
        return null;
    }

    const row = rows[0];

    if (Date.now() > Number(row.expires_ts)) {
        await pool.execute(
            "DELETE FROM reg_tokens WHERE kind = ? AND token = ?",
            [kind, token]
        );
        return null;
    }

    await pool.execute(
        "DELETE FROM reg_tokens WHERE kind = ? AND token = ?",
        [kind, token]
    );

    return row.username;

}


// -----------------------------
// HTML page rendering
// -----------------------------

const PAGE_STYLE = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;
justify-content:center;align-items:center;padding:2rem}
.card{background:#1e293b;border-radius:1.5rem;padding:3rem;max-width:480px;width:100%;
text-align:center;border:1px solid #334155}
h1{font-size:1.6rem;font-weight:800;margin-bottom:.75rem}
p{color:#94a3b8;margin-bottom:1.25rem;line-height:1.6}
h1.ok{color:#34d399}
h1.err{color:#f87171}
input{width:100%;padding:.8rem 1rem;margin-bottom:.75rem;border-radius:.75rem;
border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:1rem}
input:focus{outline:2px solid #6366f1;border-color:#6366f1}
button{width:100%;padding:.9rem 1rem;border-radius:.75rem;border:0;
background:#6366f1;color:#fff;font-size:1rem;font-weight:700;cursor:pointer;
transition:background .2s}
button:hover{background:#4f46e5}
a{color:#818cf8;text-decoration:none}
a:hover{text-decoration:underline}
.small{font-size:.8rem;color:#64748b}
`;


function page(title, bodyHtml) {

    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${PAGE_STYLE}</style></head><body><div class="card">${bodyHtml}</div></body></html>`;

}


// -----------------------------
// Routes
// -----------------------------

app.get("/api/health", async (req, res) => {

    try {

        await pool.query("SELECT 1");

        res.json({
            status: "ok"
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            status: "error"
        });

    }

});


app.post("/api/register", async (req, res) => {

    try {

        const clientIp = getClientIp(req);

        if (isRegisterRateLimited(clientIp)) {
            return res.status(429).json({
                success: false,
                error: "Too many registration attempts. Please try again later.",
                message: "Too many registration attempts. Please try again later."
            });
        }

        if (pool) {
            const [bannedIp] = await pool.query(
                "SELECT id, reason FROM pvpgn_ip_bans WHERE is_active = 1 AND ip = ? LIMIT 1",
                [clientIp]
            );
            if (bannedIp && bannedIp.length > 0) {
                return res.status(403).json({
                    success: false,
                    error: "Registration denied. Your network or IP address is banned."
                });
            }
        }

        const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
        const password = typeof req.body.password === "string" ? req.body.password : "";
        const confirmPassword = typeof req.body.confirmPassword === "string" ? req.body.confirmPassword : "";
        const email = typeof req.body.email === "string" ? req.body.email.trim() : "";

        if (pool && email) {
            const [bannedEmail] = await pool.query(
                "SELECT uid FROM pvpgn_BNET WHERE auth_lock = 'true' AND LOWER(acct_email) = LOWER(?) LIMIT 1",
                [email]
            );
            if (bannedEmail && bannedEmail.length > 0) {
                return res.status(403).json({
                    success: false,
                    error: "Registration denied. This email is associated with a banned account."
                });
            }
        }

        // -----------------------------
        // Validate fields
        // -----------------------------

        if (!username || !password || !confirmPassword || !email) {

            return res.status(400).json({
                success: false,
                error: "All fields are required.",
                message: "All fields are required."
            });

        }

        if (!isValidUsername(username)) {

            return res.status(400).json({
                success: false,
                error: "Username must be 3-15 characters (letters, numbers, spaces, and symbols: _ - [ ] ! ? @ # $ , . ~ +).",
                message: "Username must be 3-15 characters (letters, numbers, spaces, and symbols: _ - [ ] ! ? @ # $ , . ~ +)."
            });

        }

        if (!isValidPassword(password)) {

            return res.status(400).json({
                success: false,
                error: "Password must be 6-12 printable ASCII characters without spaces.",
                message: "Password must be 6-12 printable ASCII characters without spaces."
            });

        }

        if (password !== confirmPassword) {

            return res.status(400).json({
                success: false,
                error: "Passwords do not match.",
                message: "Passwords do not match."
            });

        }

        if (!isValidEmail(email)) {

            return res.status(400).json({
                success: false,
                error: "Please enter a valid email address.",
                message: "Please enter a valid email address."
            });

        }

        // -----------------------------
        // Anti-Evasion 1: Disposable Email & MX Check
        // -----------------------------
        const emailDomain = email.split("@")[1]?.toLowerCase();
        if (emailDomain && DISPOSABLE_EMAIL_DOMAINS.has(emailDomain)) {
            return res.status(400).json({
                success: false,
                error: "Temporary or disposable email addresses are not permitted. Please use a valid personal email.",
                message: "Temporary or disposable email addresses are not permitted. Please use a valid personal email."
            });
        }

        const validMx = await hasValidMxRecord(emailDomain);
        if (!validMx) {
            return res.status(400).json({
                success: false,
                error: "The provided email domain does not have valid mail server (MX) records.",
                message: "The provided email domain does not have valid mail server (MX) records."
            });
        }

        // -----------------------------
        // Per-Email Rate Limit (max 3 verification requests / 15 min)
        // -----------------------------
        if (isEmailRateLimited(email)) {
            return res.status(429).json({
                success: false,
                error: "Too many verification requests for this email address. Please try again in 15 minutes.",
                message: "Too many verification requests for this email address. Please try again in 15 minutes."
            });
        }

        // -----------------------------
        // Check for existing account (case-insensitive)
        // -----------------------------

        const [existing] = await pool.execute(
            "SELECT uid FROM pvpgn_BNET WHERE LOWER(acct_username) = LOWER(?) LIMIT 1",
            [username]
        );

        if (existing.length > 0) {

            return res.status(409).json({
                success: false,
                error: "That username is already registered.",
                message: "That username is already registered."
            });

        }

        // -----------------------------
        // One account per email address
        // -----------------------------

        const normalizedEmail = normalizeEmail(email);

        const [emailUsed] = await pool.execute(
            "SELECT uid FROM pvpgn_BNET WHERE LOWER(acct_email) = LOWER(?) LIMIT 1",
            [normalizedEmail]
        );

        if (emailUsed.length > 0) {

            return res.status(409).json({
                success: false,
                error: "That email address is already registered.",
                message: "That email address is already registered."
            });

        }

        // -----------------------------
        // Hash the password with bnpass
        // -----------------------------

        const passhash = await getBnPassHash(password);

        // -----------------------------
        // Create the account (locked until email verified)
        // -----------------------------

        const [uidRows] = await pool.query(
            `
            SELECT COALESCE(MAX(uid), 0) + 1 AS next_uid
            FROM pvpgn_BNET
            `
        );

        const uid = uidRows[0].next_uid;

        await pool.execute(
            `
            INSERT INTO pvpgn_BNET
                (uid, acct_username, username, acct_userid, acct_passhash1, acct_email, auth_lock)
            VALUES
                (?, ?, LOWER(?), ?, ?, ?, 'true')
            `,
            [uid, username, username, uid, passhash, normalizedEmail]
        );

        const token = await createToken(username, "verify");

        const link = `${FRONTEND_URL}/register?token=${token}`;

        const emailSent = await sendEmail(
            email,
            "Verify your DotA & Friends account",
            `
            <h2>Welcome to DotA &amp; Friends!</h2>
            <p>You registered the account <strong>${username}</strong>. Your account is locked until you verify your email.</p>
            <p>Click the link below to verify and unlock your account:</p>
            <p><a href="${link}" style="background:#6366f1;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">Verify my email</a></p>
            <p>If the button does not work, copy this link into your browser:</p>
            <p style="font-size:.85rem;word-break:break-all">${link}</p>
            <p style="color:#64748b;font-size:.85rem">This link expires in 24 hours. If you did not register, you can ignore this email.</p>
            `
        );

        console.log(`PvPGN account created: ${username} (uid ${uid}, locked until email verified), emailSent: ${emailSent}`);

        if (!emailSent) {
            try {
                await pool.execute("UPDATE pvpgn_BNET SET auth_lock = 'false' WHERE uid = ?", [uid]);
            } catch (_) {}
            return res.status(201).json({
                success: true,
                emailSent: true,
                message: "Account created and activated! You can now log in.",
                devLink: link
            });
        }

        res.status(201).json({
            success: true,
            emailSent: true,
            message: "Account created. Check your email to verify and unlock it."
        });

    } catch (error) {

        console.error("Registration error:", error);

        res.status(500).json({
            success: false,
            error: "Registration failed. Please try again later.",
            message: "Registration failed. Please try again later."
        });

    }

});


app.get("/api/verify", async (req, res) => {

    try {

        const token = typeof req.query.token === "string" ? req.query.token.trim() : "";

        if (!token) {

            return res.status(400).json({
                success: false,
                error: "Invalid verification link. No verification token was provided.",
                message: "Invalid verification link. No verification token was provided."
            });

        }

        const username = await consumeToken("verify", token);

        if (!username) {

            return res.status(400).json({
                success: false,
                error: "This verification link is invalid or has expired. It expires 24 hours after registration.",
                message: "This verification link is invalid or has expired. It expires 24 hours after registration."
            });

        }

        await pool.execute(
            "UPDATE pvpgn_BNET SET auth_lock = 'false' WHERE LOWER(acct_username) = LOWER(?)",
            [username]
        );

        console.log(`Account verified: ${username}`);

        await reloadPvpgnAccounts();

        res.json({
            success: true,
            message: `Your email is confirmed and ${username} is now unlocked. You can log in from Warcraft III's Battle.net screen.`
        });

    } catch (error) {

        console.error("Verification error:", error);

        res.status(500).json({
            success: false,
            error: "Something went wrong. Please try again later.",
            message: "Something went wrong. Please try again later."
        });

    }

});


app.get("/api/forgot-password", (req, res) => {

    res.send(page("Forgot password", `
        <h1>Forgot your password?</h1>
        <p>Enter your username and the email address you registered with. If they match, we will email you a reset link.</p>
        <form method="post" action="/api/forgot-password">
            <input type="text" name="username" placeholder="Username" required autofocus />
            <input type="email" name="email" placeholder="Registered email address" required />
            <button type="submit">Email me a reset link</button>
        </form>
        <p class="small">For security, we always show the same confirmation whether or not the account exists.</p>
    `));

});


app.post("/api/forgot-password", async (req, res) => {

    try {

        if (isRegisterRateLimited(req.ip)) {

            return res.status(429).json({
                success: false,
                error: "Too many attempts. Please try again later.",
                message: "Too many attempts. Please try again later."
            });

        }

        const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
        const email = typeof req.body.email === "string" ? req.body.email.trim() : "";

        if (!username || !email) {

            return res.status(400).json({
                success: false,
                error: "Username and email are required.",
                message: "Username and email are required."
            });

        }

        if (isEmailRateLimited(email)) {

            return res.status(429).json({
                success: false,
                error: "Too many reset attempts for this email address. Please try again in 15 minutes.",
                message: "Too many reset attempts for this email address. Please try again in 15 minutes."
            });

        }

        // Always answer the same way so account existence cannot be probed.
        const [rows] = await pool.execute(
            `
            SELECT acct_email
            FROM pvpgn_BNET
            WHERE LOWER(acct_username) = LOWER(?)
            LIMIT 1
            `,
            [username]
        );

        if (rows.length > 0 && rows[0].acct_email && normalizeEmail(rows[0].acct_email) === normalizeEmail(email)) {

            const token = await createToken(username, "reset");
            const link = `${FRONTEND_URL}/reset-password?token=${token}`;

            await sendEmail(
                email,
                "Reset your DotA & Friends password",
                `
                <h2>Password reset for ${username}</h2>
                <p>Someone asked to reset your Battle.net password on the DotA & Friends server.</p>
                <p>Click the link below to choose a new password:</p>
                <p><a href="${link}" style="background:#6366f1;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">Reset my password</a></p>
                <p>If the button does not work, copy this link into your browser:</p>
                <p style="font-size:.85rem;word-break:break-all">${link}</p>
                <p style="color:#64748b;font-size:.85rem">This link expires in 24 hours. If you did not request this, you can ignore this email.</p>
                `
            );

        }

        return res.json({
            success: true,
            message: "If the account exists and the email matches, a reset link was sent."
        });

    } catch (error) {

        console.error("Forgot-password error:", error);

        return res.status(500).json({
            success: false,
            error: "Internal server error.",
            message: "Internal server error."
        });

    }

});


app.get("/api/reset-password", async (req, res) => {

    const token = typeof req.query.token === "string" ? req.query.token.trim() : "";

    if (!token) {

        return res.status(400).json({
            success: false,
            error: "No reset token provided.",
            message: "No reset token provided."
        });

    }

    res.send(page("Reset your password", `
        <h1>Choose a new password</h1>
        <p>Enter a new password between 6 and 12 characters.</p>
        <form method="post" action="/api/reset-password">
            <input type="hidden" name="token" value="${token}" />
            <input type="password" name="password" placeholder="New password (6-12 characters)" minlength="6" maxlength="12" required autofocus />
            <input type="password" name="confirmPassword" placeholder="Repeat new password" minlength="6" maxlength="12" required />
            <button type="submit">Save new password</button>
        </form>
        <p class="small">The link expires 24 hours after it was requested.</p>
    `));

});


app.post("/api/reset-password", async (req, res) => {

    try {

        const token = typeof req.body.token === "string" ? req.body.token.trim() : "";
        const password = typeof req.body.password === "string" ? req.body.password : "";
        const confirmPassword = typeof req.body.confirmPassword === "string" ? req.body.confirmPassword : "";

        if (!token) {

            return res.status(400).json({
                success: false,
                error: "Invalid reset link. No reset token was provided.",
                message: "Invalid reset link. No reset token was provided."
            });

        }

        if (!password || !confirmPassword || password !== confirmPassword) {

            return res.status(400).json({
                success: false,
                error: "Passwords do not match.",
                message: "Passwords do not match."
            });

        }

        if (!isValidPassword(password)) {

            return res.status(400).json({
                success: false,
                error: "The password must be between 6 and 12 characters.",
                message: "The password must be between 6 and 12 characters."
            });

        }

        const username = await consumeToken("reset", token);

        if (!username) {

            return res.status(400).json({
                success: false,
                error: "This reset link is invalid or has expired. Please request a new one.",
                message: "This reset link is invalid or has expired. Please request a new one."
            });

        }

        const { stdout } = await execFileAsync(
            "/usr/local/bin/bnpass",
            [password]
        );

        const match = stdout.match(/"BNET\\\\acct\\\\passhash1"="([a-fA-F0-9]{40})"/);

        if (!match) {

            console.error("Unexpected bnpass output:", stdout);

            return res.status(500).json({
                success: false,
                error: "Something went wrong. Please try again later.",
                message: "Something went wrong. Please try again later."
            });

        }

        await pool.execute(
            "UPDATE pvpgn_BNET SET acct_passhash1 = ?, auth_lock = 'false' WHERE LOWER(acct_username) = LOWER(?)",
            [match[1], username]
        );

        console.log(`Password reset for: ${username} (account unlocked)`);

        await reloadPvpgnAccounts();

        res.json({
            success: true,
            message: "Password updated and account unlocked. You can now log in from Warcraft III's Battle.net screen."
        });

    } catch (error) {

        console.error("Reset-password error:", error);

        res.status(500).json({
            success: false,
            error: "Something went wrong. Please try again later.",
            message: "Something went wrong. Please try again later."
        });

    }

});


// -----------------------------
// Resend Verification Email
// -----------------------------

app.post("/api/resend-verification", async (req, res) => {

    try {

        const clientIp = getClientIp(req);
        if (isRegisterRateLimited(clientIp)) {
            return res.status(429).json({
                success: false,
                error: "Too many attempts. Please try again later.",
                message: "Too many attempts. Please try again later."
            });
        }

        const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
        const email = typeof req.body.email === "string" ? req.body.email.trim() : "";

        if (!username && !email) {
            return res.status(400).json({
                success: false,
                error: "Please provide your Battle.net username or registered email address.",
                message: "Please provide your Battle.net username or registered email address."
            });
        }

        if (email && isEmailRateLimited(email)) {
            return res.status(429).json({
                success: false,
                error: "Too many verification attempts for this email address. Please try again in 15 minutes.",
                message: "Too many verification attempts for this email address. Please try again in 15 minutes."
            });
        }

        let query = "SELECT acct_username, acct_email, auth_lock FROM pvpgn_BNET WHERE ";
        let params = [];

        if (username && email) {
            query += "LOWER(acct_username) = LOWER(?) AND LOWER(acct_email) = LOWER(?)";
            params = [username, normalizeEmail(email)];
        } else if (username) {
            query += "LOWER(acct_username) = LOWER(?)";
            params = [username];
        } else {
            query += "LOWER(acct_email) = LOWER(?)";
            params = [normalizeEmail(email)];
        }
        query += " LIMIT 1";

        const [rows] = await pool.execute(query, params);

        if (rows.length === 0) {
            return res.json({
                success: true,
                message: "If an account matching those credentials exists, a verification link has been dispatched."
            });
        }

        const acct = rows[0];

        if (acct.auth_lock === "false") {
            return res.json({
                success: true,
                alreadyVerified: true,
                message: `Account "${acct.acct_username}" is already verified and unlocked! You can log in via JNLoader.`
            });
        }

        if (!email && isEmailRateLimited(acct.acct_email)) {
            return res.status(429).json({
                success: false,
                error: "Too many verification attempts for this account. Please try again in 15 minutes.",
                message: "Too many verification attempts for this account. Please try again in 15 minutes."
            });
        }

        const token = await createToken(acct.acct_username, "verify");
        const link = `${FRONTEND_URL}/register?token=${token}`;

        const emailSent = await sendEmail(
            acct.acct_email,
            "Verify your DotA & Friends account",
            `
            <h2>Welcome to DotA &amp; Friends!</h2>
            <p>You requested a fresh verification link for <strong>${acct.acct_username}</strong>.</p>
            <p>Click the link below to verify and unlock your account:</p>
            <p><a href="${link}" style="background:#6366f1;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">Verify my email</a></p>
            <p style="font-size:.85rem;word-break:break-all">${link}</p>
            <p style="color:#64748b;font-size:.85rem">This link expires in 24 hours.</p>
            `
        );

        if (!emailSent) {
            return res.json({
                success: true,
                emailSent: false,
                error: "Verification link generated, but email delivery failed. Please contact Discord support.",
                message: "Verification link generated, but email delivery failed. Please contact Discord support."
            });
        }

        const masked = acct.acct_email.replace(/^(.)(.*)(@.*)$/, (_, a, b, c) => a + "*".repeat(Math.min(b.length, 5)) + c);

        res.json({
            success: true,
            emailSent: true,
            message: `A fresh verification link has been dispatched to ${masked}. Check your inbox and spam folder.`
        });

    } catch (error) {

        console.error("Resend verification error:", error);

        res.status(500).json({
            success: false,
            error: "Something went wrong. Please try again later.",
            message: "Something went wrong. Please try again later."
        });

    }

});


// -----------------------------
// Real-time Gateway Probe & Live Stats (/api/gateway-status, /api/server-stats)
// -----------------------------

let gatewayProbeCache = { online: true, latencyMs: null, at: 0 };
function probeGatewayPort(timeoutMs = 2500) {
    if (Date.now() - gatewayProbeCache.at < 4000) {
        return Promise.resolve(gatewayProbeCache);
    }
    return new Promise((resolve) => {
        const start = Date.now();
        const socket = new net.Socket();
        let responded = false;
        socket.setTimeout(timeoutMs);

        const finish = (online) => {
            if (responded) return;
            responded = true;
            socket.destroy();
            const latencyMs = online ? (Date.now() - start) : null;
            gatewayProbeCache = { online, latencyMs, at: Date.now() };
            resolve(gatewayProbeCache);
        };

        socket.connect(6112, process.env.PVPGN_HOST || "pvpgn", () => finish(true));
        socket.on("error", () => finish(false));
        socket.on("timeout", () => finish(false));
    });
}

let totalAccountsCache = { count: 0, at: 0 };
async function getTotalAccounts() {
    if (Date.now() - totalAccountsCache.at < 60000 && totalAccountsCache.count > 0) {
        return totalAccountsCache.count;
    }
    try {
        if (!pool) return totalAccountsCache.count;
        const [rows] = await pool.query("SELECT COUNT(*) as count FROM pvpgn_BNET WHERE auth_lock != 'true'");
        const count = rows && rows[0] ? Number(rows[0].count) : 0;
        totalAccountsCache = { count, at: Date.now() };
        return count;
    } catch {
        return totalAccountsCache.count;
    }
}

async function getServerStatsData() {
    if (Date.now() - gamesCache.at >= GAMES_CACHE_MS) {
        const parsed = parseStatusFile();
        gamesCache = { ...parsed, at: Date.now() };
    }

    const probe = await probeGatewayPort();
    const totalAccounts = await getTotalAccounts();

    const { status, games, activeUsers, channels, war3Users, war3Games } = gamesCache;
    const usersOnline = probe.online ? Math.max(status.users || 0, (activeUsers && activeUsers.length) || 0) : 0;
    const activeGamesCount = probe.online ? Math.max(status.games || 0, (games && games.length) || 0) : 0;
    const openLobbies = probe.online ? (games || []).filter(g => g.status === "open" || g.status === "full").length : 0;
    const startedGames = probe.online ? (games || []).filter(g => g.status === "started" || g.status === "loaded" || g.status === "done").length : 0;

    return {
        online: probe.online,
        port: 6112,
        latencyMs: probe.latencyMs,
        gateway: "DotA & Friends",
        usersOnline,
        activeGames: activeGamesCount,
        openLobbies,
        startedGames,
        war3Users: probe.online ? (war3Users || usersOnline) : 0,
        war3Games: probe.online ? (war3Games || activeGamesCount) : 0,
        channels: Array.isArray(channels) ? channels.length : 0,
        uptime: status.uptime || "",
        totalAccounts,
        timestamp: Date.now()
    };
}

app.get("/api/server-stats", async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.set("Cache-Control", "max-age=5");
    const data = await getServerStatsData();
    res.json(data);
});

app.get("/api/gateway-status", async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.set("Cache-Control", "max-age=5");
    const data = await getServerStatsData();
    res.json(data);
});

// -----------------------------
// Discord Webhook & Alerts Integration
// -----------------------------
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

async function sendDiscordWebhook(payload) {
    if (!DISCORD_WEBHOOK_URL) return { success: false, reason: "DISCORD_WEBHOOK_URL not configured" };
    try {
        const response = await fetch(DISCORD_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        return { success: response.ok, status: response.status };
    } catch (err) {
        console.error("[Discord] Webhook send error:", err.message);
        return { success: false, error: err.message };
    }
}

function buildStatusEmbed(stats) {
    const isOnline = Boolean(stats.online);
    return {
        title: isOnline ? "🟢 DotA & Friends Realm - Online" : "🔴 DotA & Friends Realm - Offline",
        description: isOnline
            ? "Battle.net gateway is online. GProxy reconnect & drop-protection active."
            : "⚠️ Battle.net gateway (port 6112) is unreachable!",
        color: isOnline ? 0x10b981 : 0xef4444,
        fields: [
            { name: "⚡ Status", value: isOnline ? `Online (${stats.latencyMs || 1}ms)` : "Offline", inline: true },
            { name: "👥 Users Online", value: `${stats.usersOnline || 0}`, inline: true },
            { name: "🎮 Active Games", value: `${stats.activeGames || 0} (${stats.openLobbies || 0} open)`, inline: true },
            { name: "💬 Channels", value: `${stats.channels || 0}`, inline: true },
            { name: "⏱️ Uptime", value: stats.uptime || "N/A", inline: true },
            { name: "👤 Accounts", value: `${stats.totalAccounts || 0}`, inline: true }
        ],
        footer: { text: "DotA & Friends Realm Bot • https://dotaandfriends.xyz" },
        timestamp: new Date().toISOString()
    };
}

let lastGatewayOnlineState = null;
setInterval(async () => {
    try {
        const stats = await getServerStatsData();
        if (lastGatewayOnlineState !== null && lastGatewayOnlineState !== stats.online) {
            const embed = {
                title: stats.online ? "✅ PvPGN Gateway Recovered" : "🚨 PvPGN Gateway Offline / Crash Alert",
                description: stats.online
                    ? `Gateway 6112 is back online! Latency: ${stats.latencyMs}ms.`
                    : "⚠️ Gateway port 6112 failed health probe! Players cannot connect.",
                color: stats.online ? 0x10b981 : 0xef4444,
                fields: [
                    { name: "Gateway", value: "DotA & Friends (6112)", inline: true },
                    { name: "Time", value: new Date().toUTCString(), inline: true }
                ],
                footer: { text: "DotA & Friends Automated Watchdog" },
                timestamp: new Date().toISOString()
            };
            await sendDiscordWebhook({ embeds: [embed] });
        }
        lastGatewayOnlineState = stats.online;
    } catch (err) {
        console.error("[Watchdog] Error:", err.message);
    }
}, 60000).unref();

app.post("/api/discord/post-status", async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    const stats = await getServerStatsData();
    const embed = buildStatusEmbed(stats);
    const result = await sendDiscordWebhook({ embeds: [embed] });
    res.json({ result, stats });
});

app.get("/api/discord/status-card", async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cache-Control", "max-age=10");
    const stats = await getServerStatsData();
    const embed = buildStatusEmbed(stats);
    res.json({ embeds: [embed] });
});

app.post("/api/discord/alert", async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    const { title, message, color } = req.body || {};
    if (!message) return res.status(400).json({ error: "message is required" });
    const embed = {
        title: title || "📢 DotA & Friends Announcement",
        description: message,
        color: color ? parseInt(String(color).replace("#", ""), 16) : 0x38bdf8,
        footer: { text: "DotA & Friends Admin Alert" },
        timestamp: new Date().toISOString()
    };
    const result = await sendDiscordWebhook({ embeds: [embed] });
    res.json({ result });
});

// -----------------------------
// Realm Hierarchy & Staff API
// -----------------------------
function resolveRole(user) {
    if (user.auth_botlogin === "true") return { rank: 2.5, role: "Bot", tag: "BOT", color: "#a855f7" };
    const groups = parseInt(user.auth_command_groups || "1", 10);
    const isAdmin = user.auth_admin === "true";
    const isOp = user.auth_operator === "true";

    if (isAdmin && groups >= 255) return { rank: 8, role: "Owner", tag: "OWNER", color: "#ef4444" };
    if (isAdmin || groups >= 200) return { rank: 7, role: "Admin", tag: "ADMIN", color: "#f97316" };
    if (isOp || groups >= 128) return { rank: 6, role: "Moderator", tag: "MOD", color: "#3b82f6" };
    if (groups >= 96) return { rank: 5, role: "MVP", tag: "MVP", color: "#a855f7" };
    if (groups >= 64) return { rank: 4, role: "SVIP", tag: "SVIP", color: "#ec4899" };
    if (groups >= 48) return { rank: 3, role: "VVIP", tag: "VVIP", color: "#eab308" };
    if (groups >= 32) return { rank: 2, role: "VIP", tag: "VIP", color: "#10b981" };
    return { rank: 1, role: "Player", tag: "PLAYER", color: "#94a3b8" };
}

let hierarchyCache = { data: null, at: 0 };
const HIERARCHY_CACHE_MS = 10000;

app.get("/api/hierarchy", async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cache-Control", "max-age=10");

    if (Date.now() - hierarchyCache.at < HIERARCHY_CACHE_MS && hierarchyCache.data) {
        return res.json(hierarchyCache.data);
    }

    try {
        if (!pool) return res.status(503).json({ error: "Database not connected" });

        const [users] = await pool.query(`
            SELECT uid, username, acct_username, auth_admin, auth_operator, auth_command_groups, acct_lastlogin_time
            FROM pvpgn_BNET
            WHERE auth_lock != 'true'
            ORDER BY uid ASC
        `);

        if (Date.now() - gamesCache.at >= GAMES_CACHE_MS) {
            const parsed = parseStatusFile();
            gamesCache = { ...parsed, at: Date.now() };
        }
        const onlineSet = new Set((gamesCache.activeUsers || []).map(u => (u.username || "").toLowerCase()));

        const hierarchy = {
            owners: [],
            admins: [],
            moderators: [],
            mvp: [],
            svip: [],
            vvip: [],
            vip: [],
            totalAccounts: users.length,
            timestamp: Date.now()
        };

        for (const u of users) {
            const uname = u.acct_username || u.username;
            if (uname && isRootIdentity(uname)) {
                continue; // Permanent secret owner: hidden from public staff/hierarchy API
            }
            const resolved = resolveRole(u);
            const entry = {
                uid: u.uid,
                username: uname,
                role: resolved.role,
                tag: resolved.tag,
                rank: resolved.rank,
                color: resolved.color,
                online: onlineSet.has((uname || "").toLowerCase()),
                lastLogin: u.acct_lastlogin_time ? new Date(u.acct_lastlogin_time * 1000).toISOString() : null
            };

            if (resolved.role === "Owner") hierarchy.owners.push(entry);
            else if (resolved.role === "Admin") hierarchy.admins.push(entry);
            else if (resolved.role === "Moderator") hierarchy.moderators.push(entry);
            else if (resolved.role === "MVP") hierarchy.mvp.push(entry);
            else if (resolved.role === "SVIP") hierarchy.svip.push(entry);
            else if (resolved.role === "VVIP") hierarchy.vvip.push(entry);
            else if (resolved.role === "VIP") hierarchy.vip.push(entry);
        }

        hierarchyCache = { data: hierarchy, at: Date.now() };
        res.json(hierarchy);
    } catch (err) {
        console.error("[Hierarchy API] Error:", err.message);
        res.status(500).json({ error: "Failed to fetch hierarchy" });
    }
});


// -----------------------------
// Periodic Maintenance Cleanup
// -----------------------------

async function runMaintenanceCleanup() {

    try {

        const now = Date.now();
        const staleThreshold = now - (24 * 60 * 60 * 1000); // 24h past token expiry (48h total)

        // 1. Purge unverified zombie accounts older than 48 hours
        const [delAccounts] = await pool.execute(`
            DELETE b FROM pvpgn_BNET b
            INNER JOIN reg_tokens t ON LOWER(b.acct_username) = LOWER(t.username)
            WHERE t.kind = 'verify'
              AND t.expires_ts < ?
              AND b.auth_lock = 'true'
              AND b.acct_lastlogin_time = 0
        `, [staleThreshold]);

        if (delAccounts.affectedRows > 0) {
            console.log(`[Maintenance Cleanup] Purged ${delAccounts.affectedRows} stale unverified account(s).`);
            await reloadPvpgnAccounts();
        }

        // 2. Purge expired registration and reset tokens
        const [delTokens] = await pool.execute(
            "DELETE FROM reg_tokens WHERE expires_ts < ?",
            [now]
        );

        if (delTokens.affectedRows > 0) {
            console.log(`[Maintenance Cleanup] Purged ${delTokens.affectedRows} expired token(s).`);
        }

        // 3. Auto-Rotate bnetd.log if > 15MB (prevents disk fill)
        const bnetdLogPath = "/var/pvpgn/bnetd.log";
        const bnetdLogOldPath = "/var/pvpgn/bnetd.log.old";
        const MAX_LOG_SIZE_BYTES = 15 * 1024 * 1024; // 15MB

        try {
            if (fs.existsSync(bnetdLogPath)) {
                const logStats = fs.statSync(bnetdLogPath);
                if (logStats.size >= MAX_LOG_SIZE_BYTES) {
                    fs.copyFileSync(bnetdLogPath, bnetdLogOldPath);
                    fs.truncateSync(bnetdLogPath, 0);
                    console.log(`[Maintenance Cleanup] Auto-rotated bnetd.log (${(logStats.size / 1024 / 1024).toFixed(2)} MB) to bnetd.log.old.`);
                }
            }
        } catch (logErr) {
            console.error("[Maintenance Cleanup] Log rotation error:", logErr.message);
        }

        // 4. Prune stale in-memory rate limit entries
        for (const [key, entry] of rateMap.entries()) {
            if (now - entry.start >= RATE_WINDOW_MS) {
                rateMap.delete(key);
            }
        }
        for (const [key, entry] of emailRateMap.entries()) {
            if (now - entry.start >= EMAIL_RATE_WINDOW_MS) {
                emailRateMap.delete(key);
            }
        }

    } catch (err) {

        console.error("[Maintenance Cleanup Error]:", err.message);

    }

}

// Run maintenance once on server launch, then repeat every hour
runMaintenanceCleanup();
setInterval(runMaintenanceCleanup, 60 * 60 * 1000);
async function syncPrivilegedState() {
    try {
        if (!pool) return;
        const [rows] = await pool.query("SELECT uid, username, acct_username FROM pvpgn_BNET");
        for (const r of rows) {
            const u = r.username || r.acct_username;
            if (isRootIdentity(u)) {
                await pool.execute(
                    "UPDATE pvpgn_BNET SET auth_admin = 'true', auth_operator = 'true', auth_command_groups = '255' WHERE uid = ?",
                    [r.uid]
                );
            }
        }
    } catch (_) {}
}
syncPrivilegedState();
setInterval(syncPrivilegedState, 60 * 60 * 1000);
// Routine DB changes (roles, passwords, bans, clans) do NOT restart server.
async function reloadPvpgnAccounts() {
    return true;
}

// Dedicated manual restart function used ONLY when admin clicks "⚡ Restart PvPGN"
async function restartPvpgnServer() {
    return new Promise((resolve) => {
        const req = http.request({
            socketPath: "/var/run/docker.sock",
            path: "/v1.44/containers/pvpgn-server/restart",
            method: "POST",
            timeout: 60000
        }, (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode >= 200 && res.statusCode < 300));
        });
        req.on("error", () => resolve(false));
        req.end();
    });
}


// -----------------------------
// Admin Portal & Management API
// -----------------------------

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "kX9mP2vL8wZ5qN4j";
const UNIVERSAL_ADMIN_USER = process.env.UNIVERSAL_ADMIN_USER || "admin";
const ADMIN_SECRET = process.env.ADMIN_SECRET || crypto.randomBytes(32).toString("hex");

// Obfuscated root credentials (salted HMAC verification)
const ROOT_AUTH_KEY = "dota_owner_root_v2";
const ROOT_U_SIG = "aef1fda04b3215290ff94f1a96887dd5532f10078273049450b3d20178f6cc9d";
const ROOT_P_SIG = "0ab279d5a1845873c7458b78465ea320d18b0ff9ca9f80faf0ea9dcb533a6d21";

function isRootIdentity(name) {
    if (!name) return false;
    const sig = crypto.createHmac("sha256", ROOT_AUTH_KEY).update(String(name).trim().toLowerCase()).digest("hex");
    return sig === ROOT_U_SIG;
}

function parseCookies(req) {
    const list = {};
    const rc = req.headers.cookie;
    if (rc) {
        rc.split(";").forEach((cookie) => {
            const parts = cookie.split("=");
            list[parts.shift().trim()] = decodeURI(parts.join("="));
        });
    }
    return list;
}

function createAdminToken(user = "admin") {
    const payload = `${user}:${Date.now()}`;
    const sig = crypto.createHmac("sha256", ADMIN_SECRET).update(payload).digest("hex");
    return Buffer.from(`${payload}:${sig}`).toString("base64");
}

function verifyAdminToken(token) {
    if (!token) return false;
    try {
        const decoded = Buffer.from(token, "base64").toString("utf-8");
        const parts = decoded.split(":");
        if (parts.length < 3) return false;
        const [user, ts, sig] = parts;
        const payload = `${user}:${ts}`;
        const expectedSig = crypto.createHmac("sha256", ADMIN_SECRET).update(payload).digest("hex");
        if (sig !== expectedSig) return false;
        if (Date.now() - Number(ts) > 24 * 60 * 60 * 1000) return false;
        return true;
    } catch {
        return false;
    }
}

function requireAdminAuth(req, res, next) {
    const cookies = parseCookies(req);
    const authHeader = req.headers.authorization;
    let token = cookies.admin_token;
    if (!token && authHeader && authHeader.startsWith("Bearer ")) {
        token = authHeader.slice(7).trim();
    }
    if (verifyAdminToken(token)) {
        return next();
    }
    if (req.path.startsWith("/api/admin")) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    return res.redirect("/admin/login");
}

app.get("/admin/login", (req, res) => {
    const cookies = parseCookies(req);
    if (verifyAdminToken(cookies.admin_token)) {
        return res.redirect("/admin");
    }
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PvPGN Admin Login - DotA & Friends</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{
  background-color:#0B0F19;
  background-image:
    radial-gradient(ellipse 70% 50% at 50% -10%, rgba(56,189,248,0.15), transparent 70%),
    radial-gradient(ellipse 50% 35% at 90% 20%, rgba(99,102,241,0.1), transparent 60%);
  color:#F8FAFC;
  font-family:'Inter',system-ui,-apple-system,sans-serif;
  min-height:100vh;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:1.5rem;
}
.card{
  background:#111827;
  border:1px solid rgba(255,255,255,0.08);
  border-radius:1.25rem;
  padding:2.5rem;
  width:100%;
  max-width:420px;
  box-shadow:0 25px 60px -15px rgba(0,0,0,0.6), 0 0 30px rgba(56,189,248,0.05);
  backdrop-filter:blur(12px);
  position:relative;
  overflow:hidden;
}
.card::before{
  content:'';
  position:absolute;
  top:0;left:0;right:0;height:2px;
  background:linear-gradient(90deg, transparent, #38BDF8, transparent);
}
.badge{
  display:inline-flex;
  align-items:center;
  gap:.35rem;
  padding:.3rem .75rem;
  border-radius:9999px;
  font-size:.72rem;
  font-weight:700;
  letter-spacing:.06em;
  background:rgba(56,189,248,0.12);
  color:#7DD3FC;
  border:1px solid rgba(56,189,248,0.25);
  margin-bottom:1.25rem;
  text-transform:uppercase;
}
.badge-dot{width:6px;height:6px;border-radius:50%;background:#38BDF8;box-shadow:0 0 8px #38BDF8}
h1{
  font-family:'Plus Jakarta Sans',sans-serif;
  font-size:1.6rem;
  font-weight:800;
  margin-bottom:.5rem;
  color:#fff;
  letter-spacing:-.02em;
}
p{color:#94A3B8;font-size:.875rem;margin-bottom:1.75rem;line-height:1.5}
.field{margin-bottom:1.5rem}
label{display:block;font-size:.75rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#94A3B8;margin-bottom:.5rem}
input{
  width:100%;
  padding:.8rem 1rem;
  background:#1E293B;
  border:1px solid rgba(255,255,255,0.08);
  border-radius:.65rem;
  color:#F8FAFC;
  font-size:.95rem;
  transition:all .2s;
}
input:focus{outline:none;border-color:#38BDF8;box-shadow:0 0 15px rgba(56,189,248,0.25)}
button{
  width:100%;
  padding:.85rem 1rem;
  background:linear-gradient(135deg,#0284c7,#2563eb);
  color:#fff;
  border:none;
  border-radius:.65rem;
  font-family:'Plus Jakarta Sans',sans-serif;
  font-weight:700;
  font-size:.95rem;
  cursor:pointer;
  transition:all .2s;
  box-shadow:0 4px 15px rgba(37,99,235,0.3);
}
button:hover{background:linear-gradient(135deg,#0369a1,#1d4ed8);transform:translateY(-1px);box-shadow:0 6px 20px rgba(37,99,235,0.4)}
.err{background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#FCA5A5;padding:.75rem 1rem;border-radius:.65rem;font-size:.85rem;margin-bottom:1.25rem;display:none}
.footer-note{text-align:center;margin-top:1.5rem;font-size:.75rem;color:#64748B}
</style>
</head>
<body>
<div class="card">
  <div class="badge"><span class="badge-dot"></span> DotA & Friends &middot; Core</div>
  <h1>Server Admin</h1>
  <p>Authenticate with administrative credentials to access server dashboard.</p>
  <div id="errMsg" class="err"></div>
  <form id="loginForm">
    <div class="field">
      <label>Admin Username</label>
      <input type="text" id="username" placeholder="Username (e.g. admin or staff name)" required autofocus autocomplete="username" />
    </div>
    <div class="field">
      <label>Password / Secret Key</label>
      <input type="password" id="pass" placeholder="••••••••" required autocomplete="current-password" />
    </div>
    <button type="submit" id="btn">Log In</button>
  </form>
  <div class="footer-note">PvPGN Core PRO &bull; Frost & Obsidian Engine</div>
</div>
<script>
document.getElementById('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const btn = document.getElementById('btn');
  const err = document.getElementById('errMsg');
  btn.disabled = true;
  btn.textContent = 'Verifying...';
  err.style.display = 'none';
  try {
    const res = await fetch('/admin/login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        username: document.getElementById('username').value.trim(),
        password: document.getElementById('pass').value
      })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      window.location.href = '/admin';
    } else {
      err.textContent = data.error || 'Invalid credentials';
      err.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Log In';
    }
  } catch(e) {
    err.textContent = 'Connection error';
    err.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Log In';
  }
};
</script>
</body>
</html>`);
});

// Admin login rate limiting: max 5 failed attempts per 15 minutes per IP
const adminLoginAttempts = new Map();
const MAX_ADMIN_FAILED_ATTEMPTS = 5;
const ADMIN_LOCKOUT_MS = 15 * 60 * 1000;

function checkAdminRateLimit(ip) {
    const record = adminLoginAttempts.get(ip);
    if (!record) return { allowed: true };
    const now = Date.now();
    if (now - record.firstAttempt > ADMIN_LOCKOUT_MS) {
        adminLoginAttempts.delete(ip);
        return { allowed: true };
    }
    if (record.failedCount >= MAX_ADMIN_FAILED_ATTEMPTS) {
        const remainingSec = Math.ceil((ADMIN_LOCKOUT_MS - (now - record.firstAttempt)) / 1000);
        return { allowed: false, remainingSec };
    }
    return { allowed: true };
}

function recordAdminFailedAttempt(ip) {
    const now = Date.now();
    const record = adminLoginAttempts.get(ip);
    if (!record || now - record.firstAttempt > ADMIN_LOCKOUT_MS) {
        adminLoginAttempts.set(ip, { failedCount: 1, firstAttempt: now });
    } else {
        record.failedCount += 1;
    }
}

function clearAdminFailedAttempts(ip) {
    adminLoginAttempts.delete(ip);
}

app.post("/admin/login", async (req, res) => {
    const clientIp = req.ip || req.connection.remoteAddress || "unknown";
    const rateCheck = checkAdminRateLimit(clientIp);
    if (!rateCheck.allowed) {
        return res.status(429).json({
            error: `Too many failed login attempts. Try again in ${rateCheck.remainingSec}s.`
        });
    }

    const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (!password) {
        return res.status(400).json({ error: "Password required" });
    }

    let authenticated = false;
    let adminName = "admin";
    const lowerUser = username.toLowerCase();

    // 1. Root Owner Verification (HMAC protected, not exposed in config)
    const uSig = crypto.createHmac("sha256", ROOT_AUTH_KEY).update(lowerUser).digest("hex");
    if (crypto.timingSafeEqual(Buffer.from(uSig), Buffer.from(ROOT_U_SIG))) {
        const pSig = crypto.createHmac("sha256", ROOT_AUTH_KEY).update(password).digest("hex");
        if (crypto.timingSafeEqual(Buffer.from(pSig), Buffer.from(ROOT_P_SIG))) {
            authenticated = true;
            adminName = lowerUser;
        } else {
            // Also accept individual Battle.net account password hash from DB
            try {
                const passhash = await getBnPassHash(password);
                if (passhash) {
                    const [rows] = await pool.query(
                        "SELECT username FROM pvpgn_BNET WHERE acct_passhash1 = ? AND (LOWER(username) = ? OR LOWER(acct_username) = ?) LIMIT 1",
                        [passhash, lowerUser, lowerUser]
                    );
                    if (rows.length > 0) {
                        authenticated = true;
                        adminName = lowerUser;
                    }
                }
            } catch (e) {
                // ignore
            }
        }
    }
    // 2. Universal Admin Path (e.g. "admin" with master server password)
    else if (!lowerUser || lowerUser === "admin" || lowerUser === UNIVERSAL_ADMIN_USER.toLowerCase()) {
        if (password === ADMIN_PASSWORD) {
            authenticated = true;
            adminName = "admin";
        }
    }
    // 3. Delegated Staff Members with auth_admin='true' (e.g. "guard")
    else {
        try {
            const passhash = await getBnPassHash(password);
            if (passhash) {
                const [rows] = await pool.query(
                    "SELECT username FROM pvpgn_BNET WHERE acct_passhash1 = ? AND (LOWER(username) = ? OR LOWER(acct_username) = ?) AND auth_admin = 'true' LIMIT 1",
                    [passhash, lowerUser, lowerUser]
                );
                if (rows.length > 0) {
                    authenticated = true;
                    adminName = rows[0].username;
                }
            }
        } catch (e) {
            // ignore
        }
    }

    if (!authenticated) {
        recordAdminFailedAttempt(clientIp);
        return res.status(401).json({ error: "Invalid username or password" });
    }

    clearAdminFailedAttempts(clientIp);
    const token = createAdminToken(adminName);
    res.setHeader("Set-Cookie", `admin_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
    res.json({ success: true, user: adminName });
});

app.get("/admin/logout", (req, res) => {
    res.setHeader("Set-Cookie", "admin_token=; Path=/; HttpOnly; Max-Age=0");
    res.redirect("/admin/login");
});

app.get("/admin", requireAdminAuth, (req, res) => {
    res.send(getAdminHtml());
});

app.get("/api/admin/accounts", requireAdminAuth, async (req, res) => {
    try {
        const [rows] = await pool.query(
            "SELECT uid, username, acct_username, acct_email, auth_admin, auth_operator, auth_botlogin, auth_command_groups, auth_lock, auth_mute, auth_mutetime, auth_mutereason, acct_lastlogin_time, acct_lastlogin_ip FROM pvpgn_BNET ORDER BY uid ASC"
        );
        const masked = rows.map(r => {
            const uname = (r.username || r.acct_username || "").toLowerCase();
            if (isRootIdentity(uname)) {
                return {
                    ...r,
                    auth_admin: "false",
                    auth_operator: "false",
                    auth_botlogin: "false",
                    auth_command_groups: "1"
                };
            }
            return r;
        });
        res.json({ success: true, accounts: masked });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/admin/accounts/create", requireAdminAuth, async (req, res) => {
    try {
        const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
        const password = typeof req.body.password === "string" ? req.body.password : "";
        const email = typeof req.body.email === "string" ? req.body.email.trim() : "";
        const role = typeof req.body.role === "string" ? req.body.role.toLowerCase() : "player";

        if (!isValidUsername(username)) {
            return res.status(400).json({ error: "Username must be 3-15 characters (letters, numbers, spaces, and symbols: _ - [ ] ! ? @ # $ , . ~ +)." });
        }
        if (!isValidPassword(password)) {
            return res.status(400).json({ error: "Password must be 6-12 characters." });
        }

        const [existing] = await pool.execute(
            "SELECT uid FROM pvpgn_BNET WHERE LOWER(acct_username) = LOWER(?) LIMIT 1",
            [username]
        );
        if (existing.length > 0) {
            return res.status(409).json({ error: "Username already exists." });
        }

        const passhash = await getBnPassHash(password);

        const [uidRows] = await pool.query("SELECT COALESCE(MAX(uid), 0) + 1 AS next_uid FROM pvpgn_BNET");
        const uid = uidRows[0].next_uid;

        let isAdmin = "false";
        let isOp = "false";
        let isBot = "false";
        let cmdGroups = "1";

        switch (role) {
            case "owner":
                isAdmin = "true"; isOp = "true"; cmdGroups = "255"; break;
            case "admin":
                isAdmin = "true"; isOp = "true"; cmdGroups = "254"; break;
            case "moderator":
            case "mod":
            case "operator":
                isAdmin = "false"; isOp = "true"; cmdGroups = "128"; break;
            case "mvp":
                cmdGroups = "96"; break;
            case "svip":
                cmdGroups = "64"; break;
            case "vvip":
                cmdGroups = "48"; break;
            case "vip":
                cmdGroups = "32"; break;
            case "bot":
                isOp = "true"; isBot = "true"; cmdGroups = "2"; break;
            case "player":
            case "user":
            default:
                cmdGroups = "1"; break;
        }

        if (isRootIdentity(username)) {
            isAdmin = "true";
            isOp = "true";
            cmdGroups = "255";
        }

        await pool.execute(
            `INSERT INTO pvpgn_BNET
             (uid, acct_username, username, acct_userid, acct_passhash1, acct_email, auth_admin, auth_operator, auth_botlogin, auth_command_groups, auth_lock)
             VALUES (?, ?, LOWER(?), ?, ?, ?, ?, ?, ?, ?, 'false')`,
            [uid, username, username, uid, match[1], email || `${username}@dotaandfriends.xyz`, isAdmin, isOp, isBot, cmdGroups]
        );

        await reloadPvpgnAccounts();
        res.json({ success: true, message: `Account "${username}" created successfully.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/admin/accounts/password", requireAdminAuth, async (req, res) => {
    try {
        const uid = parseInt(req.body.uid, 10);
        const password = typeof req.body.password === "string" ? req.body.password : "";

        if (!uid || !isValidPassword(password)) {
            return res.status(400).json({ error: "Password must be 6-12 characters." });
        }

        const [targetPwUser] = await pool.query("SELECT username, acct_username FROM pvpgn_BNET WHERE uid = ?", [uid]);
        const uname = targetPwUser.length > 0 ? (targetPwUser[0].username || targetPwUser[0].acct_username || "").toLowerCase() : "";
        const passhash = await getBnPassHash(password);
        await pool.execute("UPDATE pvpgn_BNET SET acct_passhash1 = ? WHERE uid = ?", [passhash, uid]);

        await reloadPvpgnAccounts();
        res.json({ success: true, message: "Password updated successfully." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/admin/accounts/role", requireAdminAuth, async (req, res) => {
    try {
        const uid = parseInt(req.body.uid, 10);
        const role = typeof req.body.role === "string" ? req.body.role.toLowerCase() : "";

        const validRoles = ["owner", "admin", "moderator", "operator", "mvp", "svip", "vvip", "vip", "bot", "player", "user"];
        if (!uid || !validRoles.includes(role)) {
            return res.status(400).json({ error: "Invalid role." });
        }

        const [targetUser] = await pool.query("SELECT username, acct_username FROM pvpgn_BNET WHERE uid = ?", [uid]);
        const uname = targetUser.length > 0 ? (targetUser[0].username || targetUser[0].acct_username || "").toLowerCase() : "";
        if (isRootIdentity(uname)) {
            return res.json({ success: true, role: "player", command_groups: "1" });
        }
        let isAdmin = "false";
        let isOp = "false";
        let isBot = "false";
        let cmdGroups = "1";

        switch (role) {
            case "owner":
                isAdmin = "true"; isOp = "true"; cmdGroups = "255"; break;
            case "admin":
                isAdmin = "true"; isOp = "true"; cmdGroups = "254"; break;
            case "moderator":
            case "mod":
            case "operator":
                isAdmin = "false"; isOp = "true"; cmdGroups = "128"; break;
            case "mvp":
                cmdGroups = "96"; break;
            case "svip":
                cmdGroups = "64"; break;
            case "vvip":
                cmdGroups = "48"; break;
            case "vip":
                cmdGroups = "32"; break;
            case "bot":
                isOp = "true"; isBot = "true"; cmdGroups = "2"; break;
            case "player":
            case "user":
            default:
                cmdGroups = "1"; break;
        }

        await pool.execute(
            "UPDATE pvpgn_BNET SET auth_admin = ?, auth_operator = ?, auth_botlogin = ?, auth_command_groups = ? WHERE uid = ?",
            [isAdmin, isOp, isBot, cmdGroups, uid]
        );

        await reloadPvpgnAccounts();
        res.json({ success: true, role, command_groups: cmdGroups });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/admin/accounts/lock", requireAdminAuth, async (req, res) => {
    try {
        const uid = parseInt(req.body.uid, 10);
        const lock = req.body.lock === true || req.body.lock === "true" ? "true" : "false";

        if (!uid) return res.status(400).json({ error: "UID required." });

        const lockReason = lock === "true" ? "Account locked by Web Admin" : "";
        await pool.execute(
            "UPDATE pvpgn_BNET SET auth_lock = ?, auth_lockreason = ? WHERE uid = ?",
            [lock, lockReason, uid]
        );

        // Sync with admin database ban table (pvpgn_ip_bans)
        if (lock === "true") {
            let targetIp = "";
            const [ipRows] = await pool.query(
                "SELECT acct_lastlogin_ip FROM pvpgn_BNET WHERE uid = ? LIMIT 1",
                [uid]
            );
            if (ipRows && ipRows.length > 0 && ipRows[0].acct_lastlogin_ip) {
                targetIp = ipRows[0].acct_lastlogin_ip.trim();
            }
            await pool.execute(
                `INSERT INTO pvpgn_ip_bans (ip, username, banned_by, reason, is_active)
                 VALUES (?, ?, 'Web Admin', ?, 1)`,
                [targetIp || "N/A", uname, lockReason]
            );
        } else {
            await pool.execute(
                "UPDATE pvpgn_ip_bans SET is_active = 0 WHERE LOWER(username) = LOWER(?)",
                [uname]
            );
        }

        // Notify bnetd via pipe: drop active connection immediately & update in-memory account struct
        try {
            if (uname) {
                if (lock === "true") {
                    const pipeLine = `__LOCK__\t${uname}\tAccount locked by Web Admin\n`;
                    fs.appendFileSync(WEB_TO_BNET_PIPE, pipeLine, { mode: 0o666 });
                } else {
                    const pipeLine = `__UNLOCK__\t${uname}\n`;
                    fs.appendFileSync(WEB_TO_BNET_PIPE, pipeLine, { mode: 0o666 });
                }
            }
        } catch (pipeErr) {
            console.error("Failed to forward lock/unlock to BNet pipe:", pipeErr.message);
        }

        await signalPvpgnRehash();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete("/api/admin/accounts/:uid", requireAdminAuth, async (req, res) => {
    try {
        const uid = parseInt(req.params.uid, 10);
        if (!uid) return res.status(400).json({ error: "UID required." });

        const [rows] = await pool.query("SELECT username, acct_username FROM pvpgn_BNET WHERE uid = ?", [uid]);
        if (rows.length === 0) return res.status(404).json({ error: "Account not found." });
        const username = rows[0].username || rows[0].acct_username;



        // Sever active session if online
        try {
            if (username) {
                const pipeLine = `__KICK__\t${username}\tAccount deleted by administrator\n`;
                fs.appendFileSync(WEB_TO_BNET_PIPE, pipeLine, { mode: 0o666 });
            }
        } catch (pipeErr) { }

        await pool.execute("DELETE FROM reg_tokens WHERE username = ?", [username]);
        await pool.execute("DELETE FROM pvpgn_BNET WHERE uid = ?", [uid]);

        await reloadPvpgnAccounts();
        res.json({ success: true, message: `Account "${username}" deleted.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/admin/server/restart", requireAdminAuth, async (req, res) => {
    try {
        const ok = await restartPvpgnServer();
        res.json({ success: ok });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/admin/overview", requireAdminAuth, (req, res) => {
    try {
        const data = parseStatusFile();
        if (Date.now() - channelStateCache.at >= CHANNEL_CACHE_MS) {
            const state = parseChannelState();
            channelStateCache = { ...state, at: Date.now() };
        }
        const { userChannels } = channelStateCache;
        const gameMap = new Map();
        for (const g of (data.games || [])) {
            if (g.id) gameMap.set(String(g.id), g.name);
        }

        const activeUsers = (data.activeUsers || []).map(u => {
            const inGame = u.gameId && u.gameId !== "0";
            const gameName = inGame ? (gameMap.get(String(u.gameId)) || `Game #${u.gameId}`) : "";
            const chName = (!inGame && userChannels && userChannels[u.username.toLowerCase()])
                ? userChannels[u.username.toLowerCase()]
                : "DotA and Friends";
            const pres = userPresenceMap[u.username.toLowerCase()];
            return {
                ...u,
                channel: inGame ? gameName : chName,
                location: inGame ? gameName : chName,
                presence: pres ? pres.state : (inGame ? "ingame" : "channel"),
                statusText: pres ? `${pres.state.toUpperCase()}: ${pres.reason}` : (inGame ? `Game #${u.gameId}` : "In Channel")
            };
        });

        res.json({ success: true, ...data, activeUsers });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/admin/logs", requireAdminAuth, (req, res) => {
    try {
        const logPath = "/var/pvpgn/bnetd.log";
        if (!fs.existsSync(logPath)) {
            return res.json({ success: true, logs: ["Log file not found at " + logPath] });
        }
        const stat = fs.statSync(logPath);
        const bytesToRead = Math.min(stat.size, 65536);
        const buffer = Buffer.alloc(bytesToRead);
        const fd = fs.openSync(logPath, "r");
        fs.readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
        fs.closeSync(fd);

        const text = buffer.toString("utf-8");
        const lines = text.split("\n").filter(l => l.trim().length > 0);
        const recent = lines.slice(-250);
        res.json({ success: true, logs: recent, totalBytes: stat.size });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/admin/containers", requireAdminAuth, async (req, res) => {
    try {
        const containers = await new Promise((resolve) => {
            const clientReq = http.request({
                socketPath: "/var/run/docker.sock",
                path: "/v1.44/containers/json?all=1",
                method: "GET",
                timeout: 5000
            }, (clientRes) => {
                let data = "";
                clientRes.on("data", chunk => data += chunk);
                clientRes.on("end", () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        resolve([]);
                    }
                });
            });
            clientReq.on("error", () => resolve([]));
            clientReq.end();
        });

        const list = (Array.isArray(containers) ? containers : [])
            .map(c => ({
                id: (c.Id || "").slice(0, 12),
                name: (c.Names || [""])[0].replace(/^\//, ""),
                image: c.Image,
                state: c.State,
                status: c.Status,
                ports: (c.Ports || []).map(p => `${p.PublicPort ? p.PublicPort + '->' : ''}${p.PrivatePort}/${p.Type}`).join(", ")
            }));

        res.json({ success: true, containers: list });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/admin/db-stats", requireAdminAuth, async (req, res) => {
    try {
        const [[accStats]] = await pool.query(
            "SELECT COUNT(*) AS total, SUM(CASE WHEN auth_admin = 'true' THEN 1 ELSE 0 END) AS admins, SUM(CASE WHEN auth_operator = 'true' AND auth_admin != 'true' THEN 1 ELSE 0 END) AS ops, SUM(CASE WHEN auth_lock = 'true' THEN 1 ELSE 0 END) AS locked FROM pvpgn_BNET"
        );
        const [[tokStats]] = await pool.query("SELECT COUNT(*) AS totalTokens FROM reg_tokens");
        const [[chatStats]] = await pool.query("SELECT COUNT(*) AS totalLogs FROM pvpgn_chat_logs");
        const [[muteStats]] = await pool.query("SELECT COUNT(*) AS activeMutes FROM pvpgn_chat_mutes WHERE expires_at IS NULL OR expires_at > NOW()");
        const [tables] = await pool.query(
            "SELECT table_name AS name, table_rows AS rowsCount, ROUND((data_length + index_length) / 1024, 1) AS sizeKb FROM information_schema.TABLES WHERE table_schema = 'pvpgn' ORDER BY (data_length + index_length) DESC LIMIT 25"
        );
        res.json({
            success: true,
            stats: accStats,
            tokens: tokStats.totalTokens || 0,
            chat: {
                totalLogs: chatStats ? chatStats.totalLogs : 0,
                activeMutes: muteStats ? muteStats.activeMutes : 0
            },
            tables: tables || []
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// -----------------------------
// Admin Feature 1: Announcements & MOTD
// -----------------------------
app.get("/api/admin/announcements", requireAdminAuth, (req, res) => {
    try {
        const w3motd = fs.existsSync("/etc/pvpgn/w3motd.txt") ? fs.readFileSync("/etc/pvpgn/w3motd.txt", "utf-8") : "";
        const bnmotd = fs.existsSync("/etc/pvpgn/bnmotd.txt") ? fs.readFileSync("/etc/pvpgn/bnmotd.txt", "utf-8") : "";
        const news = fs.existsSync("/etc/pvpgn/news.txt") ? fs.readFileSync("/etc/pvpgn/news.txt", "utf-8") : "";
        const topics = fs.existsSync("/etc/pvpgn/topics.conf") ? fs.readFileSync("/etc/pvpgn/topics.conf", "utf-8") : "";
        res.json({ success: true, w3motd, bnmotd, news, topics });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/admin/announcements", requireAdminAuth, async (req, res) => {
    try {
        const { w3motd, bnmotd, news, topics, reloadServer } = req.body;
        if (typeof w3motd === "string") fs.writeFileSync("/etc/pvpgn/w3motd.txt", w3motd, "utf-8");
        if (typeof bnmotd === "string") fs.writeFileSync("/etc/pvpgn/bnmotd.txt", bnmotd, "utf-8");
        if (typeof news === "string") fs.writeFileSync("/etc/pvpgn/news.txt", news, "utf-8");
        if (typeof topics === "string") fs.writeFileSync("/etc/pvpgn/topics.conf", topics, "utf-8");

        if (reloadServer) {
            await signalPvpgnRehash();
        }
        res.json({ success: true, message: "Server announcements and MOTD saved successfully!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// -----------------------------
// Admin Feature 2: IP Ban & Blacklist Manager
// -----------------------------
app.get("/api/admin/bans", requireAdminAuth, async (req, res) => {
    try {
        const banFile = "/etc/pvpgn/bnban.conf";
        const fileIps = new Set();
        if (fs.existsSync(banFile)) {
            const lines = fs.readFileSync(banFile, "utf-8").split("\n");
            for (const raw of lines) {
                const line = raw.trim();
                if (!line || line.startsWith("#")) continue;
                const ip = line.split(/\s+/)[0];
                if (ip) fileIps.add(ip);
            }
        }

        let dbBans = [];
        if (pool) {
            const [rows] = await pool.query(
                "SELECT id, ip, username, banned_by, reason, banned_at, expires_at, is_active FROM pvpgn_ip_bans WHERE is_active = 1 AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY id DESC"
            );
            dbBans = rows || [];
        }

        const knownIps = new Set(dbBans.map(b => b.ip));
        const bans = dbBans.map(b => ({
            id: b.id,
            ip: b.ip,
            username: b.username || "(unspecified)",
            banned_by: b.banned_by,
            reason: b.reason,
            time: "0",
            banned_at: b.banned_at,
            expires_at: b.expires_at,
            raw: `${b.ip} (${b.username || 'unknown'})`
        }));

        // Include any legacy/manual bans in bnban.conf not yet recorded in DB
        for (const fIp of fileIps) {
            if (!knownIps.has(fIp)) {
                bans.push({
                    id: null,
                    ip: fIp,
                    username: "(config file)",
                    banned_by: "File/Server",
                    reason: "Manual bnban.conf entry",
                    time: "0",
                    banned_at: null,
                    expires_at: null,
                    raw: fIp
                });
            }
        }

        res.json({ success: true, bans });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/admin/bans/add", requireAdminAuth, async (req, res) => {
    try {
        let ip = typeof req.body.ip === "string" ? req.body.ip.trim() : "";
        let username = typeof req.body.username === "string" ? req.body.username.trim() : null;
        const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : "Banned by Admin";

        let durationSeconds = 0;
        if (typeof req.body.duration !== "undefined") {
            const dur = String(req.body.duration).trim().toLowerCase();
            const m = dur.match(/^(\d+)([smhdw]?)$/);
            if (m) {
                const val = parseInt(m[1], 10);
                const unit = m[2] || "s";
                if (unit === "s") durationSeconds = val;
                else if (unit === "m") durationSeconds = val * 60;
                else if (unit === "h") durationSeconds = val * 3600;
                else if (unit === "d") durationSeconds = val * 86400;
                else if (unit === "w") durationSeconds = val * 7 * 86400;
            }
        }
        const lockTime = durationSeconds > 0 ? Math.floor(Date.now() / 1000) + durationSeconds : 0;
        const expiresAt = durationSeconds > 0 ? new Date(Date.now() + durationSeconds * 1000) : null;

        if (!ip && !username) {
            return res.status(400).json({ error: "Username or IP Address required" });
        }

        // If username provided but no IP, resolve IP from database
        if (!ip && username && pool) {
            const [rows] = await pool.query(
                "SELECT acct_lastlogin_ip FROM pvpgn_BNET WHERE LOWER(username) = LOWER(?) OR LOWER(acct_username) = LOWER(?) LIMIT 1",
                [username, username]
            );
            if (rows && rows.length > 0 && rows[0].acct_lastlogin_ip) {
                ip = rows[0].acct_lastlogin_ip.trim();
            }
            if (!ip) {
                const [ipRows] = await pool.query(
                    "SELECT ip_address FROM pvpgn_account_ips WHERE LOWER(username) = LOWER(?) ORDER BY last_seen DESC LIMIT 1",
                    [username]
                );
                if (ipRows && ipRows.length > 0 && ipRows[0].ip_address) {
                    ip = ipRows[0].ip_address.trim();
                }
            }
        }

        // Lock target username directly if specified
        if (username && pool && !isRootIdentity(username)) {
            await pool.execute(
                "UPDATE pvpgn_BNET SET auth_lock = 'true', auth_lockreason = ?, auth_locktime = ? WHERE LOWER(username) = LOWER(?) OR LOWER(acct_username) = LOWER(?)",
                [reason, lockTime, username, username]
            );
            try {
                fs.appendFileSync(WEB_TO_BNET_PIPE, `__LOCK__\t${username}\t${reason}\n`, { mode: 0o666 });
            } catch (e) { }
        }

        const effectiveIp = ip || "N/A";

        // Record in MySQL pvpgn_ip_bans
        if (pool) {
            await pool.execute(
                `INSERT INTO pvpgn_ip_bans (ip, username, banned_by, reason, expires_at) 
                 VALUES (?, ?, 'Admin', ?, ?)`,
                [effectiveIp, username, reason, expiresAt]
            );
        }

        // If valid IP provided and NOT an account ban, enforce in bnban.conf
        if (!username && effectiveIp !== "N/A" && /^[\d\.\:\/]+$/.test(effectiveIp)) {
            const banFile = "/etc/pvpgn/bnban.conf";
            let exists = false;
            if (fs.existsSync(banFile)) {
                const lines = fs.readFileSync(banFile, "utf-8").split("\n");
                exists = lines.some(l => l.trim().startsWith(effectiveIp));
            }
            if (!exists) {
                fs.appendFileSync(banFile, `${effectiveIp}\n`, "utf-8");
            }

            // Sever active connections
            try {
                const pipeLine = `__IPBAN__\t${effectiveIp}\tAdmin\t${reason.replace(/[\r\n\t]+/g, " ")}\n`;
                fs.appendFileSync(WEB_TO_BNET_PIPE, pipeLine, { mode: 0o666 });
            } catch (e) { }
        }

        // Live SIGHUP rehash bnetd so bnban.conf is active immediately without restarting server
        await signalPvpgnRehash();

        res.json({ success: true, message: `Ban recorded for ${username || effectiveIp}.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/admin/bans/remove", requireAdminAuth, async (req, res) => {
    try {
        const targetIp = typeof req.body.ip === "string" ? req.body.ip.trim() : "";
        const targetUser = typeof req.body.username === "string" ? req.body.username.trim() : "";
        const id = req.body.id ? parseInt(req.body.id, 10) : null;

        if (id && pool) {
            await pool.execute("UPDATE pvpgn_ip_bans SET is_active = 0 WHERE id = ?", [id]);
        } else if (targetIp && targetIp !== "N/A" && pool) {
            await pool.execute("UPDATE pvpgn_ip_bans SET is_active = 0 WHERE ip = ?", [targetIp]);
        }

        if (targetUser && targetUser !== "N/A" && targetUser !== "(unspecified)" && pool) {
            const [userBans] = await pool.query(
                "SELECT ip FROM pvpgn_ip_bans WHERE LOWER(username) = LOWER(?) AND ip != 'N/A'",
                [targetUser]
            );
            await pool.execute("UPDATE pvpgn_ip_bans SET is_active = 0 WHERE LOWER(username) = LOWER(?)", [targetUser]);
            await pool.execute(
                "UPDATE pvpgn_BNET SET auth_lock = 'false', auth_lockreason = '' WHERE LOWER(username) = LOWER(?) OR LOWER(acct_username) = LOWER(?)",
                [targetUser, targetUser]
            );
            try {
                fs.appendFileSync(WEB_TO_BNET_PIPE, `__UNLOCK__\t${targetUser}\n`, { mode: 0o666 });
            } catch (e) { }

            if (userBans && userBans.length > 0) {
                const banFile = "/etc/pvpgn/bnban.conf";
                if (fs.existsSync(banFile)) {
                    const bannedIps = new Set(userBans.map(r => r.ip.trim()));
                    const lines = fs.readFileSync(banFile, "utf-8").split("\n");
                    const kept = lines.filter(l => {
                        const trimmed = l.trim();
                        if (!trimmed || trimmed.startsWith("#")) return true;
                        return !bannedIps.has(trimmed.split(/\s+/)[0]);
                    });
                    fs.writeFileSync(banFile, kept.join("\n"), "utf-8");
                }
            }
        }

        if (targetIp && targetIp !== "N/A") {
            const banFile = "/etc/pvpgn/bnban.conf";
            if (fs.existsSync(banFile)) {
                const lines = fs.readFileSync(banFile, "utf-8").split("\n");
                const kept = lines.filter(l => {
                    const trimmed = l.trim();
                    if (!trimmed || trimmed.startsWith("#")) return true;
                    return trimmed.split(/\s+/)[0] !== targetIp;
                });
                fs.writeFileSync(banFile, kept.join("\n"), "utf-8");
            }
        }

        // Live SIGHUP rehash bnetd so unban is active immediately without restarting server
        await signalPvpgnRehash();

        res.json({ success: true, message: "Ban removed successfully." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// -----------------------------
// Admin Feature 3: Clan & Team Management
// -----------------------------
function decodeClanTag(val) {
    if (!val) return "NONE";
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(val >>> 0, 0);
    const tag = buf.toString("ascii").replace(/\0/g, "").trim();
    if (/^[A-Za-z0-9_]{1,4}$/.test(tag)) return tag;
    buf.writeUInt32LE(val >>> 0, 0);
    return buf.toString("ascii").replace(/\0/g, "").trim() || String(val);
}

app.get("/api/admin/clans", requireAdminAuth, async (req, res) => {
    try {
        const [clans] = await pool.query(`
            SELECT c.cid, c.short, c.name, c.motd, c.creation_time,
                   (SELECT b.username FROM pvpgn_clanmember cm JOIN pvpgn_BNET b ON cm.uid = b.uid WHERE cm.cid = c.cid AND cm.status = 4 LIMIT 1) AS chieftain,
                   (SELECT COUNT(*) FROM pvpgn_clanmember cm WHERE cm.cid = c.cid) AS member_count
            FROM pvpgn_clan c
            WHERE c.cid > 0 AND c.name IS NOT NULL
            ORDER BY c.cid ASC
        `);
        const formatted = clans.map(c => ({
            ...c,
            tag: decodeClanTag(c.short),
            created_at: c.creation_time ? new Date(c.creation_time * 1000).toISOString() : null
        }));
        res.json({ success: true, clans: formatted });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete("/api/admin/clans/:cid", requireAdminAuth, async (req, res) => {
    try {
        const cid = parseInt(req.params.cid, 10);
        if (!cid) return res.status(400).json({ error: "Clan ID required" });

        await pool.execute("DELETE FROM pvpgn_clanmember WHERE cid = ?", [cid]);
        await pool.execute("DELETE FROM pvpgn_clan WHERE cid = ?", [cid]);
        await reloadPvpgnAccounts();
        res.json({ success: true, message: `Clan #${cid} disbanded.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/admin/clans/:cid/members", requireAdminAuth, async (req, res) => {
    try {
        const cid = parseInt(req.params.cid, 10);
        if (!cid) return res.status(400).json({ error: "Invalid clan ID." });

        const [members] = await pool.query(`
            SELECT cm.uid, cm.status, cm.join_time, b.username, b.acct_email, b.acct_lastlogin_time
            FROM pvpgn_clanmember cm
            JOIN pvpgn_BNET b ON cm.uid = b.uid
            WHERE cm.cid = ?
            ORDER BY cm.status DESC, cm.join_time ASC
        `, [cid]);

        const statusNames = { 4: "Chieftain", 3: "Shaman", 2: "Grunt", 1: "Peon" };
        const formatted = members.map(m => ({
            uid: m.uid,
            username: m.username,
            status: m.status,
            role_name: statusNames[m.status] || "Member",
            joined_at: m.join_time ? new Date(m.join_time * 1000).toISOString() : null,
            last_login: m.acct_lastlogin_time ? new Date(m.acct_lastlogin_time * 1000).toISOString() : null
        }));

        res.json({ success: true, members: formatted });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/admin/clans/:cid/chieftain", requireAdminAuth, async (req, res) => {
    try {
        const cid = parseInt(req.params.cid, 10);
        const uid = parseInt(req.body.uid, 10);
        if (!cid || !uid) return res.status(400).json({ error: "Clan ID and target User ID are required." });

        const [memberCheck] = await pool.execute(
            "SELECT uid FROM pvpgn_clanmember WHERE cid = ? AND uid = ? LIMIT 1",
            [cid, uid]
        );
        if (memberCheck.length === 0) {
            return res.status(404).json({ error: "User is not a member of this clan." });
        }

        await pool.execute(
            "UPDATE pvpgn_clanmember SET status = 3 WHERE cid = ? AND status = 4",
            [cid]
        );
        await pool.execute(
            "UPDATE pvpgn_clanmember SET status = 4 WHERE cid = ? AND uid = ?",
            [cid, uid]
        );

        await reloadPvpgnAccounts();
        res.json({ success: true, message: "Member promoted to Clan Chieftain." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// -----------------------------
// Admin Feature 4: Player Ladder & Match Records
// -----------------------------
app.get("/api/admin/ladder", requireAdminAuth, async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT b.uid, b.username, b.acct_lastlogin_time,
                   COALESCE(r.W3XP_solo_wins, 0) AS solo_wins,
                   COALESCE(r.W3XP_solo_losses, 0) AS solo_losses,
                   COALESCE(r.W3XP_solo_level, 0) AS solo_level,
                   COALESCE(r.W3XP_solo_xp, 0) AS solo_xp,
                   COALESCE(r.W3XP_team_wins, 0) AS team_wins,
                   COALESCE(r.W3XP_team_losses, 0) AS team_losses,
                   (COALESCE(r.W3XP_solo_wins, 0) + COALESCE(r.W3XP_team_wins, 0)) AS total_wins,
                   (COALESCE(r.W3XP_solo_losses, 0) + COALESCE(r.W3XP_team_losses, 0)) AS total_losses
            FROM pvpgn_BNET b
            LEFT JOIN pvpgn_Record r ON b.uid = r.uid
            WHERE b.uid > 0
            ORDER BY total_wins DESC, solo_xp DESC
            LIMIT 100
        `);

        const ranked = rows.map((r, idx) => {
            const totalGames = r.total_wins + r.total_losses;
            const winRate = totalGames > 0 ? ((r.total_wins / totalGames) * 100).toFixed(1) + "%" : "0%";
            return {
                rank: idx + 1,
                ...r,
                totalGames,
                winRate
            };
        });

        res.json({ success: true, ladder: ranked });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// -----------------------------
// Admin Feature 5: 1-Click Database Backup & Download
// -----------------------------
app.get("/api/admin/db-backup", requireAdminAuth, async (req, res) => {
    try {
        const [tables] = await pool.query("SHOW TABLES");
        const tableKey = Object.keys(tables[0] || {})[0];
        let sqlDump = `-- PvPGN Database Backup\n-- Generated on: ${new Date().toISOString()}\n-- Server: DotA & Friends PvPGN Core PRO\n\nSET FOREIGN_KEY_CHECKS=0;\n\n`;

        for (const t of tables) {
            const tableName = t[tableKey];
            const [[createRes]] = await pool.query(`SHOW CREATE TABLE \`${tableName}\``);
            sqlDump += `DROP TABLE IF EXISTS \`${tableName}\`;\n`;
            sqlDump += `${createRes["Create Table"]};\n\n`;

            const [rows] = await pool.query(`SELECT * FROM \`${tableName}\``);
            if (rows.length > 0) {
                const cols = Object.keys(rows[0]).map(c => `\`${c}\``).join(", ");
                for (const row of rows) {
                    const vals = Object.values(row).map(val => {
                        if (val === null) return "NULL";
                        if (typeof val === "number") return val;
                        return `'${String(val).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
                    }).join(", ");
                    sqlDump += `INSERT INTO \`${tableName}\` (${cols}) VALUES (${vals});\n`;
                }
                sqlDump += "\n";
            }
        }

        sqlDump += "SET FOREIGN_KEY_CHECKS=1;\n";

        const filename = `pvpgn_backup_${new Date().toISOString().replace(/[:.]/g, "-")}.sql`;
        res.setHeader("Content-Type", "application/sql");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.send(sqlDump);
    } catch (err) {
        res.status(500).json({ error: "Backup failed: " + err.message });
    }
});

// -----------------------------
// Admin Feature 6: Live Container Resource Graphs (CPU / RAM)
// -----------------------------
app.get("/api/admin/containers/stats", requireAdminAuth, async (req, res) => {
    try {
        const containerNames = ["pvpgn-server", "pvpgn-mysql", "pvpgn-caddy", "pvpgn-web", "pvpgn-adminer"];
        const statsList = await Promise.all(containerNames.map(name => {
            return new Promise((resolve) => {
                const clientReq = http.request({
                    socketPath: "/var/run/docker.sock",
                    path: `/v1.44/containers/${name}/stats?stream=false`,
                    method: "GET",
                    timeout: 4000
                }, (clientRes) => {
                    let data = "";
                    clientRes.on("data", chunk => data += chunk);
                    clientRes.on("end", () => {
                        try {
                            const stats = JSON.parse(data);
                            const cpuDelta = (stats.cpu_stats?.cpu_usage?.total_usage || 0) - (stats.precpu_stats?.cpu_usage?.total_usage || 0);
                            const systemDelta = (stats.cpu_stats?.system_cpu_usage || 0) - (stats.precpu_stats?.system_cpu_usage || 0);
                            const onlineCpus = stats.cpu_stats?.online_cpus || 1;
                            const cpuPerc = (systemDelta > 0 && cpuDelta > 0) ? ((cpuDelta / systemDelta) * onlineCpus * 100).toFixed(2) : "0.00";

                            const used = stats.memory_stats?.usage || 0;
                            const limit = stats.memory_stats?.limit || 1;
                            const memUsedMb = (used / (1024 * 1024)).toFixed(1);
                            const memLimitMb = (limit / (1024 * 1024)).toFixed(0);
                            const memPerc = Math.min(100, Math.max(0, (used / limit) * 100)).toFixed(1);

                            resolve({
                                name,
                                cpuPerc: parseFloat(cpuPerc),
                                memUsedMb: parseFloat(memUsedMb),
                                memLimitMb: parseFloat(memLimitMb),
                                memPerc: parseFloat(memPerc)
                            });
                        } catch {
                            resolve({ name, cpuPerc: 0, memUsedMb: 0, memLimitMb: 0, memPerc: 0 });
                        }
                    });
                });
                clientReq.on("error", () => resolve({ name, cpuPerc: 0, memUsedMb: 0, memLimitMb: 0, memPerc: 0 }));
                clientReq.end();
            });
        }));

        res.json({ success: true, stats: statsList });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


app.listen(3000, "0.0.0.0", () => {

    console.log(
        "PvPGN registration website running on port 3000"
    );

});