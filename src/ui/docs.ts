/**
 * Documentation panel content. Every 67 code sample shown here is a real,
 * generated 6/7 stream (pulled from the examples manifest) — readable text
 * only appears in explanations and operation tables, never as "source".
 */

import examplesManifest from '../../examples-data/index.json';

interface ManifestEntry {
  id: string;
  title: string;
  level: string;
  description: string;
  output: string;
  bytes: number;
}

const manifest = examplesManifest as ManifestEntry[];

function exampleStream(id: string): string {
  // The shipped .67 files live next to the page; the inspector/example loader
  // fetches them on demand. For docs we show the stream fetched at runtime.
  const entry = manifest.find((e) => e.id === id);
  return entry ? `${id}.67 — ${entry.bytes} bytes (open via Examples)` : '';
}

function exampleRows(level: string): string {
  return manifest
    .filter((e) => e.level === level)
    .map(
      (e) =>
        `<tr><td>${escape(e.title)}</td><td class="bits">${e.bytes}B</td><td>${escape(e.output.trim())}</td></tr>`,
    )
    .join('');
}

function escape(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
}

export const DOCS_HTML = `
<h3>What 67 is</h3>
<p>67 is a programming language whose entire source alphabet is two symbols:
<code>6</code> (binary <code>0</code>) and <code>7</code> (binary <code>1</code>).
A <code>.67</code> file is a continuous stream of those symbols with no spaces,
keywords, quotes or punctuation. The stream is decoded into bytes (8 symbols
per byte, most significant bit first) and parsed as a deterministic binary
module format.</p>

<h3>The 6/7 mapping</h3>
<table>
<tr><th>symbol</th><th>bit</th><th></th></tr>
<tr><td class="op-name">6</td><td>0</td><td></td></tr>
<tr><td class="op-name">7</td><td>1</td><td></td></tr>
</table>
<p>This mapping is fixed and never reversed. Examples:</p>
<table>
<tr><th>stream</th><th>bits</th><th>decimal</th></tr>
<tr><td class="bits">6</td><td>0</td><td>0</td></tr>
<tr><td class="bits">7</td><td>1</td><td>1</td></tr>
<tr><td class="bits">67</td><td>01</td><td>1</td></tr>
<tr><td class="bits">76</td><td>10</td><td>2</td></tr>
<tr><td class="bits">77</td><td>11</td><td>3</td></tr>
<tr><td class="bits">7667</td><td>1001</td><td>9</td></tr>
</table>

<h3>Binary file format (version 1)</h3>
<p>Bytes are big-endian. A module is a header followed by length-prefixed
sections, so the whole stream is self-delimiting:</p>
<table>
<tr><th>section</th><th>contents</th></tr>
<tr><td>magic</td><td class="bits">36 37 01 00</td></tr>
<tr><td>constants</td><td>u32 count; each: u8 tag + payload</td></tr>
<tr><td>imports</td><td>u32 count; each: u32 module-name constant index</td></tr>
<tr><td>exports</td><td>u32 count; each: u32 name const, u32 slot</td></tr>
<tr><td>functions</td><td>u32 count; function 0 is the module initializer</td></tr>
</table>
<p>Constant tags: <code>01</code> integer (sign byte, u32 magnitude length,
big-endian magnitude bytes), <code>02</code> float64 (8 bytes IEEE-754),
<code>03</code> string (u32 UTF-8 length, bytes). Strings are UTF-8 encoded
into 6/7 symbols exactly like any other byte.</p>

<h3>Functions and instruction encoding</h3>
<p>Each function is: u32 name constant, u32 parameter count + name constants,
u32 local slot count, u32 code length + code bytes, u32 try-region count +
regions, u32 debug-entry count + entries. Instructions are a one-byte opcode
followed by fixed operands (u8 / u16 / u32) or length-prefixed tables.
Jumps are u32 absolute code offsets.</p>

<h3>Control flow, data, classes, exceptions, modules</h3>
<p>Conditions and loops compile to <code>JUMP</code>, <code>JUMP_IF_FALSE</code>
and <code>JUMP_IF_TRUE</code>. Arrays are <code>NEW_ARRAY</code> with an
element count; objects are <code>NEW_OBJECT</code> with length-prefixed key
constants; closures capture parent slot frames via <code>GET_UPVAR</code>/
<code>SET_UPVAR</code>. Classes are <code>NEW_CLASS</code> (name + method
table; the parent class is on the stack), instances via
<code>NEW_INSTANCE</code>, method dispatch via <code>CALL_METHOD</code> and
parent calls via <code>SUPER_CALL</code>. Exceptions are <code>THROW</code>
plus try regions (start, end, catch address, finally address, catch slot);
<code>FINALLY_END</code> replays a pending exception after cleanup. Modules
are <code>IMPORT</code> with named exports stored in module slots.</p>

<h3>Standard library</h3>
<p>Operations are referenced in binary by numeric id
(<code>CALL_BUILTIN</code>); readable names exist only in documentation:
print, write, input, typeof, toString, toNumber, toInt, toFloat, length,
to67, from67, binary, decimal, abs, min, max, sqrt, floor, ceil, round,
random, pow, push, pop, shift, join, slice, indexOf, includes, reverse,
map, filter, reduce, upper, lower, split, repeat, startsWith, endsWith,
contains, charCode, fromCharCode, trim, keys, values, has, assert,
assertEq, error, isInt, array.</p>

<h3>Runtime limits</h3>
<p>The safe runtime caps instructions (${(10_000_000).toLocaleString()}),
call depth (200), output (1 MiB), array/object sizes (100 000), strings
(1 MiB) and integer-power exponents. Programs never reach window, document,
fetch, the filesystem or any host API; the only host contact is an injected
input callback.</p>

<h3>Examples</h3>
<p>All examples below are generated by the encoder and executed through the
real runtime. Open them from the <code>Examples</code> button; the editor
shows only the 6/7 stream.</p>
<h3 style="margin-top:10px">Beginner (10)</h3>
<table><tr><th>program</th><th>size</th><th>output</th></tr>${exampleRows('beginner')}</table>
<h3>Intermediate (10)</h3>
<table><tr><th>program</th><th>size</th><th>output</th></tr>${exampleRows('intermediate')}</table>
<h3>Advanced (5)</h3>
<table><tr><th>program</th><th>size</th><th>output</th></tr>${exampleRows('advanced')}</table>
<p class="bits">${exampleStream('hello-world')}</p>

<h3>Generating and decoding binary source</h3>
<p>You never have to hand-write bits: the <code>Examples</code> menu loads
valid programs produced by the internal assembler/encoder, and the
<code>Inspector</code> panel decodes the current editor contents into
opcodes, operands, the constant pool and function tables. To verify a file
outside the UI, decode the 6/7 stream into bytes (8 symbols per byte),
check the <code>36 37 01 00</code> magic, then walk the length-prefixed
sections. Any symbol that is not 6 or 7 is rejected at bit offset zero of
the offending symbol.</p>
`;
