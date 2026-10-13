/**
 * Generate demo CW audio samples as WAV files (offline, no browser needed).
 * Run with:  npx vite-node scripts/gen-sample-wav.ts
 *
 * The rendered audio is piped through the same pure renderer used by the browser
 * playback path, so these files are faithful previews of what the app will sound
 * like at each difficulty tier.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { renderCwAudio } from "../src/audio/render.js";
import { encodeWav } from "../src/audio/wav.js";
import { difficultyToEnvironment, type Difficulty } from "../src/audio/environment.js";

const SR = 8000; // 8 kHz is plenty for CW; keeps files small
mkdirSync("samples", { recursive: true });

const scenes: { file: string; text: string; difficulty: Difficulty }[] = [
  { file: "samples/1-cq-novice.wav", text: "CQ CQ CQ DE BG7XXX BG7XXX PSE K", difficulty: "novice" },
  { file: "samples/2-ham-answer-intermediate.wav", text: "BG7XXX DE JA1ABC K", difficulty: "intermediate" },
  { file: "samples/3-rst-hardcore.wav", text: "R UR RST 599 BK", difficulty: "hardcore" },
  { file: "samples/4-signoff-intermediate.wav", text: "R TU 73 SK", difficulty: "intermediate" },
];

for (const s of scenes) {
  const env = difficultyToEnvironment(s.difficulty);
  const r = renderCwAudio({
    text: s.text,
    sampleRate: SR,
    wpm: 20,
    toneHz: 700,
    qsb: env.qsb,
    qrm: env.qrm,
    qrn: env.qrn,
    noiseSeed: 12345,
  });
  const wav = encodeWav(r.samples, SR);
  writeFileSync(s.file, wav);
  console.log(`wrote ${s.file}  (${r.durationSec.toFixed(2)}s, ${wav.length} bytes)`);
}
