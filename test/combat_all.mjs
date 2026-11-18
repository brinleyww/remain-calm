// Runs every COMBAT test file in sequence (the benchmark is separate: node test/combat_bench.mjs). Run: node test/combat_all.mjs
for (const f of ['./combat_place.mjs', './combat_abilities.mjs', './combat_battle.mjs']) {
  try { await import(f); } catch (e) { process.exitCode = 1; console.error(`${f} aborted:`, e.message); }
}
console.log(process.exitCode ? 'COMBAT TESTS FAILED' : 'COMBAT TESTS PASSED');
