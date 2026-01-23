const PRODUCT_ALIASES = {
  vip_rainbow: "vip_rainbow",
  "vip-rainbow": "vip_rainbow"
};

const RCON_PRODUCT_MAP = {
  test_vip: ["loverustvip.grant {steamid64} 10m"],
  vip_rainbow: ["loverustvip.grantrainbow {steamid64} 30d"],
  vip_30: ["loverustvip.grant {steamid64} 30d"],
  rainbow_30: [
    "loverustvip.grant {steamid64} 30d",
    "oxide.grant user {steamid64} vip.rainbow"
  ]
};

function normalizeProduct(product) {
  if (!product) return "";
  return String(product)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function resolveProduct(product) {
  const normalized = normalizeProduct(product);
  if (!normalized) return "";
  return PRODUCT_ALIASES[normalized] || normalized;
}

function resolveRconCommands(product, steamid64) {
  const resolvedProduct = resolveProduct(product);
  const templates = RCON_PRODUCT_MAP[resolvedProduct] || [];
  const commands = templates.map((command) =>
    command.replace("{steamid64}", steamid64)
  );
  return { resolvedProduct, templates, commands };
}

export {
  PRODUCT_ALIASES,
  RCON_PRODUCT_MAP,
  normalizeProduct,
  resolveProduct,
  resolveRconCommands
};
