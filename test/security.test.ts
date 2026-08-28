import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ModuleBuilder } from '../src/lang/assembler.js';
import { moduleToStream } from '../src/lang/format.js';
import { runProject } from '../src/lang/project.js';

const SRC_DIR = join(process.cwd(), 'src', 'lang');
const source = (): string => {
  let text = '';
  for (const f of readdirSync(SRC_DIR).filter((n) => n.endsWith('.ts'))) {
    text += readFileSync(join(SRC_DIR, f), 'utf8');
  }
  return text;
};

describe('security: the runtime never evaluates host code', () => {
  it('never uses eval()', () => {
    expect(/\beval\s*\(/.test(source())).toBe(false);
  });

  it('never uses the Function constructor', () => {
    expect(/new\s+Function\b/.test(source())).toBe(false);
  });

  it('never touches window, document, localStorage or cookies', () => {
    const text = source();
    for (const banned of ['window.', 'document.', 'localStorage', 'document.cookie', 'sessionStorage']) {
      expect(text.includes(banned), `must not reference ${banned}`).toBe(false);
    }
  });

  it('never calls fetch, XMLHttpRequest or network APIs', () => {
    const text = source();
    for (const banned of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'http.request', 'https.request']) {
      expect(text.includes(banned), `must not reference ${banned}`).toBe(false);
    }
  });

  it('never touches the filesystem or process internals from programs', () => {
    const text = source();
    for (const banned of ['require(', 'fs.readFile', 'fs.writeFile', 'child_process', 'node:fs', 'Deno.']) {
      expect(text.includes(banned), `must not reference ${banned}`).toBe(false);
    }
  });

  it('programs cannot reach the host object graph through globals', async () => {
    // A program may only manipulate explicit runtime values; even an error
    // value stringifies instead of leaking host internals.
    const b = new ModuleBuilder('main');
    b.root.null(); b.root.callBuiltin('typeof', 1); b.root.callBuiltin('print', 1);
    const r = await runProject({ 'main.67': moduleToStream(b.build()) });
    expect(r.ok).toBe(true);
    expect(r.output).toBe('null\n');
  });
});
