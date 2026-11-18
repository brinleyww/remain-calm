// Runs every node test suite in turn. Run: node test/all.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SUITES = ['sim_all.mjs', 'movement.mjs', 'combat_all.mjs', 'combat_targeting.mjs', 'map_format.mjs', 'map_citygen.mjs', 'map_osm.mjs', 'shell_meta.mjs', 'editor_model.mjs', 'net_lockstep.mjs', 'integration.mjs'];
const failed = [];
for (const f of SUITES) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [join(here, f)], { cwd: here, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const ok = r.status === 0;
  const tail = (r.stdout || '').trim().split('\n').pop();
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${f.padEnd(18)} ${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s  ${tail || ''}`);
  if (!ok) { failed.push(f); process.stdout.write((r.stdout || '').split('\n').filter((l) => !l.startsWith('ok')).slice(-15).join('\n') + '\n' + (r.stderr || '')); }
}
console.log(failed.length ? `\n${failed.length} suite(s) failed: ${failed.join(', ')}` : '\nAll suites passed.');
process.exitCode = failed.length ? 1 : 0;
