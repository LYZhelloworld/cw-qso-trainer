/**
 * Disclaimer copy, defined in the root README.md and shown in four places: the
 * first-run dialog, the about page, the log page watermark and the footer. Kept
 * in one place so the wording never drifts.
 */

export const DISCLAIMER_TEXT =
  "本软件仅供练习使用。其中生成的呼号为虚拟呼号，可能与现实存在的呼号重复，" +
  "不代表真实的无线电环境，也不能作为真实的通联记录。";

export const LOG_WATERMARK = "练习日志，非真实通联记录，不可用于任何奖项申请。";

const ACK_KEY = "cw-qso-trainer:disclaimer-ack";

/** Whether the user has already dismissed the first-run disclaimer dialog. */
export function hasAcknowledgedDisclaimer(): boolean {
  try {
    return localStorage.getItem(ACK_KEY) === "1";
  } catch {
    return false;
  }
}

export function acknowledgeDisclaimer(): void {
  try {
    localStorage.setItem(ACK_KEY, "1");
  } catch {
    // Storage unavailable (e.g. private mode). The dialog simply shows again.
  }
}
