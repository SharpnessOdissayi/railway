import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import WebSocket from "ws";
import {
  parseSkuToGrant,
  resolveCanonicalSku,
  resolveRconCommands
} from "./tranzilaProducts.js";

console.log("BOOT: LoveRustPayBridge v2026-01-22-RCON-OPTIONAL");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.text({ type: ["text/plain"], limit: "1mb" }));
app.use((err, req, _res, next) => {
  if (err?.type === "entity.parse.failed") {
    console.warn("Body parse failed; continuing with empty body.");
    req.body = {};
    return next();
  }
  return next(err);
});

const {
  // Security
  API_SECRET, // required

  // RCON
  RCON_HOST,
  RCON_PORT,
  RCON_PASSWORD,

  // Database
  DB_PATH,

  // Behavior
  DRY_RUN = "false",
  TRAZNILA_NOTIFY_SECRET,
  BESTSERVERS_SERVERKEY,
  REFERRAL_SERVER_SECRET,
  PORT
} = process.env;

const resolvedPort = PORT || 8080;

function required(name, value) {
  if (!value) throw new Error(`Missing required env var: ${name}`);
}

required("API_SECRET", API_SECRET);
required("BESTSERVERS_SERVERKEY", BESTSERVERS_SERVERKEY);
required("REFERRAL_SERVER_SECRET", REFERRAL_SERVER_SECRET);
const isDryRun = DRY_RUN.toLowerCase() === "true";
const isRconConfigured = !!(RCON_HOST && RCON_PORT && RCON_PASSWORD);
const DISCORD_WEBHOOK_KEYS = [
  "DISCORD_WEBHOOK_URL",
  "DISCORD_WEBHOOK",
  "WEBHOOK_URL"
];
const discordWebhookConfig = resolveDiscordWebhook(process.env, DISCORD_WEBHOOK_KEYS);
const hasDiscordWebhook = !!discordWebhookConfig.url;

if (!isRconConfigured) {
  console.warn(
    "RCON is not fully configured (RCON_HOST/RCON_PORT/RCON_PASSWORD missing). VIP grants will fail until fixed."
  );
}
if (!hasDiscordWebhook) {
  console.warn(
    "Discord webhook is not configured (DISCORD_WEBHOOK_URL, DISCORD_WEBHOOK, or WEBHOOK_URL missing). Notifications will be skipped."
  );
}

const DATABASE_PATH = DB_PATH || "./data.sqlite";
const PROCESSED_TTL_MS = 24 * 60 * 60 * 1000;

const SKU_MAP = {
  vip_30d: {
    type: "permissions",
    rconGrant: [
      "oxide.grant user {steamid64} loverustvip.use",
      "oxide.grant user {steamid64} vipwall.use"
    ],
    rconRevoke: [
      "oxide.revoke user {steamid64} loverustvip.use",
      "oxide.revoke user {steamid64} vipwall.use"
    ],
    durationSeconds: 2592000
  },
  rainbow_30d: {
    type: "permissions",
    rconGrant: [
      "loverustvip.grantrainbow {steamid64} 30d"
    ],
    rconRevoke: [
      "loverustvip.revokerainbow {steamid64}"
    ],
    durationSeconds: 2592000
  },
  coffee_support: {
    type: "no_grant",
    rconGrant: [],
    rconRevoke: [],
    durationSeconds: 0,
    skipGrant: true
  }
};

// Rust RCON uses WebSocket: ws://HOST:PORT/PASSWORD
async function rconSend(command, { timeoutMs = 8000 } = {}) {
  if (isDryRun) {
    console.log(`[DRY_RUN] RCON command: ${command}`);
    return { ok: true, dryRun: true };
  }

  const url = `ws://${RCON_HOST}:${RCON_PORT}/${RCON_PASSWORD}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);

    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("RCON timeout"));
    }, timeoutMs);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        Identifier: 1,
        Message: command,
        Name: "LoveRustPayBridge"
      }));
    });

    ws.on("message", (data) => {
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      resolve({ ok: true, raw: data.toString() });
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function initDb() {
  const db = await open({
    filename: DATABASE_PATH,
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      txnId TEXT PRIMARY KEY,
      steamid64 TEXT NOT NULL,
      sku TEXT NOT NULL,
      status TEXT NOT NULL,
      amount TEXT,
      createdAt TEXT NOT NULL
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS entitlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      steamid64 TEXT NOT NULL,
      sku TEXT NOT NULL,
      txnId TEXT NOT NULL,
      grantedAt TEXT NOT NULL,
      expiresAt TEXT,
      revokeCommand TEXT NOT NULL,
      revokedAt TEXT
    );
  `);

  await db.exec(
    "CREATE INDEX IF NOT EXISTS entitlements_expiry ON entitlements (expiresAt, revokedAt);"
  );

  await db.exec(`
    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrerId TEXT NOT NULL,
      referredId TEXT NOT NULL UNIQUE,
      code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      confirmedAt TEXT,
      verifiedAt TEXT,
      playSecondsAtVerify INTEGER,
      createdAt TEXT NOT NULL
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS referrer_meta (
      referrerId TEXT PRIMARY KEY,
      verifiedCount INTEGER NOT NULL DEFAULT 0,
      eligibleAt TEXT,
      paidAt TEXT
    );
  `);

  await db.exec(
    "CREATE INDEX IF NOT EXISTS referrals_referrer ON referrals (referrerId, status);"
  );

  await db.exec(`
    CREATE TABLE IF NOT EXISTS portal_codes (
      code TEXT PRIMARY KEY,
      steamid64 TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
  `);

  await db.exec(
    "CREATE INDEX IF NOT EXISTS portal_codes_expiry ON portal_codes (expiresAt);"
  );

  return db;
}

const dbPromise = initDb().catch((err) => {
  console.error("Failed to initialize database:", err);
  process.exit(1);
});

async function recordEntitlements({ steamid64, effectiveSku, txnId, grantedAt }) {
  const mapped = SKU_MAP[effectiveSku];
  if (!mapped || mapped.skipGrant) return;
  const revokeCommands = mapped.rconRevoke || [];
  if (!revokeCommands.length) return;

  const grantedAtIso = grantedAt.toISOString();
  const expiresAt = mapped.durationSeconds
    ? new Date(grantedAt.getTime() + mapped.durationSeconds * 1000).toISOString()
    : null;
  const db = await dbPromise;

  for (const command of revokeCommands) {
    const revokeCommand = command.replace("{steamid64}", steamid64);
    await db.run(
      "INSERT INTO entitlements (steamid64, sku, txnId, grantedAt, expiresAt, revokeCommand) VALUES (?, ?, ?, ?, ?, ?)",
      steamid64,
      effectiveSku,
      txnId,
      grantedAtIso,
      expiresAt,
      revokeCommand
    );
  }
}

function resolveDiscordWebhook(env, keys) {
  for (const key of keys) {
    const value = env[key];
    if (value && String(value).trim() !== "") {
      return { url: String(value).trim(), keyName: key };
    }
  }
  return { url: "", keyName: "" };
}

function logDiscordWebhookConfigured() {
  console.log(
    `Discord webhook configured: ${hasDiscordWebhook} (env key used: ${
      discordWebhookConfig.keyName || "none"
    })`
  );
}

async function discordNotify({ content, txnId, steamid64, product, amount } = {}) {
  if (!discordWebhookConfig.url) return;

  try {
    console.log(
      "Discord webhook sending:",
      `txnId=${truncateLog(txnId) || "(empty)"}`,
      `steamid64=${truncateLog(steamid64) || "(empty)"}`,
      `product=${truncateLog(product) || "(empty)"}`,
      `amount=${truncateLog(amount) || "(empty)"}`
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(discordWebhookConfig.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
      signal: controller.signal
    }).finally(() => clearTimeout(timeout));

    console.log(
      "Discord webhook response:",
      `${res.status} ${res.statusText}`.trim()
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const snippet = text.slice(0, 200);
      if (snippet) {
        console.warn("Discord webhook non-2xx body:", snippet);
      }
    }
  } catch (err) {
    console.warn("Discord webhook error:", err?.message || err);
  }
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== "") {
      return String(obj[k]).trim();
    }
  }
  return "";
}

function pickFirstWithKey(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== "") {
      return { value: String(obj[k]).trim(), key: k };
    }
  }
  return { value: "", key: "" };
}

function pickFirstFromSources(sources, keys) {
  for (const source of sources) {
    const value = pickFirst(source, keys);
    if (value) return value;
  }
  return "";
}

function pickFirstFromSourcesWithKey(sources, keys) {
  for (const source of sources) {
    const result = pickFirstWithKey(source, keys);
    if (result.value) return result;
  }
  return { value: "", key: "" };
}

function truncateLog(value, maxLength = 80) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function normalizeAmount(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number.parseFloat(String(value).replace(/,/g, "").trim());
  if (!Number.isFinite(numeric)) return null;
  return Number.parseFloat(numeric.toFixed(2));
}

function coerceBody(req) {
  if (typeof req.body === "string") {
    const trimmed = req.body.trim();
    if (!trimmed) return {};
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        return JSON.parse(trimmed);
      } catch (err) {
        console.warn("Failed to parse JSON body string:", err?.message || err);
      }
    }
    const params = new URLSearchParams(trimmed);
    return Object.fromEntries(params.entries());
  }
  return req.body || {};
}

function normalizeNotifyFields(req) {
  const body = coerceBody(req);
  const sources = [body, req.query || {}];
  const steamid64 = pickFirstFromSources(sources, [
    "steamid64",
    "contact",
    "steam_id",
    "steamId",
    "custom1"
  ]);
  const custom2 = pickFirstFromSources(sources, ["custom2"]);
  const pdesc = pickFirstFromSources(sources, [
    "pdesc",
    "plan",
    "description"
  ]);
  const product = pickFirstFromSources(sources, ["product", "sku"]);
  const plan = pickFirstFromSources(sources, ["plan"]);
  const amount = pickFirstFromSources(sources, ["sum", "amount", "total"]);
  const status = pickFirstFromSources(sources, ["status", "Response", "response"]);
  const responseCode = pickFirstFromSources(sources, ["Response", "response"]);
  const txnIdResult = pickFirstFromSourcesWithKey(sources, [
    "ConfirmationCode",
    "Tempref",
    "txnId",
    "transaction_id",
    "tranId",
    "transId",
    "tx",
    "index",
    "orderid",
    "orderId",
    "id"
  ]);

  return {
    body,
    steamid64,
    custom2,
    pdesc,
    product,
    plan,
    amount,
    status,
    responseCode,
    txnId: txnIdResult.value,
    txnIdSource: txnIdResult.key
  };
}

const SENSITIVE_LOG_KEYS = new Set([
  "ccno",
  "expmonth",
  "expyear",
  "confirmationcode",
  "cardtype",
  "cvv",
  "cvc"
]);

function isSensitiveLogKey(key) {
  return key ? SENSITIVE_LOG_KEYS.has(String(key).toLowerCase()) : false;
}

function isApprovedStatus(status, responseCode) {
  const values = [status, responseCode].filter(Boolean).map((value) => String(value).trim().toLowerCase());
  if (!values.length) return false;
  return values.some((value) => {
    if (["approved", "ok", "success"].includes(value)) return true;
    return /^0+$/.test(value);
  });
}

function isIdempotentSource(_req) {
  return true;
}

function isDuplicateWindow(txnId, now = Date.now()) {
  const record = recentTxIds.get(txnId);
  if (!record) return false;
  const ageMs = now - record.at;
  return ageMs < 5 * 60 * 1000;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const processedTxCache = new Map();
const recentTxIds = new Map();
const bestserversCooldownCache = new Map();
const BESTSERVERS_COOLDOWN_MS = 2 * 60 * 1000;

function pruneProcessedTxCache(now = Date.now()) {
  for (const [key, timestamp] of processedTxCache.entries()) {
    if (now - timestamp > PROCESSED_TTL_MS) {
      processedTxCache.delete(key);
    }
  }
}

function hasProcessedTx(txnKey, now = Date.now()) {
  pruneProcessedTxCache(now);
  return processedTxCache.has(txnKey);
}

function markProcessedTx(txnKey, now = Date.now()) {
  pruneProcessedTxCache(now);
  processedTxCache.set(txnKey, now);
}

function markRecentTxId(txnKey, status, now = Date.now()) {
  recentTxIds.set(txnKey, { status, at: now });
}

function pruneBestserversCooldown(now = Date.now()) {
  for (const [key, timestamp] of bestserversCooldownCache.entries()) {
    if (now - timestamp > BESTSERVERS_COOLDOWN_MS) {
      bestserversCooldownCache.delete(key);
    }
  }
}

function isBestserversCooldownActive(steamid64, now = Date.now()) {
  pruneBestserversCooldown(now);
  return bestserversCooldownCache.has(steamid64);
}

function markBestserversCooldown(steamid64, now = Date.now()) {
  pruneBestserversCooldown(now);
  bestserversCooldownCache.set(steamid64, now);
}

const REFERRAL_CODE_LENGTH = 6;
const REFERRAL_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const REFERRAL_REQUIRED_VERIFIED = 5;
const REFERRAL_VERIFY_THRESHOLD_SECONDS = 86400;
const PORTAL_CODE_LENGTH = 4;
const PORTAL_CODE_TTL_MS = 10 * 60 * 1000;
const PORTAL_CODE_MAX_ATTEMPTS = 6;
const PORTAL_STATUS_RATE_LIMIT = {
  limit: 10,
  windowMs: 60 * 1000
};
const portalStatusRateCache = new Map();

function isValidSteamId64(value) {
  return /^\d{17}$/.test(String(value || "").trim());
}

function normalizeReferralCode(value) {
  return String(value || "").trim().toUpperCase();
}

function generateReferralCode() {
  const bytes = crypto.randomBytes(REFERRAL_CODE_LENGTH);
  let code = "";
  for (const byte of bytes) {
    code += REFERRAL_CODE_ALPHABET[byte % REFERRAL_CODE_ALPHABET.length];
  }
  return code;
}

function generatePortalCode() {
  const value = crypto.randomInt(0, 10 ** PORTAL_CODE_LENGTH);
  return String(value).padStart(PORTAL_CODE_LENGTH, "0");
}

function normalizePortalCode(value) {
  return String(value || "").trim();
}

function isValidPortalCode(value) {
  return /^\d{4}$/.test(String(value || ""));
}

function getRequestIp(req) {
  const header = req.headers["x-forwarded-for"];
  if (header) {
    const parts = String(header).split(",").map((part) => part.trim()).filter(Boolean);
    if (parts.length > 0) return parts[0];
  }
  return req.ip || req.connection?.remoteAddress || "unknown";
}

function isPortalStatusRateLimited(req, now = Date.now()) {
  const ip = getRequestIp(req);
  const record = portalStatusRateCache.get(ip);
  if (!record || now >= record.resetAt) {
    portalStatusRateCache.set(ip, { count: 1, resetAt: now + PORTAL_STATUS_RATE_LIMIT.windowMs });
    return false;
  }
  if (record.count >= PORTAL_STATUS_RATE_LIMIT.limit) {
    return true;
  }
  record.count += 1;
  portalStatusRateCache.set(ip, record);
  return false;
}

function getReferralAuthToken(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length).trim();
}

function isReferralAuthorized(req) {
  const token = getReferralAuthToken(req);
  return token && token === REFERRAL_SERVER_SECRET;
}

async function cleanupExpiredPortalCodes(db, nowIso = new Date().toISOString()) {
  await db.run("DELETE FROM portal_codes WHERE expiresAt <= ?", nowIso);
}

async function consumePortalCode(db, code) {
  const nowIso = new Date().toISOString();
  await db.exec("BEGIN IMMEDIATE");
  try {
    const row = await db.get(
      "SELECT code, steamid64, expiresAt FROM portal_codes WHERE code = ? AND expiresAt > ?",
      code,
      nowIso
    );
    if (!row) {
      await db.exec("ROLLBACK");
      return null;
    }
    await db.run("DELETE FROM portal_codes WHERE code = ?", code);
    await db.exec("COMMIT");
    return row;
  } catch (err) {
    await db.exec("ROLLBACK");
    throw err;
  }
}
const STATUS_CACHE_TTL_MS = 10 * 1000;
const STATUS_RAW_MAX = 600;
const STATUS_TIMEZONE = "Asia/Jerusalem";
const STATUS_DAY_START_HOUR = 5;
const statusCache = {
  value: null,
  expiresAt: 0,
  inflight: null
};
const statusState = {
  lastKnownMax: 0
};

function getZonedDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const parts = formatter.formatToParts(date);
  const result = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      result[part.type] = part.value;
    }
  }
  return {
    year: result.year,
    month: result.month,
    day: result.day,
    hour: Number.parseInt(result.hour, 10),
    minute: Number.parseInt(result.minute, 10)
  };
}

class PeakTracker {
  constructor({ storagePath, timeZone, dayStartHour }) {
    this.storagePath = storagePath;
    this.timeZone = timeZone;
    this.dayStartHour = dayStartHour;
    this.dayKey = null;
    this.peakToday = null;
    this.peakTodayUpdatedAt = null;
    this.warnedNoStorage = false;
  }

  computeDayKey(now = new Date(), timeZone = this.timeZone, dayStartHour = this.dayStartHour) {
    const parts = getZonedDateParts(now, timeZone);
    const beforeDayStart = parts.hour < dayStartHour;
    if (!beforeDayStart) {
      return `${parts.year}-${parts.month}-${parts.day}`;
    }
    const previousDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const previousParts = getZonedDateParts(previousDate, timeZone);
    return `${previousParts.year}-${previousParts.month}-${previousParts.day}`;
  }

  async load() {
    if (!this.storagePath) {
      this.warnNoStorage();
      return;
    }
    try {
      const raw = await fs.readFile(this.storagePath, "utf8");
      const parsed = JSON.parse(raw);
      this.dayKey = typeof parsed?.dayKey === "string" ? parsed.dayKey : null;
      this.peakToday = Number.isFinite(parsed?.peakToday) ? parsed.peakToday : null;
      this.peakTodayUpdatedAt = parsed?.peakTodayUpdatedAt || null;
      console.log("PeakTracker load success:", {
        path: this.storagePath,
        dayKey: this.dayKey,
        peakToday: this.peakToday
      });
    } catch (err) {
      if (err.code === "ENOENT") {
        console.log("PeakTracker storage not found; starting fresh:", this.storagePath);
      } else {
        console.warn("PeakTracker load failed:", err?.message || err);
      }
    }
  }

  async save() {
    if (!this.storagePath) {
      this.warnNoStorage();
      return;
    }
    try {
      await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
      const payload = JSON.stringify(
        {
          dayKey: this.dayKey,
          peakToday: this.peakToday,
          peakTodayUpdatedAt: this.peakTodayUpdatedAt
        },
        null,
        2
      );
      await fs.writeFile(this.storagePath, payload, "utf8");
      console.log("PeakTracker save success:", {
        path: this.storagePath,
        dayKey: this.dayKey,
        peakToday: this.peakToday
      });
    } catch (err) {
      console.warn("PeakTracker save failed:", err?.message || err);
    }
  }

  warnNoStorage() {
    if (this.warnedNoStorage) return;
    this.warnedNoStorage = true;
    console.warn("No persistent storage configured; peak resets on restart.");
  }

  async ensureCurrentDay(now = new Date()) {
    const computedDayKey = this.computeDayKey(now);
    if (this.dayKey === computedDayKey) return false;
    const previousDayKey = this.dayKey;
    const previousPeak = Number.isFinite(this.peakToday) ? this.peakToday : 0;
    this.dayKey = computedDayKey;
    this.peakToday = 0;
    this.peakTodayUpdatedAt = now.toISOString();
    console.log(
      "PeakTracker day rollover:",
      `${previousDayKey || "(none)"} -> ${computedDayKey}`,
      `peak ${previousPeak} -> reset`
    );
    await this.save();
    return true;
  }

  async update(online, now = new Date()) {
    await this.ensureCurrentDay(now);
    if (!Number.isFinite(online)) return;
    const currentPeak = Number.isFinite(this.peakToday) ? this.peakToday : 0;
    if (online > currentPeak) {
      this.peakToday = online;
      this.peakTodayUpdatedAt = now.toISOString();
      await this.save();
    }
  }

  getPeakForResponse() {
    const peak = Number.isFinite(this.peakToday) ? this.peakToday : 0;
    return Math.max(10, peak);
  }
}

async function resolvePeakStoragePath() {
  const candidates = [];
  if (process.env.VOLUME_PATH) {
    candidates.push(process.env.VOLUME_PATH);
  }
  candidates.push("/data");
  for (const candidate of candidates) {
    try {
      const stats = await fs.stat(candidate);
      if (stats.isDirectory()) {
        return path.join(candidate, "peak.json");
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.warn("Peak storage path check failed:", err?.message || err);
      }
    }
  }
  return null;
}

const peakStoragePath = await resolvePeakStoragePath();
const peakTracker = new PeakTracker({
  storagePath: peakStoragePath,
  timeZone: STATUS_TIMEZONE,
  dayStartHour: STATUS_DAY_START_HOUR
});
const peakTrackerReady = peakTracker.load();

function readStatusCache() {
  if (!statusCache.value) return null;
  if (Date.now() >= statusCache.expiresAt) return null;
  return statusCache.value;
}

function writeStatusCache(payload) {
  statusCache.value = payload;
  statusCache.expiresAt = Date.now() + STATUS_CACHE_TTL_MS;
}

function truncateRawStatus(raw) {
  if (!raw) return "";
  const text = String(raw).trim();
  if (text.length <= STATUS_RAW_MAX) return text;
  return `${text.slice(0, STATUS_RAW_MAX)}...`;
}

function formatStatusPayload({ ok, online, max, raw, error }) {
  const payload = {
    ok: Boolean(ok),
    online: Number.isFinite(online) ? online : null,
    max: Number.isFinite(max) ? max : null,
    peakToday: peakTracker.getPeakForResponse(),
    peakTodayUpdatedAt: peakTracker.peakTodayUpdatedAt,
    dayKey: peakTracker.dayKey,
    updatedAt: new Date().toISOString()
  };
  if (raw) payload.raw = truncateRawStatus(raw);
  if (error) payload.error = error;
  return payload;
}

function parsePlayerCounts(raw) {
  if (!raw) return { online: null, max: null };
  const text = String(raw);
  const patterns = [
    /players?\s*[:=]?\s*(\d+)\s*(?:\/|\(|\s+of\s+)\s*(\d+)/i,
    /players?\s*[:=]?\s*(\d+)\s*\(\s*(\d+)\s*max\s*\)/i,
    /(\d+)\s*players?\s*[,/]\s*(\d+)\s*max/i,
    /players?\s*[:=]?\s*(\d+)\s*\/\s*(\d+)/i,
    /(\d+)\s*\/\s*(\d+)\s*players?/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const online = Number.parseInt(match[1], 10);
      const max = Number.parseInt(match[2], 10);
      if (Number.isFinite(online) && Number.isFinite(max)) {
        return { online, max };
      }
    }
  }

  if (/players?|max/i.test(text)) {
    const numberMatches = [...text.matchAll(/\d+/g)].map((match) => Number.parseInt(match[0], 10));
    if (numberMatches.length >= 2) {
      return { online: numberMatches[0], max: numberMatches[1] };
    }
  }
  return { online: null, max: null };
}

async function fetchServerStatus() {
  await peakTrackerReady;
  await peakTracker.ensureCurrentDay();
  if (!isRconConfigured) {
    const payload = formatStatusPayload({
      ok: true,
      online: 0,
      max: statusState.lastKnownMax || 0,
      error: "rcon_not_configured"
    });
    writeStatusCache(payload);
    return payload;
  }

  try {
    const result = await rconSend("status", { timeoutMs: 3000 });
    const raw = result?.raw || "";
    const { online, max } = parsePlayerCounts(raw);
    if (Number.isFinite(online) && Number.isFinite(max)) {
      statusState.lastKnownMax = max;
      await peakTracker.update(online);
      const payload = formatStatusPayload({ ok: true, online, max, raw });
      writeStatusCache(payload);
      return payload;
    }
    const payload = formatStatusPayload({
      ok: true,
      online: 0,
      max: statusState.lastKnownMax || 0,
      raw,
      error: "parse_failed"
    });
    writeStatusCache(payload);
    return payload;
  } catch (err) {
    const payload = formatStatusPayload({
      ok: true,
      online: 0,
      max: statusState.lastKnownMax || 0,
      error: "rcon_unreachable"
    });
    writeStatusCache(payload);
    return payload;
  }
}

app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
app.get("/bestservers/postback", async (req, res) => {
  const steamid64 = pickFirst(req.query, ["username"]);
  if (!/^\d{17}$/.test(steamid64)) {
    return res.status(400).json({ ok: false, reason: "invalid_steamid64" });
  }

  if (isBestserversCooldownActive(steamid64)) {
    return res.status(200).json({ ok: false, reason: "cooldown" });
  }

  if (!isRconConfigured) {
    return res.status(200).json({ ok: false, reason: "rcon_not_configured" });
  }

  markBestserversCooldown(steamid64);
  let verdict = "";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const url = new URL("https://bestservers.com/api/vote.php");
    url.searchParams.set("action", "claim");
    url.searchParams.set("key", BESTSERVERS_SERVERKEY);
    url.searchParams.set("steamid", steamid64);

    const response = await fetch(url, { signal: controller.signal }).finally(() => {
      clearTimeout(timeout);
    });
    const bodyText = await response.text();
    verdict = bodyText.trim();
  } catch (err) {
    const message = err?.message || err;
    if (String(message).toLowerCase().includes("abort")) {
      console.warn("BestServers vote claim failed: timeout");
    } else {
      console.warn("BestServers vote claim failed:", message);
    }
    return res.status(200).json({ ok: false, reason: "bestservers_api_error" });
  }

  if (verdict === "2") {
    return res.status(200).json({ ok: true, alreadyClaimed: true });
  }

  if (verdict === "0") {
    return res.status(200).json({ ok: false, reason: "no_vote_or_invalid" });
  }

  if (verdict !== "1") {
    console.warn("BestServers vote claim unexpected response:", verdict);
    return res.status(200).json({ ok: false, reason: "bestservers_api_error" });
  }

  try {
    const command = `loverust.voteannounce ${steamid64}`;
    await rconSend(command);
    await discordNotify({
      content: `🗳️ Vote verified & claimed\nSteamID: ${steamid64}\nSource: BestServers`,
      steamid64,
      product: "bestservers_vote"
    });
    return res.status(200).json({ ok: true, steamid64 });
  } catch (err) {
    console.warn("BestServers vote rejected: rcon_failed", err?.message || err);
    return res.status(200).json({ ok: false, reason: "rcon_failed" });
  }
});
app.options("/server/status", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.status(204).send();
});
app.get("/server/status", async (req, res) => {
  const origin = req.headers.origin;
  const allowedOrigin = origin === "https://loverust.gg" ? origin : "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Vary", "Origin");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  try {
    await peakTrackerReady;
    const dayChanged = await peakTracker.ensureCurrentDay();
    if (dayChanged) {
      statusCache.value = null;
      statusCache.expiresAt = 0;
    }

    const cached = readStatusCache();
    if (cached) {
      return res.status(200).json(cached);
    }

    const pending = statusCache.inflight;
    if (pending) {
      const result = await pending;
      return res.status(200).json(result);
    }

    const work = fetchServerStatus().finally(() => {
      statusCache.inflight = null;
    });
    statusCache.inflight = work;
    const result = await work;
    return res.status(200).json(result);
  } catch (err) {
    console.warn("Status endpoint error:", err?.message || err);
    const payload = formatStatusPayload({
      ok: true,
      online: 0,
      max: statusState.lastKnownMax || 0,
      error: "server_error"
    });
    writeStatusCache(payload);
    return res.status(200).json(payload);
  }
});
app.post("/api/referrals/portal-code", async (req, res) => {
  if (!isReferralAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  try {
    const body = coerceBody(req);
    const steamid64 = String(body?.steamid64 || "").trim();
    if (!isValidSteamId64(steamid64)) {
      return res.status(400).json({ ok: false, error: "invalid_steamid64" });
    }

    const db = await dbPromise;
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    await cleanupExpiredPortalCodes(db, nowIso);

    let code = "";
    for (let attempt = 0; attempt < PORTAL_CODE_MAX_ATTEMPTS; attempt += 1) {
      const candidate = generatePortalCode();
      const existing = await db.get(
        "SELECT code FROM portal_codes WHERE code = ? AND expiresAt > ?",
        candidate,
        nowIso
      );
      if (existing) {
        continue;
      }
      const expiresAtIso = new Date(now + PORTAL_CODE_TTL_MS).toISOString();
      try {
        await db.run(
          "INSERT INTO portal_codes (code, steamid64, expiresAt, createdAt) VALUES (?, ?, ?, ?)",
          candidate,
          steamid64,
          expiresAtIso,
          nowIso
        );
        code = candidate;
        break;
      } catch (err) {
        if (String(err?.message || "").toLowerCase().includes("constraint")) {
          continue;
        }
        throw err;
      }
    }

    if (!code) {
      return res.status(503).json({ ok: false, error: "code_generation_failed" });
    }

    return res.status(200).json({
      ok: true,
      code,
      expiresInSeconds: Math.floor(PORTAL_CODE_TTL_MS / 1000)
    });
  } catch (err) {
    console.warn("Portal code error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});
app.get("/api/referrals/portal-status", async (req, res) => {
  if (isPortalStatusRateLimited(req)) {
    return res.status(429).json({ ok: false, error: "invalid_or_expired_code" });
  }

  try {
    const code = normalizePortalCode(req.query?.code);
    if (!isValidPortalCode(code)) {
      return res.status(401).json({ ok: false, error: "invalid_or_expired_code" });
    }

    const db = await dbPromise;
    await cleanupExpiredPortalCodes(db);
    const portalRow = await consumePortalCode(db, code);
    if (!portalRow) {
      return res.status(401).json({ ok: false, error: "invalid_or_expired_code" });
    }

    const steamid64 = portalRow.steamid64;
    const referralRows = await db.all(
      `SELECT referrerId, referredId, status, confirmedAt, verifiedAt
       FROM referrals WHERE referrerId = ?
       ORDER BY createdAt DESC`,
      steamid64
    );
    const countRow = await db.get(
      "SELECT COUNT(*) AS count FROM referrals WHERE referrerId = ? AND status = 'verified'",
      steamid64
    );
    const verifiedCount = Number(countRow?.count || 0);
    const meta = await db.get(
      "SELECT eligibleAt FROM referrer_meta WHERE referrerId = ?",
      steamid64
    );

    return res.status(200).json({
      ok: true,
      steamid64,
      verifiedCount,
      required: REFERRAL_REQUIRED_VERIFIED,
      eligible: Boolean(meta?.eligibleAt),
      referrals: referralRows.map((row) => ({
        referredId: row.referredId,
        status: row.status,
        confirmedAt: row.confirmedAt,
        verifiedAt: row.verifiedAt
      })),
      playSeconds: null,
      afkSeconds: null,
      totalSeconds: null,
      remainingSeconds: null
    });
  } catch (err) {
    console.warn("Portal status error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});
app.post("/api/referrals/request", async (req, res) => {
  try {
    const body = coerceBody(req);
    const referrerId = String(body?.referrerId || "").trim();
    const referredId = String(body?.referredId || "").trim();

    if (!isValidSteamId64(referrerId) || !isValidSteamId64(referredId)) {
      return res.status(400).json({ ok: false, reason: "invalid_steamid64" });
    }
    if (referrerId === referredId) {
      return res.status(400).json({ ok: false, reason: "same_steamid64" });
    }

    const db = await dbPromise;
    const existing = await db.get(
      "SELECT id FROM referrals WHERE referredId = ?",
      referredId
    );
    if (existing) {
      return res.status(409).json({ ok: false, reason: "referred_exists" });
    }

    let code = "";
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = generateReferralCode();
      const codeTaken = await db.get(
        "SELECT id FROM referrals WHERE code = ?",
        candidate
      );
      if (!codeTaken) {
        code = candidate;
        break;
      }
    }
    if (!code) {
      return res.status(500).json({ ok: false, reason: "code_generation_failed" });
    }

    const createdAt = new Date().toISOString();
    await db.run(
      `INSERT INTO referrals
        (referrerId, referredId, code, status, createdAt)
       VALUES (?, ?, ?, ?, ?)`,
      referrerId,
      referredId,
      code,
      "pending",
      createdAt
    );

    return res.status(200).json({ ok: true, code });
  } catch (err) {
    console.warn("Referral request error:", err?.message || err);
    return res.status(500).json({ ok: false, reason: "server_error" });
  }
});
app.post("/api/referrals/confirm", async (req, res) => {
  if (!isReferralAuthorized(req)) {
    return res.status(401).json({ ok: false, reason: "unauthorized" });
  }

  try {
    const body = coerceBody(req);
    const referredId = String(body?.referredId || "").trim();
    const code = normalizeReferralCode(body?.code);

    if (!isValidSteamId64(referredId)) {
      return res.status(400).json({ ok: false, reason: "invalid_steamid64" });
    }
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      return res.status(400).json({ ok: false, reason: "invalid_code" });
    }

    const db = await dbPromise;
    const referral = await db.get(
      "SELECT id, status FROM referrals WHERE referredId = ? AND code = ?",
      referredId,
      code
    );
    if (!referral) {
      return res.status(404).json({ ok: false, reason: "not_found" });
    }
    if (referral.status !== "pending") {
      return res.status(409).json({
        ok: false,
        reason: "not_pending",
        status: referral.status
      });
    }

    await db.run(
      "UPDATE referrals SET status = ?, confirmedAt = ? WHERE id = ?",
      "confirmed",
      new Date().toISOString(),
      referral.id
    );

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.warn("Referral confirm error:", err?.message || err);
    return res.status(500).json({ ok: false, reason: "server_error" });
  }
});
app.post("/api/referrals/verify", async (req, res) => {
  if (!isReferralAuthorized(req)) {
    return res.status(401).json({ ok: false, reason: "unauthorized" });
  }

  try {
    const body = coerceBody(req);
    const referredId = String(body?.referredId || "").trim();
    const totalPlaySeconds = Number(body?.totalPlaySeconds);

    if (!isValidSteamId64(referredId)) {
      return res.status(400).json({ ok: false, reason: "invalid_steamid64" });
    }
    if (!Number.isFinite(totalPlaySeconds) || totalPlaySeconds < 0) {
      return res.status(400).json({ ok: false, reason: "invalid_playtime" });
    }

    const db = await dbPromise;
    const referral = await db.get(
      "SELECT * FROM referrals WHERE referredId = ?",
      referredId
    );
    if (!referral) {
      return res.status(404).json({ ok: false, reason: "not_found" });
    }

    let status = referral.status;
    if (
      totalPlaySeconds >= REFERRAL_VERIFY_THRESHOLD_SECONDS &&
      referral.status !== "verified"
    ) {
      await db.run(
        `UPDATE referrals
         SET status = ?, verifiedAt = ?, playSecondsAtVerify = ?
         WHERE id = ?`,
        "verified",
        new Date().toISOString(),
        Math.floor(totalPlaySeconds),
        referral.id
      );
      status = "verified";
    }

    const countRow = await db.get(
      "SELECT COUNT(*) AS count FROM referrals WHERE referrerId = ? AND status = 'verified'",
      referral.referrerId
    );
    const verifiedCount = Number(countRow?.count || 0);
    const meta = await db.get(
      "SELECT eligibleAt, paidAt FROM referrer_meta WHERE referrerId = ?",
      referral.referrerId
    );
    const existingEligibleAt = meta?.eligibleAt || null;
    const nextEligibleAt =
      verifiedCount >= REFERRAL_REQUIRED_VERIFIED && !existingEligibleAt
        ? new Date().toISOString()
        : existingEligibleAt;
    const paidAt = meta?.paidAt || null;

    await db.run(
      `INSERT INTO referrer_meta (referrerId, verifiedCount, eligibleAt, paidAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(referrerId) DO UPDATE SET
         verifiedCount = excluded.verifiedCount,
         eligibleAt = COALESCE(referrer_meta.eligibleAt, excluded.eligibleAt),
         paidAt = referrer_meta.paidAt`,
      referral.referrerId,
      verifiedCount,
      nextEligibleAt,
      paidAt
    );

    return res.status(200).json({
      ok: true,
      status,
      verifiedCount,
      eligible: Boolean(nextEligibleAt)
    });
  } catch (err) {
    console.warn("Referral verify error:", err?.message || err);
    return res.status(500).json({ ok: false, reason: "server_error" });
  }
});
app.get("/api/referrals/status", async (req, res) => {
  try {
    const steamid64 = pickFirst(req.query, ["steamid64"]);
    if (!isValidSteamId64(steamid64)) {
      return res.status(400).json({ ok: false, reason: "invalid_steamid64" });
    }

    const db = await dbPromise;
    const referrerRows = await db.all(
      `SELECT referrerId, referredId, code, status, confirmedAt, verifiedAt, playSecondsAtVerify, createdAt
       FROM referrals WHERE referrerId = ?
       ORDER BY createdAt DESC`,
      steamid64
    );
    let role = "";
    let referrals = [];
    let referrerId = "";

    if (referrerRows.length > 0) {
      role = "referrer";
      referrals = referrerRows;
      referrerId = steamid64;
    } else {
      const referredRow = await db.get(
        `SELECT referrerId, referredId, code, status, confirmedAt, verifiedAt, playSecondsAtVerify, createdAt
         FROM referrals WHERE referredId = ?`,
        steamid64
      );
      if (!referredRow) {
        return res.status(404).json({ ok: false, reason: "not_found" });
      }
      role = "referred";
      referrals = [referredRow];
      referrerId = referredRow.referrerId;
    }

    const countRow = await db.get(
      "SELECT COUNT(*) AS count FROM referrals WHERE referrerId = ? AND status = 'verified'",
      referrerId
    );
    const verifiedCount = Number(countRow?.count || 0);
    const meta = await db.get(
      "SELECT eligibleAt, paidAt FROM referrer_meta WHERE referrerId = ?",
      referrerId
    );

    return res.status(200).json({
      ok: true,
      role,
      verifiedCount,
      required: REFERRAL_REQUIRED_VERIFIED,
      eligible: Boolean(meta?.eligibleAt),
      eligibleAt: meta?.eligibleAt || null,
      paidAt: meta?.paidAt || null,
      referrals
    });
  } catch (err) {
    console.warn("Referral status error:", err?.message || err);
    return res.status(500).json({ ok: false, reason: "server_error" });
  }
});
app.get("/debug/test-discord", async (req, res) => {
  const token = pickFirst(req.query, ["token"]);
  if (!TRAZNILA_NOTIFY_SECRET || token !== TRAZNILA_NOTIFY_SECRET) {
    return res.status(401).json({ ok: false, reason: "unauthorized" });
  }

  logDiscordWebhookConfigured();
  await discordNotify({
    content: "🧪 Discord webhook test message (LoveRust Pay Bridge).",
    txnId: "test",
    steamid64: "test",
    product: "test",
    amount: "test"
  });

  return res.status(200).json({ ok: true, sent: hasDiscordWebhook });
});

app.post("/tranzila/notify", async (req, res) => {
  console.log("=== TRANZILA NOTIFY HIT ===");
  console.log("Content-Type:", req.headers["content-type"] || "(none)");
  console.log("Query keys:", Object.keys(req.query || {}));
  logDiscordWebhookConfigured();
  try {
    const normalized = normalizeNotifyFields(req);
    const {
      body,
      steamid64,
      custom2,
      pdesc,
      product,
      plan,
      amount,
      status,
      responseCode,
      txnId,
      txnIdSource
    } = normalized;
    const logTxnId = isSensitiveLogKey(txnIdSource) ? "(redacted)" : truncateLog(txnId);
    const rawCustom2 = (body?.custom2 ?? custom2 ?? "").toString().trim();
    const rawPdesc = (body?.pdesc ?? pdesc ?? "").toString().trim();
    const rawProduct = (body?.product ?? product ?? "").toString().trim();
    const rawPlan = (body?.plan ?? plan ?? "").toString().trim();
    const resolvedSku = resolveCanonicalSku({
      custom2: rawCustom2 || custom2,
      pdesc: rawPdesc || pdesc,
      product: rawProduct || product,
      plan: rawPlan || plan
    });
    const skuCandidate =
      pickFirst(
        {
          resolvedSku,
          custom2: rawCustom2 || custom2,
          pdesc: rawPdesc || pdesc,
          product: rawProduct || product,
          plan: rawPlan || plan
        },
        ["resolvedSku", "custom2", "pdesc", "product", "plan"]
      ) || "";
    const parsedGrant = parseSkuToGrant(skuCandidate);
    let grant = parsedGrant.result;
    let effectiveSku = grant?.effectiveSku || resolvedSku;
    const amountValue = normalizeAmount(amount);
    const rainbowCandidateValues = [grant?.kind, resolvedSku, skuCandidate].filter(Boolean);
    const isRainbowCandidate = rainbowCandidateValues.some((value) =>
      String(value).toLowerCase().includes("rainbow")
    );
    const forceRainbow30d = amountValue === 0.01 && isRainbowCandidate;
    if (forceRainbow30d) {
      grant = {
        kind: "rainbow",
        duration: "30d",
        effectiveSku: "rainbow_30d"
      };
      effectiveSku = "rainbow_30d";
    }
    const normalizedProduct = grant?.kind || "";
    const normalizedDuration = grant?.duration || "";
    if (grant) {
      normalized.product = grant.kind;
      normalized.duration = grant.duration;
    }

    console.log("Body keys:", Object.keys(body || {}));

    console.log(
      "Notify summary:",
      `steamid64=${truncateLog(steamid64) || "(empty)"}`,
      `product=${truncateLog(product) || "(empty)"}`,
      `status=${truncateLog(status) || "(empty)"}`,
      `txn_id=${logTxnId || "(empty)"}`
    );
    console.log(
      "Notify SKU sources:",
      `custom2="${truncateLog(rawCustom2)}"`,
      `pdesc="${truncateLog(rawPdesc)}"`
    );
    console.log("Notify normalized:", {
      steamid64: truncateLog(steamid64),
      product: truncateLog(product),
      resolvedSku: truncateLog(resolvedSku),
      effectiveSku: truncateLog(effectiveSku),
      kind: truncateLog(normalizedProduct),
      duration: truncateLog(normalizedDuration),
      status: truncateLog(status),
      txnId: logTxnId,
      amount: truncateLog(amount),
      responseCode: truncateLog(responseCode)
    });

    // Security: shared secret (optional)
    if (TRAZNILA_NOTIFY_SECRET) {
      const authHeader = pickFirst(req.headers, ["authorization"]);
      const bearerToken = authHeader?.toLowerCase().startsWith("bearer ")
        ? authHeader.slice(7).trim()
        : "";
      const secret =
        pickFirst(req.headers, ["x-tranzila-secret", "x-notify-token"]) ||
        bearerToken ||
        pickFirst(body, ["token", "secret", "api_secret"]) ||
        pickFirst(req.query, ["token"]);
      if (!secret || secret !== TRAZNILA_NOTIFY_SECRET) {
        return res.status(401).json({ ok: false, reason: "unauthorized" });
      }
    }

    if (!/^\d{17}$/.test(steamid64)) {
      return res.status(400).json({ ok: false, reason: "invalid_steamid64" });
    }

    const isSuccess = isApprovedStatus(status, responseCode);

    if (!isSuccess) {
      console.warn("Notify rejected: not approved", {
        steamid64,
        status,
        responseCode,
        txnId
      });
      return res.status(400).json({ ok: false, reason: "not_approved" });
    }

    if (!txnId) {
      console.warn("Notify rejected: missing txId", {
        steamid64,
        product,
        status,
        responseCode
      });
      return res.status(400).json({ ok: false, reason: "missing_txId" });
    }

    if (isDuplicateWindow(txnId)) {
      console.warn("Duplicate notify ignored: inflight", logTxnId);
      return res.status(200).json({
        ok: true,
        txId: txnId,
        steamid64,
        product: resolvedSku || product,
        actions: [],
        deduped: true
      });
    }

    if (hasProcessedTx(txnId)) {
      console.log(`Duplicate txnId ignored: ${logTxnId}`);
      return res.status(200).json({
        ok: true,
        txId: txnId,
        steamid64,
        product: resolvedSku || product,
        actions: [],
        deduped: true
      });
    }

    if (!grant && !resolvedSku) {
      console.warn(
        `[SKU] Unrecognized sku="${truncateLog(skuCandidate)}" sources: custom2="${truncateLog(rawCustom2)}" pdesc="${truncateLog(rawPdesc)}" reason=${parsedGrant.reason || "unknown"}`
      );
      return res.status(200).json({
        ok: true,
        granted: false,
        sku: skuCandidate || "",
        kind: null,
        duration: null,
        reason: "unknown_product"
      });
    }

    const { commands } = resolveRconCommands({
      effectiveSku,
      steamid64,
      grant
    });
    if (!commands.length) {
      console.warn("Notify rejected: unknown product", {
        steamid64,
        product,
        resolvedSku,
        effectiveSku,
        txnId: logTxnId
      });
      return res.status(200).json({
        ok: true,
        granted: false,
        sku: skuCandidate || effectiveSku || "",
        kind: grant?.kind || null,
        duration: grant?.duration || null,
        reason: "unknown_product"
      });
    }

    if (!isRconConfigured) {
      return res.status(502).json({ ok: false, reason: "rcon_not_configured" });
    }
    try {
      if (isIdempotentSource(req)) {
        markRecentTxId(txnId, "inflight");
      }
      const actions = [];
      console.log("Notify grant plan:", {
        resolvedSku,
        effectiveSku,
        rconCommands: commands,
        responseCode: truncateLog(responseCode)
      });
      const grantLogParts = [
        `steamid=${steamid64}`,
        `sku=${truncateLog(skuCandidate)}`,
        `kind=${grant?.kind || normalizedProduct || "unknown"}`,
        `duration=${grant?.duration || normalizedDuration || "unknown"}`,
        `cmd1=${commands[0] || ""}`
      ];
      if (commands[1]) {
        grantLogParts.push(`cmd2=${commands[1]}`);
      }
      console.log(`[GRANT] ${grantLogParts.join(" ")}`);
      for (const [index, command] of commands.entries()) {
        if (index > 0) {
          await delay(300);
        }
        console.log(`resolvedSku=${resolvedSku} command=${command}`);
        try {
          const timeoutMs = index === 0 ? 4000 : 10000;
          const result = await rconSend(command, { timeoutMs });
          console.log("RCON result:", result);
          actions.push({ command, result });
        } catch (err) {
          const errorMessage = err?.message || err;
          actions.push({ command, ok: false, error: errorMessage });
          if (index === 0) {
            throw err;
          }
          console.warn("RCON non-critical command failed:", errorMessage);
        }
      }
      console.log("RCON commands executed", {
        count: commands.length,
        steamid64: truncateLog(steamid64),
        txnId: logTxnId
      });

      await recordEntitlements({
        steamid64,
        effectiveSku,
        txnId,
        amount,
        grantedAt: new Date()
      });

      markProcessedTx(txnId);
      await discordNotify({
        content: `✅ Grant applied\nSteamID: ${steamid64}\nProduct: ${effectiveSku}\nAmount: ${amount || "(unknown)"}\nTxn: ${txnId}`,
        txnId,
        steamid64,
        product: effectiveSku,
        amount
      });

      return res.status(200).json({
        ok: true,
        granted: true,
        txId: txnId,
        steamid64,
        product: effectiveSku,
        kind: grant?.kind || normalizedProduct || null,
        duration: grant?.duration || normalizedDuration || null,
        sku: skuCandidate || effectiveSku || "",
        actions
      });
    } catch (err) {
      console.warn("Notify rejected: rcon_failed", err?.message || err);
      if (isIdempotentSource(req)) {
        recentTxIds.delete(txnId);
      }
      return res.status(502).json({ ok: false, reason: "rcon_failed" });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, reason: "server_error" });
  }
});

app.post("/tranzila/result", async (req, res) => {
  try {
    const body = coerceBody(req);

    const secret = pickFirst(body, ["secret", "api_secret", "token"]);
    if (secret !== API_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const steamid64 = pickFirst(body, ["steamid64", "steam_id", "steamid", "userid"]);
    const sku = pickFirst(body, ["sku"]);

    if (!/^\d{17}$/.test(steamid64)) {
      return res.status(400).json({ ok: false, error: "invalid_steamid64" });
    }

    if (!sku) {
      return res.status(400).json({ ok: false, error: "missing_sku" });
    }

    const mapped = SKU_MAP[sku];
    if (!mapped || mapped.skipGrant) {
      return res.status(400).json({ ok: false, error: "invalid_sku" });
    }

    try {
      const rconGrantCommands = (mapped.rconGrant || []).map((command) =>
        command.replace("{steamid64}", steamid64)
      );
      for (const command of rconGrantCommands) {
        await rconSend(command);
      }
    } catch (err) {
      console.error("RCON failed:", err);
      return res.status(502).json({ ok: false, error: "rcon_failed" });
    }

    return res.status(200).json({ ok: true, granted: true, sku, steamid64 });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.listen(resolvedPort, "0.0.0.0", () => {
  console.log(`LoveRustPayBridge listening on :${resolvedPort}`);
});

async function processExpiredEntitlements() {
  const db = await dbPromise;
  const now = new Date().toISOString();
  const rows = await db.all(
    "SELECT id, steamid64, sku, txnId, revokeCommand FROM entitlements WHERE expiresAt IS NOT NULL AND revokedAt IS NULL AND expiresAt <= ?",
    now
  );

  if (!rows.length) return;

  for (const row of rows) {
    if (!isRconConfigured) {
      console.warn(
        `Cannot revoke entitlement (RCON not configured). entitlementId=${row.id} sku=${row.sku}`
      );
      continue;
    }
    try {
      console.log(`RCON revoke command: ${row.revokeCommand}`);
      await rconSend(row.revokeCommand);
      await db.run("UPDATE entitlements SET revokedAt = ? WHERE id = ?", new Date().toISOString(), row.id);
      await discordNotify({
        content: `🕒 Entitlement revoked\nSteamID: ${row.steamid64}\nSKU: ${row.sku}\nTxn: ${row.txnId}`,
        txnId: row.txnId,
        steamid64: row.steamid64,
        product: row.sku
      });
    } catch (err) {
      console.warn(
        `Failed to revoke entitlement ${row.id}:`,
        err?.message || err
      );
    }
  }
}

setInterval(() => {
  processExpiredEntitlements().catch((err) => {
    console.error("Failed to process expired entitlements:", err);
  });
  processExpiredPortalCodes().catch((err) => {
    console.error("Failed to process expired portal codes:", err);
  });
}, 60 * 1000);

async function processExpiredPortalCodes() {
  const db = await dbPromise;
  await cleanupExpiredPortalCodes(db);
}
