import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import WebSocket from "ws";

const app = express();
app.use(express.json({ limit: "1mb" }));

const {
  PORT = 3000,

  // Security
  API_SECRET, // required

  // RCON
  RCON_HOST,      // required
  RCON_PORT,      // required
  RCON_PASSWORD,  // required

  // Discord
  DISCORD_WEBHOOK_URL, // recommended

  // Behavior
  DRY_RUN = "false"
} = process.env;

function required(name, value) {
  if (!value) throw new Error(`Missing required env var: ${name}`);
}

required("API_SECRET", API_SECRET);
required("RCON_HOST", RCON_HOST);
required("RCON_PORT", RCON_PORT);
required("RCON_PASSWORD", RCON_PASSWORD);

const isDryRun = DRY_RUN.toLowerCase() === "true";

// Map products you send from Tranzila notify
const PRODUCT_MAP = {
  vip_30:      { action: "vip",     duration: "30d", priceLabel: "$19.90" },
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

app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

app.post("/tranzila/notify", async (req, res) => {
  console.log("=== TRANZILA NOTIFY HIT ===");
  console.log("Headers:", req.headers["content-type"]);
  console.log("Body:", req.body);
  try {
    const body = req.body || {};

    // Security: shared secret
    const secret =
      pickFirst(body, ["secret", "api_secret", "token"]) ||
      pickFirst(req.query, ["secret", "api_secret", "token"]);
    if (secret !== API_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const steamid64 = pickFirst(body, ["steamid64", "steam_id", "steamid", "userid"]);
    const status = pickFirst(body, ["status", "payment_status", "result"]);
    const product = pickFirst(body, ["product", "product_id", "item", "plan"]);
    const txnId = pickFirst(body, ["txn_id", "transaction_id", "order_id", "index"]);

    if (!steamid64) return res.status(400).json({ ok: false, error: "missing steamid64" });

    // flexible success detection
    const s = (status || "").toLowerCase();
    const isSuccess = ["success", "approved", "ok", "true", "0"].includes(s);

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
    if (rconCommand) rconResult = await rconSend(rconCommand);

    let msg =
      `✅ **New Purchase**\n` +
      `**Player (SteamID64):** ${steamid64}\n` +
      `**Product:** ${humanProduct}\n` +
      (mapped.priceLabel ? `**Price:** ${mapped.priceLabel}\n` : "") +
      (txnId ? `**Txn:** ${txnId}\n` : "") +
      (rconCommand ? `**RCON:** \`${rconCommand}\`` : `**RCON:** (none)`);

    if (mapped.action === "rainbow") msg += `\n**Note:** Player can use \`/cc rainbow\` in-game.`;

    await discordNotify(msg);

    return res.status(200).json({ ok: true, granted: !!rconCommand, product, rcon: !!rconResult });
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
