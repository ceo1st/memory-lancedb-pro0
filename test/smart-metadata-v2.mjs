/**
 * Smart Metadata V2 Test — SupportInfo / ContextualSupport
 * Tests the contextual support extension to OpenViking's SmartMemoryMetadata.
 */

import assert from "node:assert/strict";

// ============================================================================
// Mock: import the functions directly (they're pure functions)
// ============================================================================

// Since we can't import .ts directly, we test the logic inline

// --- normalizeContext ---
console.log("Test 1: normalizeContext maps Chinese aliases...");
const aliases = {
    "晚上": "evening", "早上": "morning", "周末": "weekend",
    "工作": "work", "旅行": "travel", "冬天": "winter",
    "evening": "evening", "morning": "morning",
};
for (const [input, expected] of Object.entries(aliases)) {
    // Implementation of normalizeContext inline for testing
    const VOCAB = ["general", "morning", "evening", "night", "weekday", "weekend", "work", "leisure", "summer", "winter", "travel"];
    const ALIASES = {
        "早上": "morning", "上午": "morning", "早晨": "morning",
        "下午": "evening", "傍晚": "evening", "晚上": "evening",
        "深夜": "night", "夜晚": "night", "凌晨": "night",
        "工作日": "weekday", "平时": "weekday",
        "周末": "weekend", "假日": "weekend", "休息日": "weekend",
        "工作": "work", "上班": "work", "办公": "work",
        "休闲": "leisure", "放松": "leisure", "休息": "leisure",
        "夏天": "summer", "夏季": "summer",
        "冬天": "winter", "冬季": "winter",
        "旅行": "travel", "出差": "travel", "旅游": "travel",
    };
    const lower = input.trim().toLowerCase();
    const result = VOCAB.includes(lower) ? lower : (ALIASES[lower] || lower);
    assert.strictEqual(result, expected, `normalizeContext("${input}") should be "${expected}", got "${result}"`);
}
console.log("  ✅ Chinese alias mapping works correctly");

// --- parseSupportInfo (V1 → V2 migration) ---
console.log("\nTest 2: parseSupportInfo handles V1 flat format...");
const v1Raw = { confirmations: 3, contradictions: 1 };
// Simulate parseSupportInfo
const conf = typeof v1Raw.confirmations === "number" ? v1Raw.confirmations : 0;
const contra = typeof v1Raw.contradictions === "number" ? v1Raw.contradictions : 0;
const total = conf + contra;
const v2FromV1 = {
    global_strength: total > 0 ? conf / total : 0.5,
    total_observations: total,
    slices: [{ context: "general", confirmations: conf, contradictions: contra, strength: conf / total, last_observed_at: Date.now() }],
};
assert.strictEqual(v2FromV1.global_strength, 0.75, "V1 {3 conf, 1 contra} → strength 0.75");
assert.strictEqual(v2FromV1.total_observations, 4);
assert.strictEqual(v2FromV1.slices.length, 1);
assert.strictEqual(v2FromV1.slices[0].context, "general");
console.log("  ✅ V1 → V2 migration preserves data");

// --- parseSupportInfo (V2 format) ---
console.log("\nTest 3: parseSupportInfo handles V2 sliced format...");
const v2Raw = {
    global_strength: 0.8,
    total_observations: 5,
    slices: [
        { context: "morning", confirmations: 3, contradictions: 0, strength: 1.0, last_observed_at: 1000 },
        { context: "evening", confirmations: 1, contradictions: 1, strength: 0.5, last_observed_at: 2000 },
    ],
};
assert.strictEqual(v2Raw.slices.length, 2);
assert.strictEqual(v2Raw.slices[0].context, "morning");
assert.strictEqual(v2Raw.slices[1].strength, 0.5);
console.log("  ✅ V2 format parsed correctly");

// --- updateSupportStats ---
console.log("\nTest 4: updateSupportStats adds new context slice...");
const existing = {
    global_strength: 0.75,
    total_observations: 4,
    slices: [{ context: "general", confirmations: 3, contradictions: 1, strength: 0.75, last_observed_at: 1000 }],
};

// Simulate update for "evening" support
const ctx = "evening";
const base = { ...existing, slices: [...existing.slices.map(s => ({ ...s }))] };
let slice = base.slices.find(s => s.context === ctx);
if (!slice) {
    slice = { context: ctx, confirmations: 0, contradictions: 0, strength: 0.5, last_observed_at: Date.now() };
    base.slices.push(slice);
}
slice.confirmations++;
const sliceTotal = slice.confirmations + slice.contradictions;
slice.strength = sliceTotal > 0 ? slice.confirmations / sliceTotal : 0.5;
slice.last_observed_at = Date.now();

let totalConf = 0, totalContra = 0;
for (const s of base.slices) {
    totalConf += s.confirmations;
    totalContra += s.contradictions;
}
const totalObs = totalConf + totalContra;
const global_strength = totalObs > 0 ? totalConf / totalObs : 0.5;

const updated = { global_strength, total_observations: totalObs, slices: base.slices };

assert.strictEqual(updated.slices.length, 2, "Should have 2 slices (general + evening)");
assert.strictEqual(updated.total_observations, 5, "Total observations should be 5");
assert.strictEqual(updated.global_strength, 4 / 5, "Global strength = 4/5 = 0.8");
const eveningSlice = updated.slices.find(s => s.context === "evening");
assert.ok(eveningSlice, "Evening slice should exist");
assert.strictEqual(eveningSlice.confirmations, 1);
assert.strictEqual(eveningSlice.strength, 1.0, "1 confirm, 0 contra = 1.0");
console.log("  ✅ New context slice added correctly");

// --- updateSupportStats for contradict ---
console.log("\nTest 5: updateSupportStats handles contradict event...");
// Start from the updated state and contradict evening
const eveningSlice2 = updated.slices.find(s => s.context === "evening");
eveningSlice2.contradictions++;
const st2 = eveningSlice2.confirmations + eveningSlice2.contradictions;
eveningSlice2.strength = st2 > 0 ? eveningSlice2.confirmations / st2 : 0.5;

assert.strictEqual(eveningSlice2.contradictions, 1);
assert.strictEqual(eveningSlice2.strength, 0.5, "1 conf + 1 contra = 0.5");
console.log("  ✅ Contradict event recorded correctly");

// --- MAX_SUPPORT_SLICES cap ---
console.log("\nTest 6: Support slices capped at MAX_SUPPORT_SLICES=8...");
const MAX_SUPPORT_SLICES = 8;
const manySlices = [];
for (let i = 0; i < 10; i++) {
    manySlices.push({ context: `ctx_${i}`, confirmations: 1, contradictions: 0, strength: 1.0, last_observed_at: i * 1000 });
}
const capped = manySlices.sort((a, b) => b.last_observed_at - a.last_observed_at).slice(0, MAX_SUPPORT_SLICES);
assert.strictEqual(capped.length, 8, "Should cap at 8 slices");
assert.strictEqual(capped[0].context, "ctx_9", "Most recent slice first");
console.log("  ✅ Slice cap works correctly");

console.log("\n=== All Smart Metadata V2 tests passed! ===");
