#!/usr/bin/env node
/**
 * FFXIV Collect character ownership API contract test.
 *
 * Usage:
 *   node tests/verify-character-ownership.mjs 25961161
 *
 * Optional expected counts:
 *   EXPECTED_MOUNTS=227 EXPECTED_MINIONS=431 EXPECTED_ACHIEVEMENTS=2316 \
 *     node tests/verify-character-ownership.mjs 25961161
 */
import assert from "node:assert/strict";

const id = process.argv[2];
if (!/^\d{4,}$/.test(id || "")) {
  throw new Error("Usage: node tests/verify-character-ownership.mjs <LodestoneID>");
}

const url = new URL(`https://ffxivcollect.com/api/characters/${id}`);
url.searchParams.set("ids", "true");
url.searchParams.set("language", "ja");

const response = await fetch(url, {
  headers: { Accept: "application/json" },
});
assert.equal(response.status, 200, `Character API returned HTTP ${response.status}`);
const character = await response.json();

assert.equal(character.id, Number(id), "Character ID does not match the requested ID");
assert.ok(character.name, "Character name is missing");

const expected = {
  mounts: Number(process.env.EXPECTED_MOUNTS || 0),
  minions: Number(process.env.EXPECTED_MINIONS || 0),
  achievements: Number(process.env.EXPECTED_ACHIEVEMENTS || 0),
};

for (const kind of Object.keys(expected)) {
  const collection = character[kind];
  assert.ok(collection && typeof collection === "object", `${kind} is missing`);
  assert.ok(Array.isArray(collection.ids), `${kind}.ids is not an array`);
  assert.ok(Number.isInteger(collection.count), `${kind}.count is not an integer`);
  assert.equal(
    new Set(collection.ids).size,
    collection.ids.length,
    `${kind}.ids includes duplicated IDs`,
  );
  assert.equal(
    collection.ids.length,
    collection.count,
    `${kind}.count and ${kind}.ids length differ`,
  );
  if (expected[kind] > 0) {
    assert.equal(collection.count, expected[kind], `${kind}.count differs from the expected value`);
  }
}

console.table({
  character: character.name,
  world: character.server,
  dataCenter: character.data_center,
  mounts: character.mounts.count,
  minions: character.minions.count,
  achievements: character.achievements.count,
  achievementTotal: character.achievements.total,
  achievementsPublic: character.achievements.public,
  lastParsed: character.last_parsed,
});
console.log("PASS: ownership counts and IDs are internally consistent.");
