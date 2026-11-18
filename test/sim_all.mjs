// Runs every SIM test file in sequence (the benchmark is separate: node test/sim_bench.mjs). Run: node test/sim_all.mjs
for (const f of ['./sim_core.mjs', './sim_behaviour.mjs', './sim_persist.mjs']) {
  try { await import(f); } catch (e) { process.exitCode = 1; console.error(`${f} aborted:`, e.message); }
}
console.log(process.exitCode ? 'SIM TESTS FAILED' : 'SIM TESTS PASSED');
