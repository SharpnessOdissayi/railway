import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
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

const SKU_ACTIONS = {
  vip_30d: {
    label: "VIP (30d)",
    commands: [
      "oxide.grant user {steamid64} loverustvip.use",
      "oxide.grant user {steamid64} vipwall.use"
    ]
  },
  vip_test_10m: {
    label: "VIP (10m test)",
    commands: [
      "oxide.grant user {steamid64} loverustvip.use",
      "oxide.grant user {steamid64} vipwall.use"
    ]
  },
  rainbow_30d: {
    label: "Rainbow (30d)",
    commands: ["oxide.grant user {steamid64} loverustvip.rainbow"]
  },
  coffee_support: {
    label: "Coffee Support",
    commands: []
  }
};

const processedTxnIds = new Set();

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
  const sku = pickFirstFromSources(sources, ["sku"]);
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
  const responseCode = pickFirstFromSources(sources, [
    "responseCode",
    "response_code",
    "resp_code"
  ]);

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

    const normalizedStatus = String(status || "").trim().toLowerCase();
    const normalizedResponseCode = String(responseCode || "").trim();
    const isSuccess =
      normalizedStatus === "approved" && normalizedResponseCode === "000";

    if (!isSuccess) {
      await discordNotify(
        `❌ Payment not successful\nSteamID: ${steamid64}\nStatus: ${status || "(empty)"}\nResponseCode: ${responseCode || "(empty)"}\nSKU: ${sku || "(empty)"}\nTxn: ${txnId || "(none)"}\nResult: NOT GRANTED`
      );
      return res.status(200).json({ ok: true, ignored: true });
    }

    if (!txnId) {
      console.warn("Missing txnId; skipping fulfillment.");
      await discordNotify(
        `⚠️ Payment received but txnId is missing\nSteamID: ${steamid64}\nSKU: ${sku || "(empty)"}\nResult: NOT GRANTED`
      );
      return res.status(200).json({ ok: false, error: "missing_txnid" });
    }

    if (processedTxnIds.has(txnId)) {
      console.log(`Duplicate txnId received; ignoring. txnId=${txnId}`);
      return res.status(200).json({ ok: true, duplicate: true });
    }

    const mapped = SKU_ACTIONS[sku];
    if (!mapped) {
      await discordNotify(
        `⚠️ Payment received but SKU is unknown\nSteamID: ${steamid64}\nSKU: ${sku || "(empty)"}\nTxn: ${txnId}\nResult: NOT GRANTED`
      );
      return res.status(200).json({ ok: true, unknown_product: true });
    }

    const commands = mapped.commands.map((command) =>
      command.replace("{steamid64}", steamid64)
    );

    const rconResults = [];
    if (commands.length > 0) {
      if (!isRconConfigured) {
        await discordNotify(
          `⚠️ Payment received but RCON is not configured\nSteamID: ${steamid64}\nSKU: ${sku}\nTxn: ${txnId}\nResult: NOT GRANTED`
        );
        return res.status(200).json({ ok: true, granted: false, error: "rcon_not_configured" });
      }
      try {
        for (const command of commands) {
          const result = await rconSend(command);
          rconResults.push({ command, result });
        }
      } catch (err) {
        await discordNotify(
          `❌ RCON failed\nSteamID: ${steamid64}\nSKU: ${sku}\nTxn: ${txnId}\nError: ${err?.message || "unknown"}\nResult: NOT GRANTED`
        );
        return res.status(502).json({ ok: false, error: "rcon_failed" });
      }
    }

    processedTxnIds.add(txnId);

    let msg =
      `✅ **New Purchase**\n` +
      `**Player (SteamID64):** ${steamid64}\n` +
      `**SKU:** ${sku}\n` +
      `**Txn:** ${txnId}\n` +
      `**Result:** GRANTED\n` +
      (commands.length > 0
        ? `**RCON:**\n${commands.map((cmd) => `- \`${cmd}\``).join("\n")}`
        : `**RCON:** (none)`);

    await discordNotify(msg);

    return res.status(200).json({
      ok: true,
      granted: commands.length > 0,
      sku,
      rcon: rconResults.length > 0
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

app.listen(resolvedPort, "0.0.0.0", () => {
  console.log(`LoveRustPayBridge listening on :${resolvedPort}`);
});
