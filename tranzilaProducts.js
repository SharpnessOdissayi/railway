const CANONICAL_SKUS = ["vip_30d", "rainbow_30d", "test"];

const SKU_ALIASES = {
  vip30d: "vip_30d",
  rainbow30d: "rainbow_30d"
};

const RCON_PRODUCT_MAP = {
  vip_30d: ["loverustvip.grant {steamid64} 30d"],
  rainbow_30d: ["loverustvip.grantrainbow {steamid64} 30d"]
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

function resolveEffectiveSku(resolvedSku, testTarget) {
  if (resolvedSku !== "test") {
    return { effectiveSku: resolvedSku, reason: "" };
  }
  const normalizedTarget = applySkuAlias(normalizeSku(testTarget));
  if (!["vip_30d", "rainbow_30d"].includes(normalizedTarget)) {
    return { effectiveSku: "", reason: "missing_test_target" };
  }
  return { effectiveSku: normalizedTarget, reason: "" };
}

function resolveRconCommands({ effectiveSku, steamid64 }) {
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
  normalizeSku,
  resolveCanonicalSku,
  resolveEffectiveSku,
  resolveRconCommands
};
