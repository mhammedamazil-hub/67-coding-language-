/**
 * Virtual project support: multiple .67 files with module imports.
 * A project is a flat map of file name -> 6/7 source stream. Modules import
 * each other by file name (e.g. "math.67"); the loader decodes, verifies and
 * caches modules on demand — the runtime never touches a filesystem itself.
 */

import { Module, decodeStream } from './format.js';
import { verifyModule } from './semantic.js';
import { HostIO, Interpreter, RunResult } from './runtime.js';

export type ProjectFiles = Record<string, string>;

export interface ProjectRunOptions {
  io?: HostIO;
  signal?: AbortSignal;
  maxInstructions?: number;
  timeoutMs?: number;
  entry?: string;
}

export interface CompiledProject {
  modules: Map<string, Module>;
  errors: Array<{ file: string; error: string }>;
}

/** Decode and verify every file in a project. */
export function compileProject(files: ProjectFiles): CompiledProject {
  const modules = new Map<string, Module>();
  const errors: Array<{ file: string; error: string }> = [];
  for (const [name, source] of Object.entries(files)) {
    try {
      const mod = decodeStream(source);
      verifyModule(mod);
      modules.set(name, mod);
    } catch (e) {
      errors.push({ file: name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { modules, errors };
}

function resolveModuleName(ref: string): string {
  return ref.endsWith('.67') ? ref : ref + '.67';
}

/** Run a project starting at `entry` (default main.67). */
export async function runProject(files: ProjectFiles, opts: ProjectRunOptions = {}): Promise<RunResult> {
  const entry = opts.entry ?? 'main.67';
  const source = files[entry];
  if (source === undefined) {
    return { output: '', ok: false, error: `entry file '${entry}' not found in project` };
  }
  const main = decodeStream(source);
  verifyModule(main);

  const cache = new Map<string, Module>();
  const loadModule = async (name: string): Promise<Module | null> => {
    const resolved = resolveModuleName(name);
    const cached = cache.get(resolved);
    if (cached) return cached;
    const src = files[resolved];
    if (src === undefined) return null;
    const mod = decodeStream(src);
    verifyModule(mod);
    cache.set(resolved, mod);
    return mod;
  };

  const interp = new Interpreter(main, {
    io: opts.io,
    loadModule,
    signal: opts.signal,
    maxInstructions: opts.maxInstructions,
    timeoutMs: opts.timeoutMs,
  });
  return interp.run();
}
