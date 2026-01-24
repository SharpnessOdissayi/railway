const CANONICAL_SKUS = ["vip_30d", "rainbow_30d"];

const SKU_ALIASES = {
  vip30d: "vip_30d",
  rainbow30d: "rainbow_30d",
  rainbow10m: "rainbow_30d",
  rainbow_10m: "rainbow_30d"
};

const RCON_PRODUCT_MAP = {
  vip_30d: [
    "oxide.grant user {steamid64} loverustvip.use",
    "oxide.grant user {steamid64} vipwall.use"
  ],
  rainbow_30d: [
    "oxide.grant user {steamid64} vip_rainbow 30d"
  ]
};

const DURATION_CAPS = {
  m: 43200,
  h: 720,
  d: 30,
  w: 4,
  mo: 1
};

function normalizeSku(value) {
  if (!value) return "";
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function applySkuAlias(sku) {
  if (!sku) return "";
  return SKU_ALIASES[sku] || sku;
}

function resolveCanonicalSku({ custom2, pdesc, product, plan } = {}) {
  const normalized = [
    normalizeSku(custom2),
    normalizeSku(pdesc),
    normalizeSku(product || plan)
  ].find(Boolean);
  if (!normalized) return "";
  const mapped = applySkuAlias(normalized);
  return CANONICAL_SKUS.includes(mapped) ? mapped : "";
}

function clampDurationValue(unit, value) {
  const cap = DURATION_CAPS[unit];
  if (!cap) return value;
  return Math.min(value, cap);
}

function parseSkuToGrant(skuCandidate) {
  const normalized = normalizeSku(skuCandidate);
  if (!normalized) {
    return { result: null, normalized, reason: "empty_sku" };
  }

  const match = normalized.match(/^(vip|rainbow)(?:_(.+))?$/);
  if (!match) {
    return { result: null, normalized, reason: "unsupported_product" };
  }

  const kind = match[1];
  const remainder = match[2];
  let duration = "";

  if (!remainder) {
    duration = "30d";
  } else if (["perm", "permanent"].includes(remainder)) {
    duration = "perm";
  } else {
    let durationMatch = remainder.match(/^(\d+)(mo|m|h|d|w)$/);
    if (!durationMatch && /^\d+$/.test(remainder)) {
      durationMatch = [remainder, remainder, "d"];
    }

    if (!durationMatch) {
      return { result: null, normalized, reason: "invalid_duration" };
    }

    const value = Number.parseInt(durationMatch[1], 10);
    if (!Number.isFinite(value) || value <= 0) {
      return { result: null, normalized, reason: "non_positive_duration" };
    }

    const unit = durationMatch[2];
    const clampedValue = clampDurationValue(unit, value);
    duration = `${clampedValue}${unit}`;
  }

  const effectiveSku = duration === "perm" ? `${kind}_perm` : `${kind}_${duration}`;

  return {
    result: {
      kind,
      duration,
      effectiveSku
    },
    normalized,
    reason: ""
  };
}

function buildGrantCommands({ steamid64, kind, duration }) {
  if (!steamid64 || !kind || !duration) return [];
  if (kind === "rainbow") {
    return [
      `oxide.grant user ${steamid64} vip_rainbow ${duration}`
    ];
  }
  return [
    `oxide.grant user ${steamid64} loverustvip.use`,
    `oxide.grant user ${steamid64} vipwall.use`
  ];
}

function resolveRconCommands({ effectiveSku, steamid64, grant } = {}) {
  if (grant?.kind && grant?.duration) {
    const commands = buildGrantCommands({
      steamid64,
      kind: grant.kind,
      duration: grant.duration
    });
    return { templates: commands, commands };
  }

  const templates = RCON_PRODUCT_MAP[effectiveSku] || [];
  const commands = templates.map((command) =>
    command.replace("{steamid64}", steamid64)
  );
  return { templates, commands };
}

export {
  CANONICAL_SKUS,
  RCON_PRODUCT_MAP,
  applySkuAlias,
  buildGrantCommands,
  normalizeSku,
  parseSkuToGrant,
  resolveCanonicalSku,
  resolveRconCommands
};
