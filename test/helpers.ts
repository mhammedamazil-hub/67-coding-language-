import { ModuleBuilder } from '../src/lang/assembler.js';
import { decodeStream, moduleToStream, Module } from '../src/lang/format.js';
import { verifyModule } from '../src/lang/semantic.js';
import { runProject } from '../src/lang/project.js';
import type { ProjectFiles } from '../src/lang/project.js';

export function buildStream(builder: ModuleBuilder): string {
  const mod = builder.build();
  verifyModule(mod);
  const stream = moduleToStream(mod);
  if (!/^[67]+$/.test(stream)) throw new Error('generated source contains non-6/7 symbols');
  return stream;
}

export async function runBuilder(builder: ModuleBuilder, inputQueue: string[] = []): Promise<{ output: string; ok: boolean; error: string | null }> {
  const stream = buildStream(builder);
  const result = await runProject({ 'main.67': stream }, {
    io: {
      input: async () => inputQueue.shift() ?? '',
    },
  });
  return result;
}

export async function runFiles(files: ProjectFiles, entry = 'main.67'): Promise<{ output: string; ok: boolean; error: string | null }> {
  return runProject(files, { entry });
}

export function decodeOnly(builder: ModuleBuilder): Module {
  return decodeStream(buildStream(builder));
}
