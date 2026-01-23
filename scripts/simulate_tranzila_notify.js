import {
  resolveCanonicalSku,
  resolveEffectiveSku,
  resolveRconCommands
} from "../tranzilaProducts.js";

const steamid64 = "76561199026505924";
const cases = [
  {
    name: "custom2=rainbow_30d",
    payload: { custom2: "rainbow_30d" },
    testTarget: ""
  },
  {
    name: "custom2=vip_30d",
    payload: { custom2: "vip_30d" },
    testTarget: ""
  },
  {
    name: "custom2=test (TEST_TARGET=rainbow_30d)",
    payload: { custom2: "test" },
    testTarget: "rainbow_30d"
  }
];

for (const { name, payload, testTarget } of cases) {
  const resolvedSku = resolveCanonicalSku({
    custom2: payload.custom2,
    pdesc: payload.pdesc,
    product: payload.product
  });
  const { effectiveSku, reason } = resolveEffectiveSku(resolvedSku, testTarget);
  const { commands } = resolveRconCommands({ effectiveSku, steamid64 });
  console.log(name, {
    resolvedSku,
    effectiveSku,
    reason: reason || "(none)",
    commands
  });
}

console.log("Deduping is enforced in-memory in /tranzila/notify.");
