#!/usr/bin/env node
import assert from "node:assert/strict";

const classify = (record) => {
  const sources = record.sources || [];
  const premium = sources.filter((source) => source.type === "Premium");
  const paid = premium.some((source) => /(online store|collector.?s edition|game time card)/i.test(source.text || ""));
  const limited = !record.tradeable && sources.some((source) => source.type === "Event" || source.type === "PvP" || (source.type === "Premium" && !paid) || /(campaign|promotion|twitch|legacy|pre-order|seasonal|fan festival|lawson|amazon)/i.test(source.text || ""));
  return { market: !!record.tradeable, paid, availability: limited ? "limited" : "available", campaign: premium.length > 0 && !paid };
};

const load = async (kind) => {
  const response = await fetch(`https://ffxivcollect.com/api/${kind}?language=ja`);
  assert.equal(response.status, 200, `${kind} API response`);
  return (await response.json()).results;
};
const [mounts, minions] = await Promise.all([load("mounts"), load("minions")]);
const all = [...mounts, ...minions];
const onlineStore = all.find((row) => row.sources.some((source) => source.type === "Premium" && /online store/i.test(source.text || "")));
const limitedEvent = all.find((row) => !row.tradeable && row.sources.some((source) => source.type === "Event"));
const tradable = all.find((row) => row.tradeable);
const campaign = all.find((row) => !row.tradeable && row.sources.some((source) => source.type === "Premium" && /twitch|promotion|campaign/i.test(source.text || "")));
assert.ok(onlineStore && limitedEvent && tradable && campaign, "Representative source records are available");
assert.deepEqual(classify(onlineStore), { market: false, paid: true, availability: "available", campaign: false });
assert.equal(classify(limitedEvent).availability, "limited");
assert.deepEqual(classify(tradable), { market: true, paid: false, availability: "available", campaign: false });
assert.deepEqual(classify(campaign), { market: false, paid: false, availability: "limited", campaign: true });
const summary = all.reduce((out, row) => {
  const value = classify(row);
  out.market += value.market;
  out.available += value.availability === "available";
  out.paid += value.paid;
  return out;
}, { market: 0, available: 0, paid: 0 });
console.log(JSON.stringify({ total: all.length, ...summary, samples: { onlineStore: onlineStore.name, limitedEvent: limitedEvent.name, tradable: tradable.name, campaign: campaign.name } }));
