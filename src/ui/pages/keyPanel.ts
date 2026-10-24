import { IambicKeyerInput, StraightKeyer } from "../keyer.js";
import { Sidetone } from "../../audio/sidetone.js";
import type { Paddle } from "../../cw/keyer.js";
import type { AppSettings } from "../settingsSchema.js";

/**
 * The keying panel: straight key or iambic paddles, keyed in real time.
 *
 * Wiring rather than a widget: it listens to the keyboard and reports to the
 * session. Everything the operator sees while keying belongs to the rig around
 * it — the message fills the same bar the text mode types into (`onEcho`), and
 * the key phases show up in the RX/TX badge, the meter and the panadapter.
 *
 * This is not a text-entry widget. In the two key modes the operator is on the
 * air from the first element: the panel asks the session to open the carrier
 * (`onBegin`), reports every key phase (`onKeying`, which makes the receiver go
 * deaf), and when the over is finished hands the decoded text back (`onOver`)
 * so the band can answer it. The audio has already gone out by then — there is
 * no second transmission.
 *
 * **An over ends by itself.** Nothing on this panel ends it by hand: the
 * operator keys, then stops, and after a beat of silence the rig drops the
 * carrier and goes back to listening — the same thing letting go of the PTT
 * does. A button would put a click between "I have said what I wanted" and the
 * receiver coming back.
 */

export interface KeyPanelOptions {
  settings: AppSettings;
  /** Register a cleanup run before the next render (listeners, oscillator). */
  onLeave(fn: () => void): void;
  /** Open the operator's carrier; false when the rig cannot transmit now. */
  onBegin(): boolean;
  /** The key went down or up — half-duplex follows this. */
  onKeying(on: boolean): void;
  /** One finished over: the text that was keyed, ready to go to the band. */
  onOver(text: string): void;
  /**
   * The panel is going away while an over is still open (the operator left the
   * page mid-key, or the page is being rebuilt). The carrier has to be dropped
   * by whoever owns the session — this panel is not going to be around to end
   * the over.
   */
  onCancel?(): void;
  /**
   * Live echo of the over being keyed: the decoded text and the dots/dashes of
   * the character still being decoded. The page puts it in the same bar text
   * mode uses, so all three modes show the operator's message in the same place.
   * An empty string means "nothing is being sent".
   */
  onEcho?(text: string, pending?: string): void;
}

/**
 * Silence after the last element that ends the over — long enough for the
 * operator to start the next letter, short enough that the receiver is not deaf
 * for a noticeable beat after the last dash.
 */
const OVER_IDLE_MS = 1500;

/** Wire a key to the rig; what it shows goes through the session, not a node. */
export function renderKeyPanel(opts: KeyPanelOptions): void {
  const { settings, onLeave } = opts;
  const useIambic = settings.keyMode === "iambic";

  // Sidetone: the operator's own monitor tone while keying. It follows the key
  // (straight) or the element phase (iambic) and is never affected by QSB/QRM.
  const sidetone = new Sidetone({
    enabled: settings.sidetone,
    volume: settings.sidetoneVolume / 100,
    freqHz: settings.toneHz,
  });
  /** Mirror the key phase into both the monitor tone and the rig. */
  const driveKeying = (on: boolean): void => {
    if (on) sidetone.keyDown();
    else sidetone.keyUp();
    opts.onKeying(on);
  };

  // One over is in progress from the first key-down until the operator has been
  // silent for `OVER_IDLE_MS`. A second `onBegin` must not be issued while it
  // lasts, and the over must be closed exactly once — by the idle clock, not by
  // a button and not twice if the clock fires while a flush is in flight.
  let live = false;
  let idle: ReturnType<typeof setTimeout> | null = null;
  /** How this key type flushes a finished over; set once the key exists. */
  let flush: (() => void) | null = null;

  const disarm = (): void => {
    if (idle !== null) {
      clearTimeout(idle);
      idle = null;
    }
  };
  /** Restart the "the operator has stopped keying" clock. */
  const armIdle = (): void => {
    if (!live || flush === null) return;
    disarm();
    idle = setTimeout(() => flush?.(), OVER_IDLE_MS);
  };

  const beginOver = (): boolean => {
    if (live) return true;
    if (!opts.onBegin()) return false;
    live = true;
    return true;
  };
  const endOver = (text: string): void => {
    if (!live) return;
    live = false;
    disarm();
    // The message has gone to the band: the echo box goes back to empty.
    opts.onEcho?.("");
    // Even an over that decoded to nothing has to be handed back: the carrier
    // is still up, and only the session can drop it and reopen the receiver.
    opts.onOver(text);
  };
  /**
   * The panel is being torn down with an over still open: nobody is left to
   * send the key-up, so the carrier has to be dropped from here.
   */
  const abandon = (): void => {
    if (!live) return;
    live = false;
    disarm();
    opts.onCancel?.();
  };

  if (useIambic) {
    // Characters arrive one by one; the over ends on the operator's silence.
    let over = "";
    const iambic = new IambicKeyerInput({
      wpm: settings.wpm,
      mode: settings.iambicMode,
      onText: (text) => {
        over += text;
        opts.onEcho?.(over);
      },
      // The dots/dashes of the character still being decoded: they sit after
      // the text and are replaced by the letter when the character gap passes.
      onSymbols: (symbols) => opts.onEcho?.(over, symbols),
      onKeying: (on) => {
        driveKeying(on);
      },
      // The over ends after the keyer has played everything (including taps it
      // queued), and then stayed silent for a beat.
      onIdle: () => armIdle(),
    });
    flush = () => {
      if (!live) return;
      // Complete the element still being sent before handing the over back.
      iambic.finish();
      const text = over.trim();
      over = "";
      endOver(text);
      // Start the next over from a clean keyer (no stale words or word gaps).
      iambic.clear();
    };

    const paddleFor = (code: string): Paddle | null =>
      code === settings.dotCode ? "dot" : code === settings.dashCode ? "dash" : null;

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.repeat || isTextField(e.target)) return;
      const paddle = paddleFor(e.code);
      if (!paddle) return;
      e.preventDefault();
      if (!beginOver()) return;
      // A new key cancels any pending "the operator stopped" countdown.
      disarm();
      iambic.press(paddle);
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (isTextField(e.target)) return;
      const paddle = paddleFor(e.code);
      if (!paddle) return;
      e.preventDefault();
      iambic.release(paddle);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    onLeave(() => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      disarm();
      iambic.clear();
      sidetone.dispose();
      // After the keyer is silenced: an open over still needs its carrier down.
      abandon();
    });
    return;
  }

  // Straight key: the keyer decodes a run of elements, echoes each character
  // into the bottom bar as it completes, and flushes the over after the same
  // silence.
  const keyer = new StraightKeyer(
    (text) => endOver(text),
    OVER_IDLE_MS,
    driveKeying,
    1200 / settings.wpm,
  );
  let straightText = "";
  keyer.onChar = (text) => {
    straightText = text;
    opts.onEcho?.(text, keyer.pendingSymbols());
  };
  flush = () => keyer.finish();

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.code !== settings.keyCode || e.repeat || isTextField(e.target)) return;
    e.preventDefault();
    if (!beginOver()) return;
    keyer.keyDown();
    opts.onEcho?.(straightText, keyer.pendingSymbols());
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.code !== settings.keyCode || isTextField(e.target)) return;
    e.preventDefault();
    keyer.keyUp();
    opts.onEcho?.(straightText, keyer.pendingSymbols());
  };
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", onKeyUp);
  onLeave(() => {
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("keyup", onKeyUp);
    disarm();
    keyer.clear();
    sidetone.dispose();
    // After the keyer is silenced: an open over still needs its carrier down.
    abandon();
  });
}

/** Keys pressed inside a text field belong to the field, not to the rig. */
function isTextField(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  return !!node && (node.tagName === "INPUT" || node.tagName === "TEXTAREA");
}
