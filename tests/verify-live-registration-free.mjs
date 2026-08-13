#!/usr/bin/env node
import assert from "node:assert/strict";
import { extractItemIcons, extractCharacter } from "../worker.js";

const id = process.argv[2] || "25961161";
const expectedMounts = Number(process.env.EXPECTED_MOUNTS || 227);
const expectedMinions = Number(process.env.EXPECTED_MINIONS || 431);
const base = `https://jp.finalfantasyxiv.com/lodestone/character/${id}`;
const headers = {
  "User-Agent": "Mozilla/5.0 (compatible; EorzeaCollectionLedger/4.0)",
  "Accept-Language": "ja,en;q=0.8",
};

const getHtml = async (suffix) => {
  const response = await fetch(`${base}/${suffix}`, { headers });
  assert.equal(response.status, 200, `${suffix || "character"} returned HTTP ${response.status}`);
  return response.text();
};

const [mountHtml, minionHtml, characterHtml] = await Promise.all([
  getHtml("mount/"),
  getHtml("minion/"),
  getHtml(""),
]);
const mounts = extractItemIcons(mountHtml);
const minions = extractItemIcons(minionHtml);
const character = extractCharacter(characterHtml, id);

assert.equal(mounts.length, expectedMounts, "Mount count mismatch");
assert.equal(minions.length, expectedMinions, "Minion count mismatch");
assert.ok(character.name, "Character name is missing");
console.log(JSON.stringify({ id, name: character.name, world: character.server, mounts: mounts.length, minions: minions.length }));
