/**
 * Virtual project filesystem for the workstation UI. Backed by IndexedDB
 * with a localStorage fallback; the whole editor runs client-side with no
 * backend. Every stored .67 file is a pure 6/7 stream.
 */

export interface ProjectFile {
  name: string;
  content: string;
  updated: number;
}

const DB_NAME = 'lang67';
const STORE = 'files';
const LS_KEY = 'lang67-project-v1';
const SETTINGS_KEY = 'lang67-settings-v1';

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'name' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

function lsRead(): Record<string, ProjectFile> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, ProjectFile>) : {};
  } catch {
    return {};
  }
}

function lsWrite(files: Record<string, ProjectFile>): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(files));
  } catch {
    // storage full or unavailable; ignore (IndexedDB is the primary path)
  }
}

export class ProjectStorage {
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    this.db = await openDb();
  }

  async loadAll(): Promise<Record<string, ProjectFile>> {
    if (this.db) {
      return new Promise((resolve) => {
        const tx = this.db!.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => {
          const all = (req.result as ProjectFile[]) || [];
          const map: Record<string, ProjectFile> = {};
          for (const f of all) map[f.name] = f;
          resolve(Object.keys(map).length ? map : lsRead());
        };
        req.onerror = () => resolve(lsRead());
      });
    }
    return lsRead();
  }

  async save(file: ProjectFile): Promise<void> {
    const ls = this.db ? lsRead() : lsRead();
    ls[file.name] = file;
    if (!this.db) {
      lsWrite(ls);
      return;
    }
    const lsCurrent = lsRead();
    lsCurrent[file.name] = file;
    lsWrite(lsCurrent);
    await new Promise<void>((resolve) => {
      const tx = this.db!.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(file);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  async remove(name: string): Promise<void> {
    if (!this.db) {
      const ls = lsRead();
      delete ls[name];
      lsWrite(ls);
      return;
    }
    const ls = lsRead();
    delete ls[name];
    lsWrite(ls);
    await new Promise<void>((resolve) => {
      const tx = this.db!.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(name);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  async exportProject(files: ProjectFile[]): Promise<string> {
    return JSON.stringify({ version: 1, files }, null, 2);
  }

  async importProject(json: string): Promise<ProjectFile[]> {
    const data = JSON.parse(json) as { version: number; files: ProjectFile[] };
    if (!Array.isArray(data.files)) throw new Error('not a 67 project export');
    for (const f of data.files) {
      if (typeof f.name !== 'string' || typeof f.content !== 'string') throw new Error('malformed project file');
      if (!f.name.endsWith('.67')) throw new Error(`refusing import: ${f.name} is not a .67 file`);
      if (f.content.length && !/^[67]+$/.test(f.content)) throw new Error(`refusing import: ${f.name} is not pure 6/7 source`);
    }
    return data.files;
  }
}

export interface Settings {
  wrapWidth: number;
  fontSize: number;
  openaiKey?: string;
  geminiKey?: string;
  aiProvider?: 'openai' | 'gemini';
  aiModel?: string;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { wrapWidth: 64, fontSize: 14, aiProvider: 'openai', ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // ignore
  }
  return { wrapWidth: 64, fontSize: 14, aiProvider: 'openai' };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}
