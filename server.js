import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
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

  // Discord
  DISCORD_WEBHOOK_URL, // recommended

  // Behavior
  DRY_RUN = "false",
  PORT
} = process.env;

const resolvedPort = PORT || 8080;

function required(name, value) {
  if (!value) throw new Error(`Missing required env var: ${name}`);
}

required("API_SECRET", API_SECRET);
const isDryRun = DRY_RUN.toLowerCase() === "true";
const isRconConfigured = !!(RCON_HOST && RCON_PORT && RCON_PASSWORD);
const hasDiscordWebhook = !!DISCORD_WEBHOOK_URL;

if (!isRconConfigured) {
  console.warn(
    "RCON is not fully configured (RCON_HOST/RCON_PORT/RCON_PASSWORD missing). VIP grants will fail until fixed."
  );
}
if (!hasDiscordWebhook) {
  console.warn(
    "Discord webhook is not configured (DISCORD_WEBHOOK_URL missing). Notifications will be skipped."
  );
}

const DATABASE_PATH = DB_PATH || "./data.sqlite";

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
async function rconSend(command) {
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
    }, 8000);

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

async function discordNotify(content) {
  if (!DISCORD_WEBHOOK_URL) return;

  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn("Discord webhook failed:", res.status, text);
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
    "steam_id",
    "steamid",
    "userid",
    "contact",
    "customer_id"
  ]);
  const status = pickFirstFromSources(sources, [
    "status",
    "payment_status",
    "result",
    "resp",
    "response",
    "response_code"
  ]);
  const txnId = pickFirstFromSources(sources, ["txnId", "orderid", "requestId"]);
  const amount = pickFirstFromSources(sources, ["amount", "sum", "price", "total"]);
  const responseCode = pickFirstFromSources(sources, ["responseCode", "response_code", "resp_code"]);
  const sku = pickFirstFromSources(sources, ["sku"]);

  return {
    body,
    steamid64,
    sku,
    status,
    txnId,
    amount,
    responseCode
  };
}

app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

app.post("/tranzila/notify", async (req, res) => {
  console.log("=== TRANZILA NOTIFY HIT ===");
  console.log("Content-Type:", req.headers["content-type"] || "(none)");
  console.log("Query keys:", Object.keys(req.query || {}));
  try {
    const normalized = normalizeNotifyFields(req);
    const {
      body,
      steamid64,
      sku,
      status,
      txnId,
      amount,
      responseCode
    } = normalized;

    console.log("Body keys:", Object.keys(body || {}));

    console.log(
      "Notify summary:",
      `steamid64=${truncateLog(steamid64) || "(empty)"}`,
      `sku=${truncateLog(sku) || "(empty)"}`,
      `status=${truncateLog(status) || "(empty)"}`,
      `txn_id=${truncateLog(txnId) || "(empty)"}`
    );
    console.log("Notify normalized:", {
      steamid64: truncateLog(steamid64),
      sku: truncateLog(sku),
      status: truncateLog(status),
      txnId: truncateLog(txnId),
      amount: truncateLog(amount),
      responseCode: truncateLog(responseCode)
    });

    // Security: shared secret
    const secret =
      pickFirst(req.headers, ["x-api-key"]) ||
      pickFirst(body, ["secret", "api_secret", "token"]) ||
      pickFirst(req.query, ["secret", "api_secret", "token"]);
    if (secret !== API_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    if (!steamid64) return res.status(400).json({ ok: false, error: "missing steamid64" });

    const statusNormalized = String(status || "").toLowerCase();
    const isSuccess =
      statusNormalized === "approved" && String(responseCode || "").toLowerCase() === "000";

    if (!isSuccess) {
      await discordNotify(
        `❌ Payment not successful\nSteamID: ${steamid64}\nStatus: ${status || "(empty)"}\nResponseCode: ${responseCode || "(empty)"}\nSKU: ${sku || "(empty)"}\nTxn: ${txnId || "(none)"}`
      );
      return res.status(200).json({ ok: true, ignored: true });
    }

    if (!txnId) {
      await discordNotify(
        `❌ Payment missing txnId - not granting\nSteamID: ${steamid64}\nSKU: ${sku || "(empty)"}\nStatus: ${status || "(empty)"}\nResponseCode: ${responseCode || "(empty)"}`
      );
      return res.status(400).json({ ok: false, error: "missing_txnId" });
    }

    const db = await dbPromise;
    const existingTxn = await db.get("SELECT txnId FROM transactions WHERE txnId = ?", txnId);
    if (existingTxn) {
      console.log(`Duplicate txnId ignored: ${txnId}`);
      return res.status(200).json({ ok: true, duplicate: true, message: "duplicate ignored" });
    }

    const mapped = SKU_MAP[sku];
    if (!mapped) {
      await discordNotify(
        `⚠️ Payment received but SKU is unknown\nSteamID: ${steamid64}\nSKU: ${sku || "(empty)"}\nTxn: ${txnId || "(none)"}\nAction: NOT GRANTED`
      );
      await db.run(
        "INSERT INTO transactions (txnId, steamid64, sku, status, amount, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
        txnId,
        steamid64,
        sku || "unknown",
        "unknown_sku",
        amount || null,
        new Date().toISOString()
      );
      return res.status(200).json({ ok: true, unknown_product: true });
    }

    const rconGrantCommands = (mapped.rconGrant || []).map((command) =>
      command.replace("{steamid64}", steamid64)
    );
    const rconRevokeCommands = (mapped.rconRevoke || []).map((command) =>
      command.replace("{steamid64}", steamid64)
    );

    if (mapped.skipGrant) {
      await db.run(
        "INSERT INTO transactions (txnId, steamid64, sku, status, amount, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
        txnId,
        steamid64,
        sku,
        "no_grant",
        amount || null,
        new Date().toISOString()
      );

      await discordNotify(
        `ℹ️ Payment received (no grant)\nSteamID: ${steamid64}\nSKU: ${sku}\nTxn: ${txnId}\nResult: NO_GRANT`
      );

      return res.status(200).json({ ok: true, granted: false, sku, no_grant: true });
    }

    let rconResult = null;
    if (!isRconConfigured) {
      await discordNotify(
        `⚠️ Payment received but RCON is not configured\nSteamID: ${steamid64}\nSKU: ${sku}\nTxn: ${txnId}\nAction: NOT GRANTED`
      );
      return res.status(200).json({ ok: true, granted: false, error: "rcon_not_configured" });
    }
    try {
      for (const command of rconGrantCommands) {
        console.log(`RCON grant command: ${command}`);
        rconResult = await rconSend(command);
      }
    } catch (err) {
      await discordNotify(
        `❌ RCON failed\nSteamID: ${steamid64}\nSKU: ${sku}\nTxn: ${txnId}\nError: ${err?.message || "unknown"}`
      );
      return res.status(502).json({ ok: false, error: "rcon_failed" });
    }

    await db.run(
      "INSERT INTO transactions (txnId, steamid64, sku, status, amount, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
      txnId,
      steamid64,
      sku,
      "granted",
      amount || null,
      new Date().toISOString()
    );

    if (mapped.durationSeconds > 0 && rconRevokeCommands.length > 0) {
      const grantedAt = new Date();
      const expiresAt = new Date(grantedAt.getTime() + mapped.durationSeconds * 1000);
      for (const revokeCommand of rconRevokeCommands) {
        await db.run(
          `INSERT INTO entitlements (steamid64, sku, txnId, grantedAt, expiresAt, revokeCommand)
           VALUES (?, ?, ?, ?, ?, ?)`,
          steamid64,
          sku,
          txnId,
          grantedAt.toISOString(),
          expiresAt.toISOString(),
          revokeCommand
        );
      }
    }

    let msg =
      `✅ **Purchase Fulfilled**\n` +
      `**Player (SteamID64):** ${steamid64}\n` +
      `**SKU:** ${sku}\n` +
      (txnId ? `**Txn:** ${txnId}\n` : "") +
      (amount ? `**Amount:** ${amount}\n` : "") +
      `**Result:** GRANTED\n` +
      `**RCON:** ${rconGrantCommands.length ? rconGrantCommands.map((command) => `\`${command}\``).join(", ") : "(none)"}`;

    await discordNotify(msg);

    return res.status(200).json({
      ok: true,
      granted: true,
      sku,
      rcon: !!rconResult
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "server_error" });
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
      await discordNotify(
        `🕒 Entitlement revoked\nSteamID: ${row.steamid64}\nSKU: ${row.sku}\nTxn: ${row.txnId}`
      );
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
