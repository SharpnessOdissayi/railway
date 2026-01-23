import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import fs from "node:fs/promises";
import path from "node:path";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import WebSocket from "ws";

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
  PORT
} = process.env;

const resolvedPort = PORT || 8080;

function required(name, value) {
  if (!value) throw new Error(`Missing required env var: ${name}`);
}

required("API_SECRET", API_SECRET);
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
const PROCESSED_TX_PATH = path.resolve("./data/processed.json");

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
  vip_test_10m: {
    type: "permissions",
    rconGrant: [
      "oxide.grant user {steamid64} loverustvip.use",
      "oxide.grant user {steamid64} vipwall.use"
    ],
    rconRevoke: [
      "oxide.revoke user {steamid64} loverustvip.use",
      "oxide.revoke user {steamid64} vipwall.use"
    ],
    durationSeconds: 600
  },
  rainbow_30d: {
    type: "permissions",
    rconGrant: ["oxide.grant user {steamid64} loverustvip.rainbow"],
    rconRevoke: ["oxide.revoke user {steamid64} loverustvip.rainbow"],
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

  return db;
}

const dbPromise = initDb().catch((err) => {
  console.error("Failed to initialize database:", err);
  process.exit(1);
});

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

function pickFirstFromSources(sources, keys) {
  for (const source of sources) {
    const value = pickFirst(source, keys);
    if (value) return value;
  }
  return "";
}

function truncateLog(value, maxLength = 80) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
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
  const product = pickFirstFromSources(sources, [
    "product",
    "sku",
    "pdesc",
    "plan",
    "description"
  ]);
  const amount = pickFirstFromSources(sources, ["sum", "amount", "total"]);
  const status = pickFirstFromSources(sources, ["status", "Response", "response"]);
  const responseCode = pickFirstFromSources(sources, ["Response", "response"]);
  const txnId = pickFirstFromSources(sources, [
    "tx",
    "txnId",
    "transaction_id",
    "tranId",
    "transId",
    "ConfirmationCode",
    "index",
    "orderid",
    "orderId",
    "id",
    "Tempref"
  ]);

  return {
    body,
    steamid64,
    product,
    amount,
    status,
    responseCode,
    txnId
  };
}

function normalizeProduct(product) {
  if (!product) return "";
  return String(product).trim().toLowerCase().replace(/-/g, "_");
}

function isApprovedStatus(status, responseCode) {
  const values = [status, responseCode].filter(Boolean).map((value) => String(value).trim().toLowerCase());
  if (!values.length) return false;
  return values.some((value) => {
    if (["approved", "ok", "success"].includes(value)) return true;
    return /^0+$/.test(value);
  });
}

const RCON_PRODUCT_MAP = {
  test_vip: ["loverustvip.grant {steamid64} 10m"],
  vip_30: ["loverustvip.grant {steamid64} 30d"],
  rainbow_30: [
    "loverustvip.grant {steamid64} 30d",
    "oxide.grant user {steamid64} vip.rainbow"
  ]
};

async function loadProcessedTxIds() {
  try {
    const content = await fs.readFile(PROCESSED_TX_PATH, "utf8");
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return new Set(parsed.map((value) => String(value)));
    }
    return new Set();
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn("Failed to read processed tx file:", err?.message || err);
    }
    return new Set();
  }
}

async function persistProcessedTxIds(txIds) {
  await fs.mkdir(path.dirname(PROCESSED_TX_PATH), { recursive: true });
  const payload = JSON.stringify([...txIds], null, 2);
  await fs.writeFile(PROCESSED_TX_PATH, payload, "utf8");
}

const processedTxIdsPromise = loadProcessedTxIds();

app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
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
      product,
      amount,
      status,
      responseCode,
      txnId
    } = normalized;
    const normalizedProduct = normalizeProduct(product);

    console.log("Body keys:", Object.keys(body || {}));

    console.log(
      "Notify summary:",
      `steamid64=${truncateLog(steamid64) || "(empty)"}`,
      `product=${truncateLog(product) || "(empty)"}`,
      `status=${truncateLog(status) || "(empty)"}`,
      `txn_id=${truncateLog(txnId) || "(empty)"}`
    );
    console.log("Notify normalized:", {
      steamid64: truncateLog(steamid64),
      product: truncateLog(product),
      normalizedProduct: truncateLog(normalizedProduct),
      status: truncateLog(status),
      txnId: truncateLog(txnId),
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

    const processedTxIds = await processedTxIdsPromise;
    if (processedTxIds.has(txnId)) {
      console.log(`Duplicate txnId ignored: ${txnId}`);
      return res.status(200).json({
        ok: true,
        txId: txnId,
        steamid64,
        product: normalizedProduct || product,
        actions: [],
        duplicate: true
      });
    }

    if (!normalizedProduct) {
      return res.status(400).json({ ok: false, reason: "missing_product" });
    }

    const commands = RCON_PRODUCT_MAP[normalizedProduct] || [];
    if (!commands.length) {
      console.warn("Notify rejected: unknown product", {
        steamid64,
        product,
        normalizedProduct,
        txnId
      });
      return res.status(400).json({ ok: false, reason: "unknown_product" });
    }

    if (!isRconConfigured) {
      return res.status(502).json({ ok: false, reason: "rcon_not_configured" });
    }
    try {
      const actions = [];
      for (const command of commands) {
        const resolvedCommand = command.replace("{steamid64}", steamid64);
        console.log(`RCON command: ${resolvedCommand}`);
        const result = await rconSend(resolvedCommand, { timeoutMs: 4000 });
        console.log("RCON result:", result);
        actions.push({ command: resolvedCommand, result });
      }

      processedTxIds.add(txnId);
      await persistProcessedTxIds(processedTxIds);
      await discordNotify({
        content: `✅ VIP granted\nSteamID: ${steamid64}\nProduct: ${normalizedProduct}\nAmount: ${amount || "(unknown)"}\nTxn: ${txnId}`,
        txnId,
        steamid64,
        product: normalizedProduct,
        amount
      });

      return res.status(200).json({
        ok: true,
        txId: txnId,
        steamid64,
        product: normalizedProduct,
        actions
      });
    } catch (err) {
      console.warn("Notify rejected: rcon_failed", err?.message || err);
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
}, 60 * 1000);
