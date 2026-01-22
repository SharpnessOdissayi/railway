import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import WebSocket from "ws";

console.log("BOOT: LoveRustPayBridge v2026-01-22-RCON-OPTIONAL");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

const {
  PORT = 8080,

  // Security
  API_SECRET, // required

  // RCON
  RCON_HOST,
  RCON_PORT,
  RCON_PASSWORD,

  // Discord
  DISCORD_WEBHOOK_URL, // recommended

  // Behavior
  DRY_RUN = "false"
} = process.env;

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

// Map products you send from Tranzila notify
const PRODUCT_MAP = {
  vip_30:      { action: "vip",     duration: "30d", priceLabel: "$19.90" },
  "vip-monthly": { action: "vip",     duration: "30d", priceLabel: "$19.90" },
  vip_monthly: { action: "vip",     duration: "30d", priceLabel: "$19.90" },
  vipmonthly:  { action: "vip",     duration: "30d", priceLabel: "$19.90" },
  rainbow_30:  { action: "rainbow", duration: "30d", priceLabel: "$9.90" },
  coffee:      { action: "coffee",  duration: "perm", priceLabel: "$5.00" }
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

async function discordNotify(content) {
  if (!DISCORD_WEBHOOK_URL) return;

  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn("Discord webhook failed:", res.status, text);
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

function normalizeNotifyFields(req) {
  const sources = [req.body || {}, req.query || {}];
  const steamid64 = pickFirstFromSources(sources, [
    "steamid64",
    "steam_id",
    "steamid",
    "userid",
    "contact",
    "customer_id"
  ]);
  const product = pickFirstFromSources(sources, [
    "product",
    "product_id",
    "item",
    "plan",
    "description",
    "product_description"
  ]);
  const status = pickFirstFromSources(sources, [
    "status",
    "payment_status",
    "result",
    "resp",
    "response",
    "response_code"
  ]);
  const txnId = pickFirstFromSources(sources, [
    "txn_id",
    "transaction_id",
    "order_id",
    "index",
    "confirmation_code"
  ]);
  const amount = pickFirstFromSources(sources, ["amount", "sum", "price", "total"]);
  const responseCode = pickFirstFromSources(sources, [
    "response_code",
    "resp_code",
    "responseCode"
  ]);

  return {
    steamid64,
    product,
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
  console.log("Body keys:", Object.keys(req.body || {}));
  try {
    const body = req.body || {};

    // Security: shared secret
    const secret =
      pickFirst(req.headers, ["x-api-key"]) ||
      pickFirst(body, ["secret", "api_secret", "token"]) ||
      pickFirst(req.query, ["secret", "api_secret", "token"]);
    if (secret !== API_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const normalized = normalizeNotifyFields(req);
    const {
      steamid64,
      product,
      status,
      txnId,
      amount,
      responseCode
    } = normalized;

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
      status: truncateLog(status),
      txnId: truncateLog(txnId),
      amount: truncateLog(amount)
    });

    if (!steamid64) return res.status(400).json({ ok: false, error: "missing steamid64" });

    // flexible success detection
    const s = (status || "").toLowerCase();
    const isSuccess =
      ["success", "approved", "ok", "true"].includes(s) ||
      ["000", "0"].includes(String(responseCode || "").toLowerCase());

    if (!isSuccess) {
      await discordNotify(
        `❌ Payment not successful\nSteamID: ${steamid64}\nStatus: ${status || "(empty)"}\nProduct: ${product || "(unknown)"}\nTxn: ${txnId || "(none)"}`
      );
      return res.status(200).json({ ok: true, ignored: true });
    }

    const mapped = PRODUCT_MAP[product];
    if (!mapped) {
      await discordNotify(
        `⚠️ Payment received but product is unknown\nSteamID: ${steamid64}\nProduct: ${product || "(empty)"}\nTxn: ${txnId || "(none)"}\nAction: NOT GRANTED`
      );
      return res.status(200).json({ ok: true, unknown_product: true });
    }

    let rconCommand = "";
    let humanProduct = product;

    if (mapped.action === "vip") {
      rconCommand = `loverustvip.grant ${steamid64} ${mapped.duration}`;
      humanProduct = `VIP (${mapped.duration})`;
    } else if (mapped.action === "rainbow") {
      // simplest: grant VIP and tell user to use /cc rainbow
      rconCommand = `loverustvip.grant ${steamid64} ${mapped.duration}`;
      humanProduct = `Rainbow Name (${mapped.duration})`;
    } else if (mapped.action === "coffee") {
      // donation only
      rconCommand = "";
      humanProduct = `Coffee (Donation)`;
    }

    let rconResult = null;
    if (rconCommand) {
      if (!isRconConfigured) {
        await discordNotify(
          `⚠️ Payment received but RCON is not configured\nSteamID: ${steamid64}\nProduct: ${humanProduct}\nTxn: ${txnId || "(none)"}\nAction: NOT GRANTED`
        );
        return res.status(200).json({ ok: true, granted: false, error: "rcon_not_configured" });
      }
      try {
        rconResult = await rconSend(rconCommand);
      } catch (err) {
        await discordNotify(
          `❌ RCON failed\nSteamID: ${steamid64}\nProduct: ${humanProduct}\nTxn: ${txnId || "(none)"}\nError: ${err?.message || "unknown"}`
        );
        return res.status(502).json({ ok: false, error: "rcon_failed" });
      }
    }

    let msg =
      `✅ **New Purchase**\n` +
      `**Player (SteamID64):** ${steamid64}\n` +
      `**Product:** ${humanProduct}\n` +
      (mapped.priceLabel ? `**Price:** ${mapped.priceLabel}\n` : "") +
      (txnId ? `**Txn:** ${txnId}\n` : "") +
      (rconCommand ? `**RCON:** \`${rconCommand}\`` : `**RCON:** (none)`);

    if (mapped.action === "rainbow") msg += `\n**Note:** Player can use \`/cc rainbow\` in-game.`;

    await discordNotify(msg);

    return res.status(200).json({
      ok: true,
      granted: !!rconCommand,
      product,
      rcon: !!rconResult
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/tranzila/result", async (req, res) => {
  try {
    const body = req.body || {};

    const secret = pickFirst(body, ["secret", "api_secret", "token"]);
    if (secret !== API_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const steamid64 = pickFirst(body, ["steamid64", "steam_id", "steamid", "userid"]);
    const product = pickFirst(body, ["product", "product_id", "item", "plan"]);

    if (!/^\d{17}$/.test(steamid64)) {
      return res.status(400).json({ ok: false, error: "invalid_steamid64" });
    }

    const productDaysMap = {
      vip_7: 7,
      vip_14: 14,
      vip_30: 30
    };

    const days = productDaysMap[product];
    if (!days) {
      return res.status(400).json({ ok: false, error: "invalid_product" });
    }

    try {
      await rconSend(`loverustvip.grant ${steamid64} ${days}`);
    } catch (err) {
      console.error("RCON failed:", err);
      return res.status(502).json({ ok: false, error: "rcon_failed" });
    }

    return res.status(200).json({ ok: true, granted: true, product, steamid64, days });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.listen(Number(PORT), () => {
  console.log(`LoveRustPayBridge listening on :${PORT}`);
});
