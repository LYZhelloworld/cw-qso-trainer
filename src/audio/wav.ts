/**
 * Minimal WAV encoder: 16-bit PCM, mono. Pure (no browser dependency), so it
 * runs under Node for tests and for offline sample generation.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const numSamples = samples.length;
  const bytesPerSample = 2;
  const dataSize = numSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  let o = 0;
  const writeStr = (s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o++, s.charCodeAt(i));
  };
  const writeU32 = (v: number) => {
    view.setUint32(o, v, true);
    o += 4;
  };
  const writeU16 = (v: number) => {
    view.setUint16(o, v, true);
    o += 2;
  };

  writeStr("RIFF");
  writeU32(36 + dataSize);
  writeStr("WAVE");
  writeStr("fmt ");
  writeU32(16); // PCM chunk size
  writeU16(1); // PCM format
  writeU16(1); // mono
  writeU32(sampleRate);
  writeU32(sampleRate * bytesPerSample); // byte rate
  writeU16(bytesPerSample); // block align
  writeU16(16); // bits per sample
  writeStr("data");
  writeU32(dataSize);

  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }

  return new Uint8Array(buffer);
}

/**
 * Decode a 16-bit mono PCM WAV back to Float32Array in [-1, 1].
 * Used by tests to verify the encoder round-trips.
 */
export function decodeWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readStr = (at: number) => {
    let s = "";
    for (let i = 0; i < 4; i++) s += String.fromCharCode(view.getUint8(at + i));
    return s;
  };
  if (readStr(0) !== "RIFF" || readStr(8) !== "WAVE") {
    throw new Error("Not a WAV file");
  }
  let off = 12;
  let sampleRate = 0;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= bytes.length) {
    const id = readStr(off);
    const size = view.getUint32(off + 4, true);
    if (id === "fmt ") {
      sampleRate = view.getUint32(off + 12, true);
    } else if (id === "data") {
      dataOff = off + 8;
      dataLen = size;
      break;
    }
    off += 8 + size;
  }
  if (dataOff < 0) throw new Error("No data chunk in WAV");
  const count = Math.floor(dataLen / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const v = view.getInt16(dataOff + i * 2, true);
    samples[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
  }
  return { samples, sampleRate };
}
