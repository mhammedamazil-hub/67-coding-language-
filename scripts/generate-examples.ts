/**
 * Generates public/examples.json (metadata + outputs) and one .67 file per
 * example in public/examples/. Runs as an npm prebuild/pretest step so the
 * shipped examples are always produced by the real encoder + runtime.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAllExamples, buildModulePair } from './examples.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'examples');
mkdirSync(outDir, { recursive: true });

const examples = await buildAllExamples();

const manifest = examples.map((e) => ({
  id: e.def.id,
  title: e.def.title,
  level: e.def.level,
  description: e.def.description,
  file: `examples/${e.def.id}.67`,
  bytes: e.byteLength,
  instructions: e.instructionCount,
  output: e.output,
  ok: e.ok,
}));

for (const e of examples) {
  if (!e.ok) {
    throw new Error(`example ${e.def.id} failed at generation time: ${e.error}`);
  }
  writeFileSync(join(outDir, `${e.def.id}.67`), e.stream);
}

const pair = buildModulePair();
writeFileSync(join(outDir, 'module-main.67'), pair.main);
writeFileSync(join(outDir, 'module-mathlib.67'), pair.math);
writeFileSync(join(outDir, 'module-info.json'), JSON.stringify({ expected: pair.expected, main: 'module-main.67', lib: 'module-mathlib.67' }, null, 2));

writeFileSync(join(outDir, 'index.json'), JSON.stringify(manifest, null, 2));
console.log(`generated ${examples.length} examples into public/examples/`);
for (const m of manifest) {
  console.log(`  [${m.level}] ${m.id}: ${m.bytes} bytes, output ${JSON.stringify(m.output.trim())}`);
}
