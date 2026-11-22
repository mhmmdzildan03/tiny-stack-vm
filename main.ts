// tiny-stack-vm: an exact interpreter for make.fun's tiny stack ISA.
// For every <id> in the input dir it runs program.bin on input.bin and
// writes stdout.bin (the bytes emitted) and exit.txt (the exit code).
// Points live in the details: wrapping 32-bit values (MUL via imul),
// signed DIV/MOD truncating toward zero, INT_MIN/-1 and x % -1, the
// unsigned DIVU/MODU/LTU, 5-bit shift counts, arithmetic vs logical
// right shift, PUSH8 sign extension, and signed jump offsets.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Per-opcode tables, indexed by opcode byte (0x00..0x53): immediate
// length ('x' = no such opcode), values popped, values pushed. Stack
// accounting uses them before an instruction's own traps or effect,
// so an underflowing DIV is trap 2, not 4, and a push onto a full
// stack is trap 3 even when the push itself would be harmless.
const IMM = '01400000' + 'xxxxxxxx' + '00000000' + '0000000x' +
  '000xxxxx' + 'xxxxxxxx' + '22220xxx' + 'xxxxxxxx' + '00xxxxxx' +
  'xxxxxxxx' + '0000';
const POPS = '000112230000000022222221222122202220000000000000011000000000' +
  '000012000000000000001101';
const PUSH = '011022330000000011111111111111101110000000000000000000000000' +
  '000010000000000000000010';

// Runs one program; returns its output and exit code: 0 for HALT, the
// low byte for EXIT, else the trap code (underflow 2, overflow 3, div
// by zero 4, bad opcode 5, bad address 6, call depth 7, empty RET 8,
// bad pc or cut-off immediate 9, step limit 10, output limit 11).
function run(p: Uint8Array, inp: Uint8Array): { out: Uint8Array; code: number } {
  const st = new Int32Array(256), calls = new Int32Array(64);
  const mem = new Int32Array(256), buf = new Uint8Array(65536);
  let sp = 0, csp = 0, olen = 0, ipos = 0, pc = 0, steps = 0;
  const n = p.length;
  const done = (code: number) => ({ out: buf.slice(0, olen), code });
  for (;;) {
    if (steps >= 1_000_000) return done(10);
    if (pc < 0 || pc >= n) return done(9);
    const op = p[pc];
    if (op > 0x53 || IMM[op] === 'x') return done(5);
    const imm = IMM.charCodeAt(op) - 48;
    if (pc + imm >= n) return done(9);
    steps++;
    const next = pc + 1 + imm;
    if (sp < POPS.charCodeAt(op) - 48) return done(2);
    if (sp - (POPS.charCodeAt(op) - 48) + (PUSH.charCodeAt(op) - 48) > 256) return done(3);
    pc = next;
    switch (op) {
      case 0x00: return done(0); // HALT
      case 0x01: st[sp++] = (p[next - 1] << 24) >> 24; break; // PUSH8
      case 0x02: // PUSH32, little-endian
        st[sp++] = p[next - 4] | (p[next - 3] << 8) |
          (p[next - 2] << 16) | (p[next - 1] << 24); break;
      case 0x03: sp--; break; // POP
      case 0x04: st[sp] = st[sp - 1]; sp++; break; // DUP
      case 0x05: { const t = st[sp - 1]; st[sp - 1] = st[sp - 2]; st[sp - 2] = t; break; }
      case 0x06: st[sp] = st[sp - 2]; sp++; break; // OVER
      case 0x07: { // ROT ( a b c -- b c a )
        const a = st[sp - 3];
        st[sp - 3] = st[sp - 2]; st[sp - 2] = st[sp - 1]; st[sp - 1] = a; break; }
      case 0x17: st[sp - 1] = (-st[sp - 1]) | 0; break; // NEG, wraps
      case 0x1b: st[sp - 1] = ~st[sp - 1]; break; // NOT
      case 0x30: case 0x31: case 0x32: { // JMP, JZ, JNZ
        const rel = ((p[next - 2] | (p[next - 1] << 8)) << 16) >> 16;
        let take = op === 0x30;
        if (!take) { const v = st[--sp]; take = op === 0x31 ? v === 0 : v !== 0; }
        if (take) pc = next + rel; // target itself checked next step
        break; }
      case 0x33: // CALL, unsigned absolute target
        if (csp >= 64) return done(7);
        calls[csp++] = next; pc = p[next - 2] | (p[next - 1] << 8); break;
      case 0x34: // RET
        if (csp === 0) return done(8);
        pc = calls[--csp]; break;
      case 0x40: { // LOAD
        const a = st[sp - 1];
        if (a < 0 || a > 255) return done(6);
        st[sp - 1] = mem[a]; break; }
      case 0x41: { // STORE ( v addr -- )
        const a = st[sp - 1];
        if (a < 0 || a > 255) return done(6);
        mem[a] = st[sp - 2]; sp -= 2; break; }
      case 0x50: { // PRINT, decimal ASCII only
        const s = String(st[sp - 1]);
        if (olen + s.length > 65536) return done(11);
        sp--;
        for (let i = 0; i < s.length; i++) buf[olen++] = s.charCodeAt(i);
        break; }
      case 0x51: // PUTC
        if (olen + 1 > 65536) return done(11);
        buf[olen++] = st[--sp] & 255; break;
      case 0x52: // IN, -1 once input is used up
        st[sp++] = ipos < inp.length ? inp[ipos++] : -1; break;
      case 0x53: return done(st[--sp] & 255); // EXIT
      default: { // binary operators; b on top, a below
        const b = st[sp - 1], a = st[sp - 2];
        let r: number;
        if (op === 0x10) r = (a + b) | 0;
        else if (op === 0x11) r = (a - b) | 0;
        else if (op === 0x12) r = Math.imul(a, b);
        else if (op === 0x13) { // DIV
          if (b === 0) return done(4);
          r = a === -2147483648 && b === -1 ? a : Math.trunc(a / b); }
        else if (op === 0x14) { // MOD, sign of a
          if (b === 0) return done(4);
          r = b === -1 ? 0 : a % b; }
        else if (op === 0x15) { // DIVU
          if (b === 0) return done(4);
          r = Math.floor((a >>> 0) / (b >>> 0)) | 0; }
        else if (op === 0x16) { // MODU
          if (b === 0) return done(4);
          r = ((a >>> 0) % (b >>> 0)) | 0; }
        else if (op === 0x18) r = a & b;
        else if (op === 0x19) r = a | b;
        else if (op === 0x1a) r = a ^ b;
        else if (op === 0x1c) r = a << (b & 31);
        else if (op === 0x1d) r = a >> (b & 31);
        else if (op === 0x1e) r = (a >>> (b & 31)) | 0;
        else if (op === 0x20) r = a === b ? 1 : 0;
        else if (op === 0x21) r = a < b ? 1 : 0;
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU
        sp--; st[sp - 1] = r | 0; break; }
    }
  }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const r = run(new Uint8Array(readFileSync(join(I, id, 'program.bin'))),
    new Uint8Array(readFileSync(join(I, id, 'input.bin'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), r.out);
  writeFileSync(join(O, id, 'exit.txt'), `${r.code}\n`);
}
