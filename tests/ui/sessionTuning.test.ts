import { describe, expect, it } from "vitest";
import { Tuning } from "../../src/ui/sessionTuning.js";
import { VirtualHam } from "../../src/ham/virtualHam.js";

/**
 * The geometry of the dial on its own. Since stations are scattered to the same
 * 10 Hz grid the dial tunes in, nothing guarantees one station per passband any
 * more: these tests pin down what the receiver does when two are inside it.
 */

const DIAL = 14_025_150;

function ham(call: string, freqHz: number): VirtualHam {
  return new VirtualHam({ call, difficulty: "novice", freqHz });
}

function tuningAt(dialHz: number, passbandHz = 500): Tuning {
  return new Tuning(
    () => ({ dialHz, passbandHz }),
    () => null,
  );
}

describe("Tuning：一个通带里可以有两台", () => {
  it("两台都在通带内时都能被听到", () => {
    const t = tuningAt(DIAL);
    const low = ham("JA1AAA", DIAL + 50);
    const high = ham("JA1BBB", DIAL + 200);

    expect(t.canHear(low)).toBe(true);
    expect(t.canHear(high)).toBe(true);
  });

  it("搭档取离零拍最近的那台，与名单顺序无关", () => {
    const t = tuningAt(DIAL);
    const near = ham("JA1AAA", DIAL + 50);
    const far = ham("JA1BBB", DIAL + 200);

    expect(t.heardActive([far, near])).toBe(near);
    expect(t.heardActive([near, far])).toBe(near);
  });

  it("拨轮移到两台之间，搭档换成更近的一台", () => {
    const t = tuningAt(DIAL + 100); // detunes: −50 (low) / +100 (high)
    const low = ham("JA1AAA", DIAL + 50);
    const high = ham("JA1BBB", DIAL + 200);

    expect(t.heardActive([low, high])).toBe(low);
  });

  it("两台都出了通带时没有搭档", () => {
    const t = tuningAt(DIAL + 1_000);
    const low = ham("JA1AAA", DIAL + 50);
    const high = ham("JA1BBB", DIAL + 200);

    expect(t.canHear(low)).toBe(false);
    expect(t.canHear(high)).toBe(false);
    expect(t.heardActive([low, high])).toBeNull();
  });
});
