#!/usr/bin/env node
import assert from "node:assert/strict";

const kinds = ["mounts", "minions", "achievements"];
const summary = {};
for (const kind of kinds) {
  const response = await fetch(`https://ffxivcollect.com/api/${kind}?language=ja`);
  assert.equal(response.status, 200, `${kind} API response`);
  const records = (await response.json()).results;
  assert.ok(records.length > 0, `${kind} has records`);
  const missing = records.filter((record) => !/^\d+(?:\.\d+)?%$/.test(String(record.owned || "")));
  assert.equal(missing.length, 0, `${kind} ownership-rate field availability`);
  const rates = records.map((record) => Number.parseFloat(record.owned));
  assert.ok(rates.every((rate) => rate >= 0 && rate <= 100), `${kind} ownership-rate range`);
  summary[kind] = { records: records.length, min: `${Math.min(...rates)}%`, max: `${Math.max(...rates)}%`, sample: { name: records[0].name, owned: records[0].owned } };
}
console.log(JSON.stringify(summary, null, 2));
