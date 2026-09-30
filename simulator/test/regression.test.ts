import assert from "node:assert/strict";
import test from "node:test";
import { SCENARIOS, runScenario } from "../src/engine.js";

test("baseline is simulated and does not invent device throughput", () => {
  const result = runScenario(SCENARIOS["baseline-10"]);
  assert.equal(result.radioKind, "SIMULATED");
  assert.equal(result.notDeviceThroughput, true);
  assert.equal(result.nodes, 10);
  assert.ok(result.generated > 0);
  assert.ok(result.deliveredToGateway <= result.generated);
  assert.ok(result.maxHopsObserved <= 8);
  assert.match(result.note, /not physical|not phone|Do not quote/i);
});

test("partition blocks delivery until reconnect", () => {
  const isolated: Parameters<typeof runScenario>[0] = {
    ...SCENARIOS["baseline-10"],
    id: "partition-blocked",
    nodes: 20,
    ticks: 8,
    seed: 11,
    gateways: 1,
    partitionAt: 0,
    radioRangeM: 500,
    expiryTicks: 40,
    loss: 0,
    duplicateChance: 0,
    generateEvery: 1,
    originMin: 10,
    originMax: 19,
  };
  const blocked = runScenario(isolated);
  const restored = runScenario({ ...isolated, id: "partition-restored", ticks: 24, reconnectAt: 4 });
  assert.equal(blocked.deliveredToGateway, 0);
  assert.equal(blocked.partitionedTicks, 8);
  assert.ok(restored.deliveredToGateway > 0);
  assert.equal(restored.radioKind, "SIMULATED");
});

test("duplicates do not multiply gateway deliveries", () => {
  const once = runScenario({ ...SCENARIOS["baseline-10"], id: "once", duplicateChance: 0, loss: 0, seed: 5, ticks: 10 });
  const twice = runScenario({ ...SCENARIOS["baseline-10"], id: "dup", duplicateChance: 1, loss: 0, seed: 5, ticks: 10 });
  assert.ok(twice.duplicatesDropped > 0);
  assert.ok(twice.deliveredToGateway <= twice.generated);
  assert.equal(once.radioKind, "SIMULATED");
});

test("expired packets are not counted as delivered", () => {
  const result = runScenario({
    ...SCENARIOS["baseline-10"],
    id: "expire",
    expiryTicks: 0,
    ticks: 4,
    seed: 2,
  });
  assert.equal(result.deliveredToGateway, 0);
  assert.ok(result.expired > 0);
});

test("thousand-node scenario finishes and stays labeled simulated", () => {
  const result = runScenario(SCENARIOS["partition-1000"]);
  assert.equal(result.nodes, 1000);
  assert.equal(result.radioKind, "SIMULATED");
  assert.ok(result.partitionedTicks > 0);
  assert.equal(result.packetCrypto, "not-applied-in-scale-model");
});

test("optional ten-thousand logical nodes stay bounded", () => {
  const result = runScenario(SCENARIOS["stress-10000"]);
  assert.equal(result.nodes, 10000);
  assert.ok(result.generated > 0);
  assert.ok(result.deliveredToGateway <= result.generated);
  assert.equal(result.notDeviceThroughput, true);
});
