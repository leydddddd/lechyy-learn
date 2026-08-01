#!/usr/bin/env node
// Measure per-tab heap cost of the full CEDICT Map and total across 5 tabs.
// M4.5: Dictionary memory measurement — shard-by-leading-han+LRU optimization.
// This script loads cedict.json once, builds Map instances, and reports delta
// using explicit GC to accurately measure Map heap cost.
// Run from project root: node --expose-gc scripts/measure-dict-memory.js

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cedictPath = join(__dirname, "..", "data", "cedict.json");

// Load the raw JSON
const rawJson = readFileSync(cedictPath, "utf-8");
const parsed = JSON.parse(rawJson);
const entries = parsed.entries || null;

if (!entries) {
  console.error("cedict.json has no .entries — cannot measure.");
  process.exit(1);
}

let keyCount = Object.keys(entries).length;

console.log("=== CC-CEDICT Raw JSON ===");
console.log(`  File size: ${(rawJson.length / (1024 * 1024)).toFixed(2)} MB`);
console.log(`  Total entries: ${keyCount.toLocaleString()}`);

// Snapshot helper using process.memoryUsage()
function memMB(label) {
  const m = process.memoryUsage();
  console.log(`\n${label}:`);
  console.log(`  heapUsed: ${(m.heapUsed / 1048576).toFixed(2)} MB`);
  console.log(`  rss: ${(m.rss / 1048576).toFixed(2)} MB`);
  return m;
}

// Force GC and wait before snapshot
function gcAndSnap(label) {
  if (global.gc) global.gc();
  // Small delay so V8 consolidates
  return new Promise(resolve => setTimeout(() => resolve(memMB(label)), 50));
}

console.log("\n=== 1. Initial baseline (after GC) ===");
await gcAndSnap("After GC (baseline)");
const baseline = process.memoryUsage();

console.log("\n=== 2. Build 1 Map (simulating 1 tab) ===");
function buildMap(entriesObj) {
  return new Map(Object.entries(entriesObj));
}
const map1 = buildMap(entries);
await gcAndSnap("After 1 Map (GC'd)");

const map1Size = process.memoryUsage().heapUsed - baseline.heapUsed;
console.log(`  Single Map heap cost: ${(map1Size / 1048576).toFixed(2)} MB (${map1Size.toLocaleString()} bytes)`);
console.log(`  Per-char overhead: ${(map1Size / keyCount).toFixed(2)} bytes per entry`);

console.log("\n=== 3. Build 5 identical Maps (simulating 5 tabs keeping their copies) ===");
const maps = [map1];
for (let i = 2; i <= 5; i++) {
  maps.push(buildMap(entries));
}
await gcAndSnap("After 5 Maps (GC'd)");

const after5Maps = process.memoryUsage();
const delta5 = after5Maps.heapUsed - baseline.heapUsed;
console.log(`  5 Maps total delta: ${(delta5 / 1048576).toFixed(2)} MB`);
console.log(`  Per-Map delta: ${(delta5 / 5 / 1048576).toFixed(2)} MB`);
console.log(`  Maps 2–5 incremental: ${((after5Maps.heapUsed - map1Size - baseline.heapUsed) / 1048576).toFixed(2)} MB`);

console.log("\n=== 4. Drop 4 Maps, keep 1, GC ===");
maps.length = 1; // retain only map1
await gcAndSnap("After dropping 4 Maps (GC'd)");

const afterDrop = process.memoryUsage();
const persisted = afterDrop.heapUsed - baseline.heapUsed;
console.log(`  Persisting 1 Map: ${(persisted / 1048576).toFixed(2)} MB`);
console.log(`  Cleanly freed by GC: ${((delta5 - persisted) / 1048576).toFixed(2)} MB`);

console.log("\n=== 5. Drop last Map, GC ===");
maps.length = 0;
await gcAndSnap("After dropping last Map (GC'd)");

const afterAllDropped = process.memoryUsage();
const leaked = afterAllDropped.heapUsed - baseline.heapUsed;
console.log(`  After all dropped: ${(leaked / 1048576).toFixed(2)} MB (any delta = leak or V8 internals)`);

// Final projection
console.log("\n=== SUMMARY ===");
console.log(`  Single CEDICT Map heap cost: ${(map1Size / 1048576).toFixed(2)} MB`);
console.log(`  Projected 5-tab total: ${(map1Size * 5 / 1048576).toFixed(2)} MB`);
console.log(`  Content script isolation: 1 Map per tab = ${delta5 / 5 / 1048576} MB per tab`);
console.log(`  Is material? ${map1Size / 1048576 > 1 ? "YES" : "NO"}`);

// Shard distribution
console.log("\n=== Shard Distribution (by leading character) ===");
const shards = new Map();
for (const key of Object.keys(entries)) {
  const firstChar = key.charAt(0);
  if (!shards.has(firstChar)) shards.set(firstChar, 0);
  shards.set(firstChar, shards.get(firstChar) + 1);
}

const shardEntries = Array.from(shards.entries());
shardEntries.sort((a, b) => b[1] - a[1]);

let cjkShards = 0;
for (const [char] of shardEntries) {
  const code = char.codePointAt(0);
  if (code >= 0x4e00 && code <= 0x9fff) cjkShards++;
}

// Average shard size in entries and approximate heap
const avgEntriesPerShard = keyCount / shardEntries.length;
const avgMapCostPerShard = map1Size / shardEntries.length;
console.log(`  Total unique leading-char shards: ${shardEntries.length}`);
console.log(`  Average shard size: ${avgEntriesPerShard.toFixed(0)} entries (~${(avgMapCostPerShard / 1024).toFixed(1)} KB per shard)`);
console.log(`  Largest shard: "${shardEntries[0][0]}" with ${shardEntries[0][1]} entries (${(shardEntries[0][1] / keyCount * 100).toFixed(1)}%)`);
console.log(`  CJK shards: ${cjkShards}, Non-CJK shards: ${shardEntries.length - cjkShards}`);
console.log(`  Top 10 shards by entry count:`);
for (const [char, count] of shardEntries.slice(0, 10)) {
  console.log(`    "${char}": ${count} entries (${(count / keyCount * 100).toFixed(1)}%)`);
}
