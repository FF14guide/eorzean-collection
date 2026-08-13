#!/usr/bin/env node
import assert from "node:assert/strict";
import { achievementPageCount, extractAchievementIds } from "../worker.js";

const id = process.argv[2] || "25961161";
const expected = Number(process.env.EXPECTED_ACHIEVEMENTS || 2317);
const perChunk = 10;
const base = `https://jp.finalfantasyxiv.com/lodestone/character/${id}/achievement/`;
const headers = { "User-Agent": "Mozilla/5.0 (compatible; EorzeaCollectionLedger/5.0)", "Accept-Language": "ja,en;q=0.8" };
const get = async (page) => {
  const response = await fetch(page === 1 ? base : `${base}?page=${page}`, { headers });
  assert.equal(response.status, 200, `Page ${page} returned HTTP ${response.status}`);
  return response.text();
};

const all = new Set();
let start = 1;
let total = 1;
let chunks = 0;
while (start <= total) {
  const seed = await get(start);
  total = achievementPageCount(seed);
  const through = Math.min(total, start + perChunk - 1);
  const pages = Array.from({ length: through - start + 1 }, (_, index) => start + index);
  const html = await Promise.all(pages.map((page) => page === start ? Promise.resolve(seed) : get(page)));
  html.forEach((body) => extractAchievementIds(body).forEach((value) => all.add(value)));
  chunks += 1;
  if (through >= total) break;
  start = through + 1;
}
assert.equal(all.size, expected, "Chunked achievement flow missed or added IDs");
console.log(JSON.stringify({ id, chunks, pages: total, achievementIds: all.size }));
