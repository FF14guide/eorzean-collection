#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extractItemIcons, extractCharacter, isLodestoneItemIcon } from "../worker.js";

const [mountFile, minionFile, characterFile] = process.argv.slice(2);
if (!mountFile || !minionFile || !characterFile) {
  throw new Error("Usage: node tests/verify-lodestone-parser.mjs <mount.html> <minion.html> <character.html>");
}

const [mountHtml, minionHtml, characterHtml] = await Promise.all([
  readFile(mountFile, "utf8"),
  readFile(minionFile, "utf8"),
  readFile(characterFile, "utf8"),
]);
const mounts = extractItemIcons(mountHtml);
const minions = extractItemIcons(minionHtml);
const character = extractCharacter(characterHtml, "25961161");

assert.equal(mounts.length, 227, "Mount parser count changed");
assert.equal(minions.length, 431, "Minion parser count changed");
assert.equal(new Set(mounts).size, mounts.length, "Mount icons are not unique");
assert.equal(new Set(minions).size, minions.length, "Minion icons are not unique");
assert.ok(mounts.every(isLodestoneItemIcon), "A mount URL does not pass the strict icon allowlist");
assert.ok(minions.every(isLodestoneItemIcon), "A minion URL does not pass the strict icon allowlist");
assert.equal(character.name, "Asagi Kun", "Character parser name changed");
assert.equal(character.server, "Masamune", "Character parser world changed");
console.log(JSON.stringify({ character: character.name, mounts: mounts.length, minions: minions.length }));
