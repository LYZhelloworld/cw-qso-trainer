import type { AudioContextLike } from "./player.js";

/**
 * The one `AudioContext` the audio layer shares.
 *
 * Everything that makes sound — the band's transmitters, the noise floor, the
 * operator's monitor, the sidetone — has to run on **one** clock and reach the
 * speakers through **one** device. Two contexts would drift apart (a keying
 * scheduled on one lands at a different instant on the other) and browsers cap
 * how many can exist at once.
 *
 * Browsers start the context `suspended` until a user gesture, so it is resumed
 * on the first `pointerdown` / `keydown` / `touchstart`.
 */

type Ctor = new () => AudioContextLike;

function audioContextCtor(): Ctor | undefined {
  const g = globalThis as Record<string, unknown>;
  return (g.AudioContext ?? g.webkitAudioContext) as Ctor | undefined;
}

let shared: AudioContextLike | null = null;
let gestureWired = false;

/**
 * Lazily create (and cache) the shared context. Returns null where audio is
 * unavailable (Node, jsdom), in which case everything is silent and safe.
 */
export function sharedAudioContext(): AudioContextLike | null {
  if (shared) return shared;
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  shared = new Ctor();
  wireGestureResume(shared);
  return shared;
}

/** True where the browser has a Web Audio implementation at all. */
export function audioAvailable(): boolean {
  return audioContextCtor() !== undefined;
}

function wireGestureResume(ctx: AudioContextLike): void {
  if (gestureWired) return;
  gestureWired = true;
  const g = globalThis as Record<string, unknown>;
  const add = g.addEventListener as
    | ((type: string, cb: () => void, opts?: { once?: boolean; capture?: boolean }) => void)
    | undefined;
  if (typeof add !== "function") return;
  const resume = (): void => {
    try {
      ctx.resume?.();
    } catch {
      /* ignore */
    }
  };
  for (const ev of ["pointerdown", "keydown", "touchstart"]) {
    add(ev, resume, { once: true, capture: true });
  }
}
