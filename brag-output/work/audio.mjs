// Synthesises the 40s soundtrack + voiceover: 120 BPM, D major, music and SFX on one beat grid.
import fs from 'fs';
const SR = 48000, DUR = 40, N = SR * DUR, BEAT = 0.5;
const L = new Float32Array(N), R = new Float32Array(N);
const busRev = new Float32Array(N);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;

function add(t0, len, fn, gain, pan = 0, rev = 0.2) {
  const s0 = Math.floor(t0 * SR), n = Math.floor(len * SR);
  const gl = gain * Math.cos((pan + 1) * Math.PI / 4), gr = gain * Math.sin((pan + 1) * Math.PI / 4);
  for (let i = 0; i < n && s0 + i < N; i++) {
    if (s0 + i < 0) continue;
    const v = fn(i / SR);
    L[s0 + i] += v * gl; R[s0 + i] += v * gr; busRev[s0 + i] += v * gain * rev;
  }
}
const env = (t, a, d) => Math.min(1, t / a) * Math.exp(-t / d);

// Chords per bar (2s): D, Bm, G, A, D, Bm, G, A, G, D
const D=[50,57,62,66,69],Bm=[47,54,62,66,71],G=[43,55,59,62,67],A=[45,57,61,64,69];
const chords = [D,Bm,G,A,D,Bm,G,A,D,Bm,G,A,D,Bm,G,A,G,A,D,D];

// pad
chords.forEach((ch, bar) => {
  const len = bar === 19 ? 2.0 : 2.15;
  ch.slice(1).forEach((m, k) => {
    const f = mtof(m + 12 * 0);
    add(bar * 2, len, (t) => {
      const a = Math.min(1, t / 0.35) * Math.min(1, (len - t) / 0.3);
      return a * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * f * 2.003 * t) + 0.15 * Math.sin(2 * Math.PI * f * 0.997 * t + 1));
    }, 0.05, (k - 1.5) * 0.35, 0.5);
  });
});

// bell arpeggio: 8th notes
for (let i = 0; i < 80 * 2 - 2; i++) {
  const t = i * BEAT / 2, bar = Math.floor(t / 2), ch = chords[bar];
  const pattern = [2, 3, 4, 3, 2, 4, 3, 4];
  const m = ch[pattern[i % 8]] + 12;
  const f = mtof(m), g = i % 2 ? 0.065 : 0.095;
  add(t, 1.2, (u) => env(u, 0.004, 0.35) * (Math.sin(2 * Math.PI * f * u) + 0.25 * Math.sin(2 * Math.PI * f * 3.01 * u) * Math.exp(-u * 8)), g * (t < 4 ? 0.8 : 1), (i % 4 - 1.5) * 0.25, 0.45);
}
// final bell resolve
[74, 78, 81, 86].forEach((m, k) => add(36 + k * 0.5, 4 - k * 0.5, (u) => env(u, 0.004, 0.9) * Math.sin(2 * Math.PI * mtof(m) * u), 0.06, (k - 1.5) * 0.3, 0.6));

// drums & bass from 4.0 to 18.0, then a soft final hit
for (let b = 8; b < 72; b++) {
  const t = b * BEAT;
  if (b % 2 === 0) add(t, 0.4, (u) => Math.sin(2 * Math.PI * (45 + 90 * Math.exp(-u * 30)) * u) * Math.exp(-u * 9), 0.22, 0, 0.05);
  if (b % 4 === 2) add(t, 0.25, (u) => rnd() * Math.exp(-u * 22) * 0.6 + Math.sin(2 * Math.PI * 190 * u) * Math.exp(-u * 30) * 0.4, 0.07, 0.05, 0.4);
  for (const off of [0.25]) add(t + off, 0.06, (u) => rnd() * Math.exp(-u * 70), 0.022, 0.3, 0.1);
  const root = chords[Math.floor(t / 2)][0] - 12;
  add(t, BEAT * 0.95, (u) => Math.sin(2 * Math.PI * mtof(root) * u) * Math.min(1, u / 0.01) * Math.exp(-u * 2.5), 0.16, 0, 0);
}
add(36, 4, (u) => Math.sin(2 * Math.PI * (45 + 80 * Math.exp(-u * 30)) * u) * Math.exp(-u * 5), 0.25, 0, 0.1);
add(36, 4, (u) => Math.sin(2 * Math.PI * mtof(38) * u) * Math.min(1, u / 0.01) * Math.exp(-u * 1.2), 0.15, 0, 0);

// SFX
const pen = (t0, len) => { let lp = 0; add(t0, len, (u) => { lp += 0.25 * (rnd() - lp); return lp * (0.6 + 0.4 * Math.sin(u * 40)) * Math.min(1, u / 0.05, (len - u) / 0.1); }, 0.05, -0.1, 0.2); };
pen(0.1, 1.25); pen(15.25, 1.5);
const swell = (tEnd) => { let lp = 0; add(tEnd - 0.6, 0.6, (u) => { lp += 0.08 * (rnd() - lp); return lp * Math.pow(u / 0.6, 2); }, 0.11, 0, 0.5); };
[4, 8, 14.5, 20, 25, 31, 35.5].forEach(swell);
const chime = (t, ms) => ms.forEach((m, k) => add(t + k * 0.06, 1.5, (u) => env(u, 0.003, 0.5) * Math.sin(2 * Math.PI * mtof(m) * u), 0.05, 0.2, 0.6));
const tick = (t) => add(t, 0.03, (u) => Math.sin(2 * Math.PI * 2349 * u) * Math.exp(-u * 200), 0.03, 0.3, 0.15);
for (let d = 0; d < 6; d++) tick(10.0 + d * 0.125);
const click = (t) => add(t, 0.04, (u) => (rnd() * 0.5 + Math.sin(2 * Math.PI * 1175 * u)) * Math.exp(-u * 150), 0.06, 0.2, 0.1);
click(11.5); chime(11.75, [81, 86]);
click(17.25); click(18.0); chime(18.5, [78, 81, 86]);
for (let r = 0; r < 12; r++) tick(21.0 + r * 0.125);
add(22.5, 0.5, (u) => Math.sin(2 * Math.PI * (60 + 60 * Math.exp(-u * 25)) * u) * Math.exp(-u * 10), 0.22, 0, 0.3); chime(22.5, [74, 81]);
add(26.0, 0.5, (u) => Math.sin(2 * Math.PI * (60 + 60 * Math.exp(-u * 25)) * u) * Math.exp(-u * 10), 0.3, 0, 0.3); chime(26.0, [74, 81]);
chime(27.5, [86, 90]);
click(32.5); chime(33.0, [81, 86]); [33.5, 34.0, 34.5].forEach(tick);
click(38.0);
add(4.0, 1.5, (u) => Math.sin(2 * Math.PI * mtof(38) * u) * Math.exp(-u * 3), 0.18, 0, 0.2);

// voiceover: one line per scene, music ducks under each line
const VO = [[0.4, 1], [4.4, 2], [8.5, 3], [15.0, 4], [20.5, 5], [25.5, 6], [31.5, 7], [36.0, 8]];
const voice = new Float32Array(N), duckTarget = new Float32Array(N).fill(1);
for (const [t0, k] of VO) {
  const raw = fs.readFileSync(new URL(`./vo/l${k}.raw`, import.meta.url));
  const s0 = Math.round(t0 * SR), n = raw.length / 2;
  for (let i = 0; i < n && s0 + i < N; i++) voice[s0 + i] += raw.readInt16LE(i * 2) / 32768;
  for (let i = s0 - SR * 0.15; i < s0 + n + SR * 0.25 && i < N; i++) if (i >= 0) duckTarget[i] = 0.2;
}
let vpk = 0; for (let i = 0; i < N; i++) vpk = Math.max(vpk, Math.abs(voice[i]));
const duck = new Float32Array(N); let dg = 1;
for (let i = 0; i < N; i++) { const tg = duckTarget[i]; dg += (tg - dg) * (tg < dg ? 1 / (SR * 0.08) : 1 / (SR * 0.35)); duck[i] = dg; }

// reverb: a few combs + allpass on the send bus
function reverb(src) {
  const out = new Float32Array(N);
  for (const [d, g] of [[1557, 0.82], [1617, 0.81], [1491, 0.8], [1422, 0.79], [1277, 0.78], [1356, 0.8]]) {
    const buf = new Float32Array(d); let idx = 0, lp = 0;
    for (let i = 0; i < N; i++) { const y = buf[idx]; lp = y * 0.7 + lp * 0.3; buf[idx] = src[i] + lp * g; idx = (idx + 1) % d; out[i] += y / 6; }
  }
  return out;
}
const rv = reverb(busRev);
const pcm = Buffer.alloc(N * 4);
for (let i = 0; i < N; i++) {
  const fade = Math.min(1, (N - i) / (SR * 0.4), i / (SR * 0.01));
  const vo = Math.tanh(voice[i] / vpk * 2.4) * 0.72;
  const l = (Math.tanh((L[i] + rv[i] * 0.9) * 1.4) * 0.85 * duck[i] + vo) * fade;
  const r = (Math.tanh((R[i] + rv[(i + 211) % N] * 0.9) * 1.4) * 0.85 * duck[i] + vo) * fade;
  pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, l)) * 32767), i * 4); pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, r)) * 32767), i * 4 + 2);
}
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
fs.writeFileSync(new URL('./music.wav', import.meta.url), Buffer.concat([h, pcm]));
let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]));
console.log('pre-limit peak', peak.toFixed(2));
