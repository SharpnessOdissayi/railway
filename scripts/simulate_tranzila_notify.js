import { resolveRconCommands } from "../tranzilaProducts.js";

const steamid64 = "76561199026505924";
const formBody = new URLSearchParams({
  product: "rainbow",
  steamid64,
  status: "approved",
  tx: "test_tx"
}).toString();

const parsed = Object.fromEntries(new URLSearchParams(formBody).entries());
const { resolvedProduct, commands } = resolveRconCommands(parsed.product, steamid64);
const expected = `loverustvip.grantrainbow ${steamid64} 30d`;
const forbidden = `loverustvip.grant ${steamid64} 30d`;

if (!commands.includes(expected) || commands.includes(forbidden)) {
  console.error("Unexpected command mapping.", {
    resolvedProduct,
    commands,
    expected,
    forbidden
  });
  process.exit(1);
}

console.log(`OK: resolvedProduct=${resolvedProduct} command=${expected}`);
