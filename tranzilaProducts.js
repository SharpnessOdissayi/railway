const CANONICAL_SKUS = ["vip_30d", "rainbow_30d", "test"];

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

function resolveCanonicalSku({ custom2, pdesc, product } = {}) {
  const normalized = [
    normalizeSku(custom2),
    normalizeSku(pdesc),
    normalizeSku(product)
  ].find(Boolean);
  if (!normalized) return "";
  return CANONICAL_SKUS.includes(normalized) ? normalized : "";
}

function resolveEffectiveSku(resolvedSku, testTarget) {
  if (resolvedSku !== "test") {
    return { effectiveSku: resolvedSku, reason: "" };
  }
  const normalizedTarget = normalizeSku(testTarget);
  if (!["vip_30d", "rainbow_30d"].includes(normalizedTarget)) {
    return { effectiveSku: "", reason: "test_target_required" };
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
  normalizeSku,
  resolveCanonicalSku,
  resolveEffectiveSku,
  resolveRconCommands
};
