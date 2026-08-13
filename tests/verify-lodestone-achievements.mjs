#!/usr/bin/env node
import assert from "node:assert/strict";
import { achievementPageCount, extractAchievementIds } from "../worker.js";

const id = process.argv[2] || "25961161";
const expectedIds = Number(process.env.EXPECTED_ACHIEVEMENTS || 2317);
const expectedPages = Number(process.env.EXPECTED_ACHIEVEMENT_PAGES || 47);
const base = `https://jp.finalfantasyxiv.com/lodestone/character/${id}/achievement/`;
const headers = {
  "User-Agent": "Mozilla/5.0 (compatible; EorzeaCollectionLedger/5.0)",
  "Accept-Language": "ja,en;q=0.8",
};
const fetchPage = async (page) => {
  const response = await fetch(page === 1 ? base : `${base}?page=${page}`, { headers });
  assert.equal(response.status, 200, `Achievement page ${page} returned HTTP ${response.status}`);
  return response.text();
};
const landing = await fetchPage(1);
const pageCount = achievementPageCount(landing);
assert.equal(pageCount, expectedPages, "Achievement page count changed");
const ids = new Set(extractAchievementIds(landing));
let next = 2;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next <= pageCount) {
    const page = next++;
    extractAchievementIds(await fetchPage(page)).forEach((value) => ids.add(value));
  }
}));
assert.equal(ids.size, expectedIds, "Public Lodestone achievement ID count changed");
console.log(JSON.stringify({ id, pageCount, achievementIds: ids.size }));
