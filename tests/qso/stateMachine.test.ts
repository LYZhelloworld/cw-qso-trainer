import { describe, it, expect } from "vitest";
import { QsoMachine, type QsoState } from "../../src/qso/stateMachine.js";
import { VirtualHam } from "../../src/ham/virtualHam.js";
import { dxccDatabase } from "../../src/data/dxcc.js";

function newMachine(myCall = "BG7XXX", hamCall = "JA1ABC") {
  return new QsoMachine({
    myCall,
    ham: new VirtualHam({ call: hamCall, difficulty: "novice" }),
    db: dxccDatabase,
  });
}

/** Drive a machine into EXCHANGE via the user-initiated CQ path. */
function startUserCq(m: QsoMachine) {
  m.userSend("CQ CQ CQ DE BG7XXX BG7XXX PSE K");
  m.hamAnswerCq();
}

describe("QsoMachine — normal 6-line flow (user initiates CQ)", () => {
  it("walks IDLE -> USER_CQ -> EXCHANGE -> SIGNOFF -> LOGGED", () => {
    const m = newMachine();
    expect(m.state).toBe("IDLE");

    const cqReply = m.userSend("CQ CQ CQ DE BG7XXX BG7XXX PSE K");
    expect(m.state).toBe("USER_CQ");
    expect(cqReply).toEqual([]); // HAM hasn't answered yet

    const hamAns = m.hamAnswerCq();
    expect(hamAns).toBe("BG7XXX DE JA1ABC K");
    expect(m.state).toBe("EXCHANGE");
    expect(m.ctx.peerCall).toBe("JA1ABC");
    expect(m.ctx.callsignsConfirmed).toBe(true);

    const rstReply = m.userSend("JA1ABC DE BG7XXX R UR RST 599 599 BK");
    expect(rstReply).toEqual(["R UR RST 599 BK"]);
    expect(m.ctx.rstTx).toBe("599");
    expect(m.ctx.rstRx).toBe("599");
    expect(m.state).toBe("SIGNOFF");

    const endReply = m.userSend("R TU 73 SK");
    expect(endReply).toEqual(["R TU 73 SK"]);
    expect(m.state).toBe("LOGGED");

    const log = m.getLog();
    expect(log).not.toBeNull();
    expect(log!.peerCall).toBe("JA1ABC");
    expect(log!.rstRx).toBe("599");
    expect(log!.rstTx).toBe("599");
  });
});

describe("QsoMachine — HAM initiates CQ (peer CQ)", () => {
  it("walks IDLE -> PEER_CQ -> EXCHANGE -> LOGGED", () => {
    const m = newMachine();
    const hamCq = m.hamCq();
    expect(hamCq).toBe("CQ CQ CQ DE JA1ABC JA1ABC PSE K");
    expect(m.state).toBe("PEER_CQ");
    expect(m.ctx.peerCall).toBe("JA1ABC");

    const reply = m.userSend("JA1ABC DE BG7XXX R UR RST 599 599 BK");
    expect(reply).toEqual(["R UR RST 599 BK"]);
    expect(m.ctx.callsignsConfirmed).toBe(true);
    expect(m.state).toBe("SIGNOFF");

    m.userSend("R TU 73 SK");
    expect(m.state).toBe("LOGGED");
  });
});

describe("QsoMachine — copy error (wrong callsign)", () => {
  it("responds QRZ? and fails after 3 attempts", () => {
    const m = newMachine();
    startUserCq(m);
    expect(m.state).toBe("EXCHANGE");

    const r1 = m.userSend("JA1ABB DE BG7XXX R UR RST 599 599 BK");
    expect(r1).toEqual(["QRZ? DE JA1ABC"]);
    expect(m.ctx.retryCount.CALL).toBe(1);

    m.userSend("JA1ABB DE BG7XXX R UR RST 599 599 BK");
    m.userSend("JA1ABB DE BG7XXX R UR RST 599 599 BK");
    expect(m.ctx.retryCount.CALL).toBe(3);
    expect(m.state).toBe("FAILED");
  });
});

describe("QsoMachine — illegal RST", () => {
  it("responds UR RST? and fails after 3 attempts", () => {
    const m = newMachine();
    startUserCq(m);

    const r1 = m.userSend("JA1ABC DE BG7XXX UR RST 5999 BK");
    expect(r1).toEqual(["UR RST?"]);
    expect(m.ctx.retryCount.RST).toBe(1);

    m.userSend("JA1ABC DE BG7XXX UR RST 5999 BK");
    m.userSend("JA1ABC DE BG7XXX UR RST 5999 BK");
    expect(m.state).toBe("FAILED");
  });
});

describe("QsoMachine — incomplete copy (HAM missed)", () => {
  it("asks AGN? and fails after 3 misses", () => {
    const m = newMachine();
    startUserCq(m);

    expect(m.hamMissed()).toBe("AGN?");
    expect(m.ctx.retryCount.COPY).toBe(1);
    m.hamMissed();
    m.hamMissed();
    expect(m.state).toBe("FAILED");
  });
});

describe("QsoMachine — first-call timeout", () => {
  it("returns to IDLE if no answer to a CQ", () => {
    const m = newMachine();
    m.userSend("CQ CQ CQ DE BG7XXX BG7XXX PSE K");
    expect(m.state).toBe("USER_CQ");
    m.timeoutFirstCall();
    expect(m.state).toBe("IDLE");
    expect(m.ctx.peerCall).toBeNull();
  });

  it("returns to IDLE if no answer to a HAM CQ", () => {
    const m = newMachine();
    m.hamCq();
    expect(m.state).toBe("PEER_CQ");
    m.timeoutFirstCall();
    expect(m.state).toBe("IDLE");
  });
});

describe("QsoMachine — resend timeout escalates a retry", () => {
  it("increments the pending retry and fails after the limit", () => {
    const m = newMachine();
    startUserCq(m);
    m.userSend("JA1ABB DE BG7XXX R UR RST 599 599 BK"); // CALL = 1
    expect(m.state).toBe("EXCHANGE");

    m.timeoutResend(); // CALL = 2
    m.timeoutResend(); // CALL = 3 -> FAILED
    expect(m.ctx.retryCount.CALL).toBe(3);
    expect(m.state).toBe<QsoState>("FAILED");
  });
});

describe("QsoMachine — callsign omission & operation suffixes", () => {
  it("allows omitting callsigns after confirmation", () => {
    const m = newMachine();
    startUserCq(m);
    m.userSend("JA1ABC DE BG7XXX R UR RST 599 599 BK");
    const reply = m.userSend("R TU 73 SK"); // omitted, still works
    expect(reply).toEqual(["R TU 73 SK"]);
    expect(m.state).toBe("LOGGED");
  });

  it("accepts a /P suffix on the user's call in the HAM-CQ path", () => {
    const m = newMachine("BG7XXX/P", "JA1ABC");
    m.hamCq();
    const reply = m.userSend("JA1ABC DE BG7XXX/P R UR RST 599 599 BK");
    expect(reply).toEqual(["R UR RST 599 BK"]);
    expect(m.state).toBe("SIGNOFF");
  });
});

describe("QsoMachine — protocol leniency (user-side tolerance)", () => {
  it("completes a QSO when the user uses K instead of BK throughout", () => {
    const m = newMachine();
    m.hamCq();
    const r1 = m.userSend("JA1ABC DE BG7XXX R UR RST 599 599 K");
    expect(r1).toEqual(["R UR RST 599 BK"]);
    expect(m.state).toBe("SIGNOFF");
    const r2 = m.userSend("R TU 73 K"); // omitted callsigns, K not BK
    expect(r2).toEqual(["R TU 73 SK"]);
    expect(m.state).toBe("LOGGED");
  });

  it("accepts an RST exchange line without the leading R", () => {
    const m = newMachine();
    startUserCq(m);
    const reply = m.userSend("UR RST 599 599 BK"); // no R
    expect(reply).toEqual(["R UR RST 599 BK"]);
    expect(m.ctx.rstTx).toBe("599");
    expect(m.state).toBe("SIGNOFF");
  });

  it("logs a QSO when the final line has no K/BK (just TU 73 SK)", () => {
    const m = newMachine();
    startUserCq(m);
    m.userSend("JA1ABC DE BG7XXX R UR RST 599 599 BK");
    expect(m.state).toBe("SIGNOFF");
    m.userSend("TU 73 SK"); // no R, no K/BK
    expect(m.state).toBe("LOGGED");
  });

  it("logs a QSO when the final line is TU 73 with no SK and no K/BK", () => {
    const m = newMachine();
    startUserCq(m);
    m.userSend("JA1ABC DE BG7XXX R UR RST 599 599 BK");
    expect(m.state).toBe("SIGNOFF");
    m.userSend("R TU 73"); // no SK, no K/BK
    expect(m.state).toBe("LOGGED");
  });

  it("does NOT log an early sign-off before RST exchange (gate)", () => {
    const m = newMachine();
    startUserCq(m);
    // In EXCHANGE (no RST yet) a stray TU 73 SK is ignored, not logged.
    const reply = m.userSend("R TU 73 SK");
    expect(reply).toEqual(["R BK"]);
    expect(m.state).toBe("EXCHANGE");
    expect(m.ctx.userEndSent).toBe(false);
  });
});

describe("QsoMachine — reports exchanged both ways", () => {
  it("answers the operator's report with 73 instead of echoing it back", () => {
    // The operator hears a CQ, answers with callsigns only, gets the HAM's
    // report, and reports back. Both directions have reported: the contact is
    // done, so the HAM signs off. It used to send "R UR RST 599 BK" — the
    // operator's own report handed straight back, which reads as "I am still
    // here, say something", leaving the QSO hanging with nothing left to say.
    const m = newMachine();
    m.hamCq();
    expect(m.state).toBe("PEER_CQ");

    const report = m.userSend("JA1ABC DE BG7XXX K");
    expect(report).toEqual(["R UR RST 599 BK"]);
    expect(m.ctx.rstRx).toBe("599");
    expect(m.ctx.rstTx).toBeNull();
    expect(m.state).toBe("EXCHANGE");

    const signoff = m.userSend("R UR RST 599 BK");
    expect(signoff).toEqual(["R TU 73 SK"]);
    expect(m.ctx.rstTx).toBe("599");
    expect(m.ctx.peerEndHeard).toBe(true);
    expect(m.state).toBe("SIGNOFF");

    expect(m.userSend("R TU 73 SK")).toEqual(["73"]);
    expect(m.state).toBe("LOGGED");
    expect(m.getLog()?.rstRx).toBe("599");
    expect(m.getLog()?.rstTx).toBe("599");
  });

  it("understands a report sent in cut numbers", () => {
    // What the quick-message keys actually key: 579 goes out as 5BN. If the
    // parser cannot read that back, our report never registers, the HAM never
    // signs off, and the contact hangs with both sides waiting.
    const m = newMachine();
    m.hamCq();
    m.userSend("JA1ABC DE BG7XXX K");

    expect(m.userSend("R UR RST 5BN BK")).toEqual(["R TU 73 SK"]);
    expect(m.ctx.rstTx).toBe("579");
    expect(m.state).toBe("SIGNOFF");
  });

  it("does not parrot a second report either", () => {
    const m = newMachine();
    m.hamCq();
    m.userSend("JA1ABC DE BG7XXX K");
    expect(m.userSend("R UR RST 579 BK")).toEqual(["R TU 73 SK"]);
    // Sending the report again after the sign-off changes nothing.
    expect(m.state).toBe("SIGNOFF");
    m.userSend("R UR RST 579 BK");
    expect(m.state).toBe("SIGNOFF");
  });
});

describe("QsoMachine — reset lifecycle", () => {
  it("clears context after a FAILED QSO", () => {
    const m = newMachine();
    startUserCq(m);
    m.userSend("JA1ABB DE BG7XXX R UR RST 599 599 BK");
    m.userSend("JA1ABB DE BG7XXX R UR RST 599 599 BK");
    m.userSend("JA1ABB DE BG7XXX R UR RST 599 599 BK");
    expect(m.state).toBe("FAILED");
    m.reset();
    expect(m.state).toBe("IDLE");
    expect(m.ctx.peerCall).toBeNull();
    expect(m.ctx.retryCount.CALL).toBe(0);
    expect(m.getLog()).toBeNull();
  });
});
