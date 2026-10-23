import type { QsoSession, AiredMessage } from "./session.js";

/** Whether a HAM transmission is audible to the operator right now. */
export type AirPath = "audible" | "offband" | "muted" | "transmitting";

export interface DebugOptions {
  /**
   * Returns the session the operator is currently monitoring. The console only
   * prints transmissions from this band that are actually audible; everything
   * else (other bands, off-band / muted / our-own-TX) is suppressed so the
   * console reads like "what I am hearing right now" instead of every signal on
   * every band.
   */
  getActive: () => QsoSession;
  /** How many recent transmissions `cw.air()` keeps per band. Default 200. */
  buffer?: number;
}

/**
 * F12 debug console for the CW trainer.
 *
 * Installs a listener on every band session but the browser console only ever
 * shows what the operator can actually hear right now — the band being
 * monitored, and only transmissions that are genuinely `audible` (in passband,
 * receiver open, not transmitting). That is exactly the list the operator asked
 * for: "the stations I can hear on my current frequency". Off-band / muted /
 * our-own-TX signals are deliberately not printed, because they were the noise.
 *
 * Also exposes a `window.cw` REPL for poking at the live state on the monitored
 * band:
 *   cw.help()    — list commands
 *   cw.air()     — recent transmissions on the monitored band (callsign + path + text)
 *   cw.hams()    — the band roster (callsign + frequency)
 *   cw.state()   — current band, QSO state, receiving / transmitting
 */
export function installDebugConsole(sessions: QsoSession[], opts: DebugOptions): void {
  const active = opts.getActive;
  const max = opts.buffer ?? 200;
  // One ring per band so `cw.air()` can show whichever band is currently active.
  const rings = new Map<QsoSession, AiredMessage[]>();
  for (const s of sessions) rings.set(s, []);

  for (const s of sessions) {
    s.onAir((m) => {
      const ring = rings.get(s);
      if (!ring) return;
      ring.push(m);
      if (ring.length > max) ring.splice(0, ring.length - max);

      // Console: only what the operator can hear right now — the monitored band,
      // and only transmissions that are truly audible (in passband, rx open, not
      // transmitting). Everything else is the noise we are filtering out.
      if (m.path !== "audible" || active() !== s) return;
      // eslint-disable-next-line no-console
      console.log(
        `%c[CW ${m.band}]%c ${m.call} · ${m.text}  (${(m.durationMs / 1000).toFixed(1)}s)`,
        "color:#8250df;font-weight:bold",
        "color:#1a7f37",
      );
    });
  }

  if (typeof window !== "undefined") {
    (window as unknown as { cw: unknown }).cw = {
      help(): void {
        console.log(
          [
            "%cCW 调试台",
            "cw.help()   — 本帮助",
            "cw.air()    — 当前值守波段最近发报（呼号 + 路径 + 内容）",
            "cw.hams()   — 当前波段台站表（呼号 + 频率）",
            "cw.state()  — 当前波段、通联状态、接收/发射",
            "",
            "控制台只打印你当前守听、且能实际听到的台；带外/静音/自己发射中的台不刷屏。",
          ].join("\n"),
          "color:#8250df;font-weight:bold",
        );
      },
      air(): AiredMessage[] {
        return (rings.get(active()) ?? []).slice();
      },
      hams(): Array<{ call: string; freqHz: number }> {
        return active()
          .listHams()
          .map((h) => ({ call: h.call, freqHz: h.freqHz }));
      },
      state(): {
        band: number;
        state: string;
        receiving: boolean;
        transmitting: boolean;
      } {
        const s = active();
        return {
          band: s.freqMHz,
          state: s.state,
          receiving: s.isReceiving,
          transmitting: s.isTransmitting,
        };
      },
    };
  }
}
