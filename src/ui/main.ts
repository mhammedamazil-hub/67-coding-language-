/**
 * 67 workstation UI. The editor only ever displays/edits raw 6/7 source.
 * Readable information (disassembly, docs, diagnostics) lives in separate
 * panels and never replaces the binary editor.
 */

import { ProjectFile, ProjectStorage, loadSettings, saveSettings, Settings } from '../app/storage.js';
import { validateSource } from '../app/validate.js';
import { decodeStream, disassemble, moduleToStream, OP_SPEC, Module } from '../lang/format.js';
import { runProject } from '../lang/project.js';
import { ModuleBuilder } from '../lang/assembler.js';
import { softWrap } from '../lang/bits.js';
import { LIMITS } from '../lang/limits.js';
import { DOCS_HTML } from './docs.js';
import examplesManifest from '../../examples-data/index.json';
import './sw-register.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const editor = $<HTMLTextAreaElement>('editor');
const gutter = $<HTMLPreElement>('gutter');
const statusLine = $<HTMLDivElement>('status-line');
const terminal = $<HTMLPreElement>('terminal');
const fileList = $<HTMLUListElement>('file-list');
const fileCount = $<HTMLSpanElement>('file-count');
const editorTitle = $<HTMLSpanElement>('editor-title');
const editorMeta = $<HTMLSpanElement>('editor-meta');
const termInputRow = $<HTMLDivElement>('term-input-row');
const termInput = $<HTMLInputElement>('term-input');

let settings: Settings = loadSettings();
const storage = new ProjectStorage();

const LAYOUT = {
  sidebarMin: 72,
  sidebarMax: 480,
  rightMin: 140,
  rightMax: 720,
  termMin: 72,
  termMax: 640,
  editorMin: 80,
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function applyLayout(): void {
  const root = document.documentElement;
  const sw = clamp(settings.sidebarWidth ?? 160, LAYOUT.sidebarMin, LAYOUT.sidebarMax);
  const rw = clamp(settings.rightWidth ?? 320, LAYOUT.rightMin, LAYOUT.rightMax);
  const th = clamp(settings.terminalHeight ?? 180, LAYOUT.termMin, LAYOUT.termMax);
  root.style.setProperty('--sidebar-w', `${sw}px`);
  root.style.setProperty('--right-w', `${rw}px`);
  root.style.setProperty('--term-h', `${th}px`);
}

function persistLayout(): void {
  saveSettings(settings);
}

function pointerPos(e: PointerEvent): { x: number; y: number } {
  return { x: e.clientX, y: e.clientY };
}

function bindSplitter(
  el: HTMLElement,
  onStart: () => void,
  onDelta: (dx: number, dy: number) => void,
): void {
  let dragging = false;
  let origin = { x: 0, y: 0 };
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging = true;
    origin = pointerPos(e);
    onStart();
    el.classList.add('active');
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const p = pointerPos(e);
    onDelta(p.x - origin.x, p.y - origin.y);
  });
  const end = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('active');
    try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    persistLayout();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 32 : 8;
    onStart();
    if (e.key === 'ArrowLeft') { onDelta(-step, 0); persistLayout(); e.preventDefault(); }
    if (e.key === 'ArrowRight') { onDelta(step, 0); persistLayout(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { onDelta(0, -step); persistLayout(); e.preventDefault(); }
    if (e.key === 'ArrowDown') { onDelta(0, step); persistLayout(); e.preventDefault(); }
  });
}

function syncRightSplitter(): void {
  const pane = $<HTMLElement>('right-pane');
  const split = $<HTMLElement>('split-right');
  split.hidden = pane.hidden;
}

function initLayout(): void {
  applyLayout();
  let baseSide = 160;
  let baseRight = 320;
  let baseTerm = 180;

  bindSplitter($('split-sidebar'), () => {
    baseSide = settings.sidebarWidth ?? 160;
  }, (dx) => {
    settings.sidebarWidth = clamp(baseSide + dx, LAYOUT.sidebarMin, LAYOUT.sidebarMax);
    applyLayout();
  });

  bindSplitter($('split-right'), () => {
    baseRight = settings.rightWidth ?? 320;
  }, (dx) => {
    settings.rightWidth = clamp(baseRight + dx, LAYOUT.rightMin, LAYOUT.rightMax);
    applyLayout();
  });

  bindSplitter($('split-term'), () => {
    baseTerm = settings.terminalHeight ?? 180;
  }, (_dx, dy) => {
    settings.terminalHeight = clamp(baseTerm - dy, LAYOUT.termMin, LAYOUT.termMax);
    applyLayout();
  });

  $('split-sidebar').addEventListener('dblclick', () => {
    settings.sidebarWidth = 160;
    applyLayout();
    persistLayout();
  });
  $('split-right').addEventListener('dblclick', () => {
    settings.rightWidth = 320;
    applyLayout();
    persistLayout();
  });
  $('split-term').addEventListener('dblclick', () => {
    settings.terminalHeight = 180;
    applyLayout();
    persistLayout();
  });

  syncRightSplitter();
}

interface State {
  files: Record<string, ProjectFile>;
  current: string;
  running: boolean;
  abort: AbortController | null;
  inputQueue: string[];
  inputWaiter: ((v: string) => void) | null;
  stdout: string;
  stderr: string;
  showStderr: boolean;
}

const state: State = {
  files: {},
  current: 'main.67',
  running: false,
  abort: null,
  inputQueue: [],
  inputWaiter: null,
  stdout: '',
  stderr: '',
  showStderr: false,
};

function renderTerminal(): void {
  terminal.textContent = state.showStderr ? state.stderr : state.stdout;
  terminal.classList.toggle('stderr-view', state.showStderr);
  terminal.scrollTop = terminal.scrollHeight;
}

// ---------------------------------------------------------------------------
// Default program: Hello World generated by the real encoder.
function defaultProgram(): string {
  const b = new ModuleBuilder('main');
  b.root.loadStr('Hello, World!');
  b.root.callBuiltin('print', 1);
  b.root.null();
  b.root.return();
  return moduleToStream(b.build());
}

// ---------------------------------------------------------------------------
async function boot(): Promise<void> {
  await storage.init();
  const loaded = await storage.loadAll();
  if (Object.keys(loaded).length > 0) {
    state.files = loaded;
  } else {
    state.files = {
      'main.67': { name: 'main.67', content: defaultProgram(), updated: Date.now() },
    };
    await storage.save(state.files['main.67']);
  }
  state.current = state.files['main.67'] ? 'main.67' : Object.keys(state.files)[0];
  renderFileList();
  loadFileIntoEditor(state.current);
  initLayout();
  bindUI();
  setStatus('Ready · 67 runtime', 'ok');
}

function renderFileList(): void {
  fileList.innerHTML = '';
  const names = Object.keys(state.files).sort();
  for (const name of names) {
    const li = document.createElement('li');
    if (name === state.current) li.classList.add('active');
    const label = document.createElement('span');
    label.textContent = name;
    li.appendChild(label);
    const del = document.createElement('span');
    del.className = 'del';
    del.textContent = '×';
    del.title = 'delete file';
    del.onclick = (e) => {
      e.stopPropagation();
      if (names.length <= 1) return;
      delete state.files[name];
      void storage.remove(name);
      if (state.current === name) {
        state.current = Object.keys(state.files).sort()[0];
        loadFileIntoEditor(state.current);
      }
      renderFileList();
    };
    li.appendChild(del);
    li.onclick = () => {
      saveCurrent();
      state.current = name;
      loadFileIntoEditor(name);
      renderFileList();
    };
    fileList.appendChild(li);
  }
  fileCount.textContent = `${names.length} file${names.length === 1 ? '' : 's'}`;
}

function loadFileIntoEditor(name: string): void {
  const f = state.files[name];
  if (!f) return;
  state.current = name;
  editor.value = f.content;
  editorTitle.textContent = name;
  renderGutter();
  runValidation();
}

function currentFile(): ProjectFile {
  if (!state.files[state.current]) {
    state.files[state.current] = { name: state.current, content: '', updated: Date.now() };
  }
  return state.files[state.current];
}

function saveCurrent(): void {
  const f = currentFile();
  f.content = editor.value;
  f.updated = Date.now();
  void storage.save(f);
}

function renderGutter(): void {
  const lines = softWrap(editor.value, settings.wrapWidth);
  const nums: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    nums.push(String(i * settings.wrapWidth));
  }
  gutter.textContent = nums.join('\n');
  gutter.style.fontSize = `${settings.fontSize}px`;
  editor.style.fontSize = `${settings.fontSize}px`;
}

function setStatus(msg: string, cls = ''): void {
  statusLine.innerHTML = '';
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = msg;
  statusLine.appendChild(span);
  const cursor = cursorInfo();
  if (cursor) {
    const c = document.createElement('span');
    c.textContent = cursor;
    statusLine.appendChild(c);
  }
}

function cursorInfo(): string {
  const pos = editor.selectionStart ?? 0;
  const line = Math.floor(pos / settings.wrapWidth) + 1;
  const col = (pos % settings.wrapWidth) + 1;
  return `bit ${pos} · byte ${Math.floor(pos / 8)} · Ln ${line}, Col ${col}`;
}

let validationTimer: ReturnType<typeof setTimeout> | null = null;
function runValidation(): void {
  const src = editor.value;
  editorMeta.textContent = `${src.length} symbols · ${Math.floor(src.length / 8)} bytes`;
  const result = validateSource(src, settings.wrapWidth);
  if (result.ok) {
    setStatus(`Valid module${result.diagnostics.length ? ' (warnings)' : ''} · 67 runtime`, 'ok');
  } else {
    const d = result.diagnostics[0];
    setStatus(`${d.message} — bit ${d.bitOffset}, Ln ${d.line}, Col ${d.col}`, 'err');
  }
  renderGutter();
}

editor.addEventListener('input', () => {
  if (validationTimer) clearTimeout(validationTimer);
  validationTimer = setTimeout(() => {
    saveCurrent();
    runValidation();
  }, 250);
  renderGutter();
});
editor.addEventListener('scroll', () => {
  gutter.scrollTop = editor.scrollTop;
});
editor.addEventListener('keyup', () => setStatusFromValidation());
editor.addEventListener('click', () => setStatusFromValidation());

function setStatusFromValidation(): void {
  runValidation();
}

// ---------------------------------------------------------------------------
// Running
const btnRun = $<HTMLButtonElement>('btn-run');
const btnStop = $<HTMLButtonElement>('btn-stop');

function appendOutput(text: string, stream: 'out' | 'err' = 'out'): void {
  if (stream === 'err') {
    state.stderr += text;
    setStderrBadge();
  } else {
    state.stdout += text;
  }
  renderTerminal();
}

function setStderrBadge(): void {
  const tab = $<HTMLSpanElement>('tab-stderr');
  tab.innerHTML = state.stderr ? 'stderr <span class="badge">●</span>' : 'stderr';
}

async function runProgram(): Promise<void> {
  saveCurrent();
  const src = editor.value;
  const validation = validateSource(src, settings.wrapWidth);
  if (!validation.ok) {
    appendOutput(`Compile error: ${validation.diagnostics[0].message}\n`, 'err');
    return;
  }
  // Build a project snapshot: every file currently stored.
  const files: Record<string, string> = {};
  for (const [name, f] of Object.entries(state.files)) files[name] = f.content;

  state.stdout = '';
  state.stderr = '';
  state.showStderr = false;
  renderTerminal();
  setStderrBadge();
  state.abort = new AbortController();
  state.running = true;
  btnRun.disabled = true;
  btnStop.disabled = false;
  setStatus('Running…');
  const started = performance.now();

  const result = await runProject(files, {
    entry: state.current,
    signal: state.abort.signal,
    io: {
      print: (t) => {
        appendOutput(t, 'out');
      },
      input: (prompt) => handleInput(prompt),
    },
    maxInstructions: LIMITS.maxInstructions,
    timeoutMs: LIMITS.defaultTimeoutMs,
  });

  const ms = Math.round(performance.now() - started);
  if (!result.ok && result.error) {
    appendOutput(result.error + '\n', 'err');
    setStatus(`Runtime error · ${ms} ms`, 'err');
  } else {
    setStatus(`Finished · ${ms} ms`, 'ok');
  }
  state.running = false;
  state.abort = null;
  btnRun.disabled = false;
  btnStop.disabled = true;
  termInputRow.hidden = true;
}

function handleInput(prompt: string): Promise<string> {
  appendOutput(prompt);
  termInputRow.hidden = false;
  termInput.value = '';
  termInput.focus();
  return new Promise((resolve) => {
    state.inputWaiter = (v) => {
      appendOutput(v + '\n');
      resolve(v);
    };
  });
}

termInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const v = termInput.value;
    termInputRow.hidden = true;
    state.inputWaiter?.(v);
    state.inputWaiter = null;
  }
});

// ---------------------------------------------------------------------------
// Inspector
function showInspector(): void {
  const pane = $<HTMLElement>('right-pane');
  const body = $<HTMLDivElement>('right-body');
  $<HTMLSpanElement>('right-title').textContent = 'Instruction inspector';
  pane.hidden = false;
  syncRightSplitter();
  const src = editor.value;
  try {
    const mod: Module = decodeStream(src);
    let html = `<h3>Module</h3><table>
      <tr><th>constants</th><td>${mod.constants.length}</td></tr>
      <tr><th>functions</th><td>${mod.functions.length}</td></tr>
      <tr><th>imports</th><td>${mod.imports.length}</td></tr>
      <tr><th>exports</th><td>${mod.exports.length}</td></tr></table>`;
    mod.functions.forEach((fn, i) => {
      const name = fn.nameConst !== 0xffffffff && mod.constants[fn.nameConst]?.kind === 'str'
        ? (mod.constants[fn.nameConst] as { value: string }).value
        : (i === 0 ? '<module initializer>' : `<fn#${i}>`);
      html += `<h3>function ${i}: ${escapeHtml(name)}</h3><table>
        <tr><th>params</th><td>${fn.params.length}</td><th>locals</th><td>${fn.localCount}</td></tr>
        <tr><th>code bytes</th><td>${fn.code.length}</td><th>try regions</th><td>${fn.tries.length}</td></tr></table>`;
      html += '<table><tr><th>bit</th><th>byte</th><th>opcode</th><th>operands</th><th>hex</th></tr>';
      try {
        for (const ins of disassemble(fn)) {
          html += `<tr><td class="bits">${ins.bitOffset}</td><td class="bits">${ins.offset}</td><td class="op-name">${ins.name}</td><td>${ins.operands.join(', ')}</td><td class="bits">${ins.raw}</td></tr>`;
        }
      } catch (e) {
        html += `<tr><td colspan="5" class="bits">${escapeHtml(e instanceof Error ? e.message : String(e))}</td></tr>`;
      }
      html += '</table>';
    });
    html += '<h3>Constant pool</h3><table><tr><th>#</th><th>tag</th><th>value</th></tr>';
    mod.constants.forEach((c, i) => {
      html += `<tr><td class="bits">${i}</td><td>${c.kind}</td><td>${escapeHtml(c.kind === 'str' ? c.value : String(c.kind === 'int' ? c.value : c.value))}</td></tr>`;
    });
    html += '</table>';
    body.innerHTML = html;
  } catch (e) {
    body.textContent = `Cannot inspect: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
}

// ---------------------------------------------------------------------------
// AI Builder
// ---------------------------------------------------------------------------
// AI Assistant Chat
// Model catalog for the AI Builder. `id` values are the exact API model
// identifiers expected by each provider (gemini-1.5-* and gemini-2.0-* were
// retired by Google, so they are intentionally absent).
const AI_MODELS: Record<'openai' | 'gemini', Array<{ id: string; label: string }>> = {
  openai: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol (flagship)' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra (balanced)' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna (low cost)' },
    { id: 'gpt-4o', label: 'GPT-4o (legacy)' },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini (legacy)' },
  ],
  gemini: [
    { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash (latest)' },
    { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
    { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite' },
    { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite' },
  ],
};
const DEFAULT_AI_MODEL: Record<'openai' | 'gemini', string> = {
  openai: AI_MODELS.openai[0].id,
  gemini: AI_MODELS.gemini[0].id,
};

interface ChatMessage { role: 'user' | 'ai'; content: string; }
let chatHistory: ChatMessage[] = [];

function showAIChat(): void {
  const pane = $<HTMLElement>('right-pane');
  $<HTMLSpanElement>('right-title').textContent = 'AI Assistant';
  pane.hidden = false;
  syncRightSplitter();
  
  const body = $<HTMLDivElement>('right-body');
  body.innerHTML = `
    <div style="display:flex; flex-direction:column; height:100%;">
      <div id="ai-chat-history" style="flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:8px; margin-bottom:10px; padding-right:4px;"></div>
      <div style="display:flex; flex-direction:column; gap:6px; flex-shrink:0;">
         <textarea id="ai-chat-input" placeholder="Ask AI to write code or explain..." style="width:100%; min-height:60px; background:var(--bg-input); color:var(--text); border:1px solid var(--border); padding:8px; font-family:inherit; resize:vertical;"></textarea>
         <button id="btn-ai-send" class="accent" style="padding:6px 12px; cursor:pointer;">Send</button>
      </div>
    </div>
  `;
  
  const input = $<HTMLTextAreaElement>('ai-chat-input');
  const btn = $<HTMLButtonElement>('btn-ai-send');
  
  const renderHistory = () => {
    const container = $('ai-chat-history');
    if (!container) return;
    container.innerHTML = chatHistory.length === 0 ? '<div style="color:var(--text-faint);text-align:center;margin-top:20px;">No messages yet. Ask me to write a 67 program!</div>' : chatHistory.map(m => {
        const bg = m.role === 'user' ? 'var(--bg-input)' : 'var(--bg-panel)';
        const border = m.role === 'user' ? 'var(--border)' : 'var(--ok)';
        const name = m.role === 'user' ? 'You' : 'AI';
        return `<div style="background:${bg}; border:1px solid ${border}; padding:8px; border-radius:4px;">
           <strong style="color:var(--accent)">${name}</strong>
           <pre style="white-space:pre-wrap; font-family:inherit; font-size:12px; margin:6px 0 0;">${escapeHtml(m.content)}</pre>
        </div>`;
    }).join('');
    container.scrollTop = container.scrollHeight;
  };
  
  renderHistory();
  
  btn.onclick = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.disabled = true;
    btn.disabled = true;
    
    chatHistory.push({ role: 'user', content: text });
    renderHistory();
    
    try {
      await handleAIChatRequest(text, renderHistory);
    } catch (err) {
      chatHistory.push({ role: 'ai', content: '❌ Error: ' + (err instanceof Error ? err.message : String(err)) });
      renderHistory();
    } finally {
      input.disabled = false;
      btn.disabled = false;
      input.focus();
    }
  };
  
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      btn.click();
    }
  };
}

async function handleAIChatRequest(newPrompt: string, renderCb: () => void): Promise<void> {
  const provider = settings.aiProvider || 'openai';
  // Use the saved model only if it is still offered; otherwise fall back to the
  // provider default (covers retired models persisted in old settings).
  const model = AI_MODELS[provider].some((m) => m.id === settings.aiModel)
    ? (settings.aiModel as string)
    : DEFAULT_AI_MODEL[provider];
  
  if (provider === 'openai' && !settings.openaiKey) throw new Error('OpenAI API key missing in Settings.');
  if (provider === 'gemini' && !settings.geminiKey) throw new Error('Gemini API key missing in Settings.');
  
  const systemPrompt = "You are an expert compiler engineer and AI assistant for the '67' esoteric language workstation.\n" +
  "The user is working in an editor that accepts ONLY pure binary 6/7 streams. YOU CANNOT OUTPUT BINARY.\n" +
  "Instead, when asked to write or modify code, you must output a complete Javascript script using the `ModuleBuilder` API, enclosed in a ```javascript code block.\n" +
  "The workstation will automatically extract, execute, and compile your script, replacing the user's active file with the resulting binary stream.\n" +
  "DO NOT call builder.build() or try to export. The host does this.\n" +
  "API usage example:\n" +
  "builder.root.loadStr('Hello!');\n" +
  "builder.root.callBuiltin('print', 1);\n" +
  "builder.root.null();\n" +
  "builder.root.return();\n" +
  "Available builtins: print, write, input, typeof, toString, toNumber, toInt, toFloat, length, to67, from67, binary, decimal, abs, min, max, sqrt, floor, ceil, round, random, pow, push, pop, shift, join, slice, indexOf, includes, reverse, map, filter, reduce, upper, lower, split, repeat, startsWith, endsWith, contains, charCode, fromCharCode, trim, keys, values, has, assert, assertEq, error, isInt, array\n" +
  "Root instructions: constInt(bigint), constStr(string), constFloat(number), loadInt(bigint), loadStr(string), loadFloat(number), loadConst(idx), true(), false(), null(), local(name), slot(name), loadLocal(name), storeLocal(name), add(), sub(), mul(), div(), mod(), pow(), bitAnd(), bitOr(), bitXor(), shl(), shr(), ushr(), eq(), notEq(), lt(), lte(), gt(), gte(), not(), neg(), bitNot(), jumpIfFalse(label), jumpIfTrue(label), jump(label), label(name), callBuiltin(name, argCount), return()";
  
  let aiResponse = '';
  
  if (provider === 'openai') {
    const messages = [{ role: 'system', content: systemPrompt }];
    for (const m of chatHistory) {
      if (m.content === newPrompt && m.role === 'user' && m === chatHistory[chatHistory.length - 1]) continue;
      messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content });
    }
    messages.push({ role: 'user', content: newPrompt });
    
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + settings.openaiKey },
      body: JSON.stringify({ model, messages, temperature: 0.2 })
    });
    if (!res.ok) throw new Error((await res.json()).error?.message || res.statusText);
    aiResponse = (await res.json()).choices[0].message.content.trim();
  } else {
    const contents = [];
    for (const m of chatHistory) {
      if (m.content === newPrompt && m.role === 'user' && m === chatHistory[chatHistory.length - 1]) continue;
      contents.push({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] });
    }
    contents.push({ role: 'user', parts: [{ text: newPrompt }] });
    
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.geminiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: { text: systemPrompt } },
        contents,
        generationConfig: { temperature: 0.2 }
      })
    });
    if (!res.ok) throw new Error((await res.json()).error?.message || res.statusText);
    const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    aiResponse = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    if (!aiResponse) throw new Error('Gemini returned an empty response.');
  }
  
  const codeMatch = aiResponse.match(/```(?:javascript|js|typescript|ts)?\n([\s\S]*?)```/);
  if (codeMatch) {
    const code = codeMatch[1].trim();
    try {
      const builder = new ModuleBuilder(state.current.replace('.67', ''));
      const runAI = new Function('builder', code);
      runAI(builder);
      const stream = moduleToStream(builder.build());
      
      editor.value = stream;
      saveCurrent();
      runValidation();
      renderGutter();
      
      chatHistory.push({ role: 'ai', content: aiResponse + '\n\n✅ Applied compiled binary to active file.' });
    } catch (e) {
      chatHistory.push({ role: 'ai', content: aiResponse + '\n\n❌ Compiler error while applying: ' + (e instanceof Error ? e.message : String(e)) });
    }
  } else {
    chatHistory.push({ role: 'ai', content: aiResponse });
  }
  
  renderCb();
}

const overlay = $<HTMLDivElement>('modal-overlay');
function openModal(title: string, bodyHtml: string): void {
  $<HTMLSpanElement>('modal-title').textContent = title;
  $<HTMLDivElement>('modal-body').innerHTML = bodyHtml;
  overlay.hidden = false;
}
function closeModal(): void {
  overlay.hidden = true;
}

function showExamples(): void {
  const items = (examplesManifest as Array<{ id: string; title: string; level: string; description: string; output: string }>)
    .map(
      (e) =>
        `<button class="example-item" data-id="${e.id}">
          <span class="lvl">${e.level}</span>
          <span class="t">${escapeHtml(e.title)}</span>
          <div class="d">${escapeHtml(e.description)} — outputs ${escapeHtml(JSON.stringify(e.output.trim()))}</div>
        </button>`,
    )
    .join('');
  openModal('Examples (binary source, encoded by the real compiler)', items + noteAboutModules());
  document.querySelectorAll<HTMLButtonElement>('.example-item').forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.id!;
      void loadExample(id);
      closeModal();
    };
  });
}

function noteAboutModules(): string {
  return `<div class="d" style="margin-top:10px;color:var(--text-faint)">
    The module example ships as two files: module-main.67 and module-mathlib.67.
    Use Import to load both, then open module-main.67 and press Run.
  </div>`;
}

async function loadExample(id: string): Promise<void> {
  const res = await fetch(`./examples/${id}.67`);
  const content = await res.text();
  const name = id === 'hello-world' ? 'main.67' : `${id}.67`;
  state.files[name] = { name, content: content.trim(), updated: Date.now() };
  await storage.save(state.files[name]);
  renderFileList();
  loadFileIntoEditor(name);
}

function showDocs(): void {
  const pane = $<HTMLElement>('right-pane');
  $<HTMLSpanElement>('right-title').textContent = 'Docs';
  pane.hidden = false;
  syncRightSplitter();
  $<HTMLDivElement>('right-body').innerHTML = `<div class="doc">${DOCS_HTML}</div>`;
}

function showSettings(): void {
  openModal(
    'Settings',
    `<label style="display:block;margin:8px 0">Visual wrap width (symbols per line)
      <input id="set-wrap" type="number" min="16" max="256" value="${settings.wrapWidth}" style="width:80px;margin-left:8px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);padding:3px 6px"/>
    </label>
    <label style="display:block;margin:8px 0">Editor font size (px)
      <input id="set-font" type="number" min="10" max="24" value="${settings.fontSize}" style="width:80px;margin-left:8px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);padding:3px 6px"/>
    </label>
    <div style="margin:8px 0;border-top:1px solid var(--border);padding-top:8px">
      <div style="color:var(--text-dim);margin-bottom:6px">Panel sizes (drag the bars between panes, or set here)</div>
      <label style="display:block;margin-bottom:6px">Files width
        <input id="set-side" type="number" min="${LAYOUT.sidebarMin}" max="${LAYOUT.sidebarMax}" value="${settings.sidebarWidth ?? 160}" style="width:80px;margin-left:8px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);padding:3px 6px"/>
      </label>
      <label style="display:block;margin-bottom:6px">Inspector width
        <input id="set-right" type="number" min="${LAYOUT.rightMin}" max="${LAYOUT.rightMax}" value="${settings.rightWidth ?? 320}" style="width:80px;margin-left:8px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);padding:3px 6px"/>
      </label>
      <label style="display:block;margin-bottom:6px">Terminal height
        <input id="set-term" type="number" min="${LAYOUT.termMin}" max="${LAYOUT.termMax}" value="${settings.terminalHeight ?? 180}" style="width:80px;margin-left:8px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);padding:3px 6px"/>
      </label>
      <button type="button" id="set-layout-reset">Reset layout</button>
    </div>
    <div style="margin:8px 0;border-top:1px solid var(--border);padding-top:8px">
      <label style="display:block;margin-bottom:6px">AI Provider
        <select id="set-provider" style="margin-left:8px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);padding:3px 6px">
          <option value="openai" ${settings.aiProvider === 'openai' ? 'selected' : ''}>OpenAI</option>
          <option value="gemini" ${settings.aiProvider === 'gemini' ? 'selected' : ''}>Gemini</option>
        </select>
      </label>
      <label style="display:block;margin-bottom:6px">AI Model
        <select id="set-model" style="margin-left:8px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);padding:3px 6px"></select>
      </label>
      <label style="display:block;margin-bottom:6px">OpenAI API Key
        <input id="set-openai" type="password" placeholder="sk-..." value="${settings.openaiKey || ''}" style="width:100%;margin-top:4px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);padding:4px 6px"/>
      </label>
      <label style="display:block;margin-bottom:6px">Gemini API Key
        <input id="set-gemini" type="password" placeholder="AIzaSy..." value="${settings.geminiKey || ''}" style="width:100%;margin-top:4px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);padding:4px 6px"/>
      </label>
    </div>
    <div class="d" style="color:var(--text-faint);margin-top:12px">
      Runtime limits: ${LIMITS.maxInstructions.toLocaleString()} instructions,
      ${LIMITS.maxCallDepth} call depth,
      ${(LIMITS.maxOutputBytes / 1024).toFixed(0)} KiB output cap.
    </div>`,
  );
  
  $<HTMLInputElement>('set-wrap').oninput = (e) => {
    settings.wrapWidth = Number((e.target as HTMLInputElement).value) || 64;
    saveSettings(settings);
    renderGutter();
    runValidation();
  };
  $<HTMLInputElement>('set-font').oninput = (e) => {
    settings.fontSize = Number((e.target as HTMLInputElement).value) || 14;
    saveSettings(settings);
    renderGutter();
  };
  $<HTMLInputElement>('set-side').oninput = (e) => {
    settings.sidebarWidth = clamp(Number((e.target as HTMLInputElement).value) || 160, LAYOUT.sidebarMin, LAYOUT.sidebarMax);
    applyLayout();
    persistLayout();
  };
  $<HTMLInputElement>('set-right').oninput = (e) => {
    settings.rightWidth = clamp(Number((e.target as HTMLInputElement).value) || 320, LAYOUT.rightMin, LAYOUT.rightMax);
    applyLayout();
    persistLayout();
  };
  $<HTMLInputElement>('set-term').oninput = (e) => {
    settings.terminalHeight = clamp(Number((e.target as HTMLInputElement).value) || 180, LAYOUT.termMin, LAYOUT.termMax);
    applyLayout();
    persistLayout();
  };
  $<HTMLButtonElement>('set-layout-reset').onclick = () => {
    settings.sidebarWidth = 160;
    settings.rightWidth = 320;
    settings.terminalHeight = 180;
    applyLayout();
    persistLayout();
    $<HTMLInputElement>('set-side').value = '160';
    $<HTMLInputElement>('set-right').value = '320';
    $<HTMLInputElement>('set-term').value = '180';
  };
  
  const updateModels = () => {
    const prov = $<HTMLSelectElement>('set-provider').value as 'openai' | 'gemini';
    const mod = $<HTMLSelectElement>('set-model');
    mod.innerHTML = '';
    const opts = AI_MODELS[prov];
    opts.forEach(({ id, label }) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = label;
      if (settings.aiModel === id) opt.selected = true;
      mod.appendChild(opt);
    });
    if (!opts.some((o) => o.id === settings.aiModel)) {
      settings.aiModel = DEFAULT_AI_MODEL[prov];
      saveSettings(settings);
    }
  };
  
  $<HTMLSelectElement>('set-provider').onchange = (e) => {
    settings.aiProvider = (e.target as HTMLSelectElement).value as 'openai' | 'gemini';
    saveSettings(settings);
    updateModels();
  };
  
  $<HTMLSelectElement>('set-model').onchange = (e) => {
    settings.aiModel = (e.target as HTMLSelectElement).value;
    saveSettings(settings);
  };
  
  updateModels();

  $<HTMLInputElement>('set-openai').oninput = (e) => {
    settings.openaiKey = (e.target as HTMLInputElement).value.trim();
    saveSettings(settings);
  };
  $<HTMLInputElement>('set-gemini').oninput = (e) => {
    settings.geminiKey = (e.target as HTMLInputElement).value.trim();
    saveSettings(settings);
  };
}

// ---------------------------------------------------------------------------
// File import / export / download
const fileInput = $<HTMLInputElement>('file-input');

function newFile(): void {
  const name = prompt('New file name (must end in .67):', 'untitled.67');
  if (!name) return;
  const fname = name.endsWith('.67') ? name : name + '.67';
  state.files[fname] = { name: fname, content: '', updated: Date.now() };
  void storage.save(state.files[fname]);
  renderFileList();
  loadFileIntoEditor(fname);
}

function downloadFile(): void {
  saveCurrent();
  const blob = new Blob([editor.value], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = state.current;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportProject(): void {
  saveCurrent();
  const files = Object.values(state.files);
  const blob = new Blob([JSON.stringify({ version: 1, files }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '67-project.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

fileInput.addEventListener('change', async () => {
  const files = Array.from(fileInput.files ?? []);
  for (const file of files) {
    const text = await file.text();
    if (file.name.endsWith('.json')) {
      try {
        const imported = await storage.importProject(text);
        for (const f of imported) {
          state.files[f.name] = f;
          await storage.save(f);
        }
      } catch (e) {
        appendOutput(`Import failed: ${e instanceof Error ? e.message : String(e)}\n`, 'err');
      }
    } else {
      const name = file.name.endsWith('.67') ? file.name : file.name + '.67';
      const content = text.trim();
      state.files[name] = { name, content, updated: Date.now() };
      await storage.save(state.files[name]);
    }
  }
  renderFileList();
  loadFileIntoEditor(state.current);
  fileInput.value = '';
});

// ---------------------------------------------------------------------------
// Search / replace + keyboard shortcuts
function openSearch(): void {
  const needle = prompt('Find (6/7 sequence):');
  if (needle === null) return;
  const idx = editor.value.indexOf(needle, (editor.selectionEnd ?? 0));
  if (idx === -1) {
    setStatus(`No match for ${JSON.stringify(needle)}`, 'err');
    return;
  }
  editor.focus();
  editor.setSelectionRange(idx, idx + needle.length);
  const replace = prompt('Replace with? (leave empty to just find)', '');
  if (replace !== null && replace !== '') {
    editor.setRangeText(replace, idx, idx + needle.length, 'select');
    saveCurrent();
    runValidation();
  }
}

function bindUI(): void {
  btnRun.onclick = () => void runProgram();
  btnStop.onclick = () => state.abort?.abort();
  $<HTMLButtonElement>('btn-save').onclick = () => {
    saveCurrent();
    setStatus('Saved', 'ok');
  };
  $<HTMLButtonElement>('btn-new').onclick = newFile;
  $<HTMLButtonElement>('btn-add-file').onclick = newFile;
  $<HTMLButtonElement>('btn-import').onclick = () => fileInput.click();
  $<HTMLButtonElement>('btn-export').onclick = exportProject;
  $<HTMLButtonElement>('btn-download').onclick = downloadFile;
  $<HTMLButtonElement>('btn-examples').onclick = showExamples;
  $<HTMLButtonElement>('btn-ai').onclick = showAIChat;
  $<HTMLButtonElement>('btn-inspect').onclick = showInspector;
  $<HTMLButtonElement>('btn-docs').onclick = showDocs;
  $<HTMLButtonElement>('btn-settings').onclick = showSettings;
  $<HTMLButtonElement>('btn-close-right').onclick = () => {
    $<HTMLElement>('right-pane').hidden = true;
    syncRightSplitter();
  };
  $<HTMLButtonElement>('modal-close').onclick = closeModal;
  overlay.onclick = (e) => {
    if (e.target === overlay) closeModal();
  };
  $<HTMLButtonElement>('btn-clear-term').onclick = () => {
    state.stdout = '';
    state.stderr = '';
    renderTerminal();
    setStderrBadge();
  };
  $<HTMLSpanElement>('tab-stdout').onclick = () => {
    state.showStderr = false;
    renderTerminal();
    $<HTMLSpanElement>('tab-stdout').classList.add('active');
    $<HTMLSpanElement>('tab-stderr').classList.remove('active');
  };
  $<HTMLSpanElement>('tab-stderr').onclick = () => {
    state.showStderr = true;
    renderTerminal();
    $<HTMLSpanElement>('tab-stderr').classList.add('active');
    $<HTMLSpanElement>('tab-stdout').classList.remove('active');
  };

  editor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void runProgram();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveCurrent();
      setStatus('Saved', 'ok');
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      openSearch();
    } else if (e.key === 'Tab') {
      // Tab moves focus by default; inserting bits is left to the palette.
    }
  });
}

void boot();

// Referenced so OP_SPEC is available in the bundle for future inspector use.
void OP_SPEC;
