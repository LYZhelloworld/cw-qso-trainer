import { describe, expect, it } from "vitest";
import {
  keyedDuration,
  makeTx,
  txEndsAt,
  txKeyed,
  txOffsetSec,
  txOnAir,
} from "./tx.js";

/** A at 100 ms, gap 100, B at 300 ms — a stand-in for "A B". */
const ELEMENTS = [
  { on: 100, off: 100 }, // A: key down 0–100, silent 100–200
  { on: 100, off: 100 }, // B: key down 200–300, silent 300–400
];

describe("传输记录（Tx）— 键控的真相", () => {
  it("时长把每个元素连同它后面的间隔都算进去", () => {
    expect(keyedDuration(ELEMENTS)).toBe(400);
    expect(makeTx("A B", ELEMENTS, 1_000).durationMs).toBe(400);
  });

  it("整条报文（on air）与某个瞬间的载波（keyed）是两件事", () => {
    const tx = makeTx("A B", ELEMENTS, 1_000);

    // 报文窗口：起点含、终点不含
    expect(txOnAir(tx, 999)).toBe(false);
    expect(txOnAir(tx, 1_000)).toBe(true);
    expect(txOnAir(tx, 1_399)).toBe(true);
    expect(txOnAir(tx, 1_400)).toBe(false);

    // 点划：只在这 200 ms 里按着键，间隔里是安静的
    expect(txKeyed(tx, 1_050)).toBe(true);
    expect(txKeyed(tx, 1_150)).toBe(false);
    expect(txKeyed(tx, 1_250)).toBe(true);
    expect(txKeyed(tx, 1_350)).toBe(false);
    // 报文之外一律安静，即使窗口判断另有别处兜底
    expect(txKeyed(tx, 1_500)).toBe(false);
  });

  it("中途接上时给出已经发到第几秒", () => {
    const tx = makeTx("A B", ELEMENTS, 1_000);
    expect(txOffsetSec(tx, 1_000)).toBe(0);
    expect(txOffsetSec(tx, 1_200)).toBeCloseTo(0.2, 6);
    // 报文之外没有偏移可言
    expect(txOffsetSec(tx, 900)).toBe(0);
    expect(txOffsetSec(tx, 1_400)).toBe(0);
    expect(txEndsAt(tx)).toBe(1_400);
  });

  it("空报文不会亮也不会响", () => {
    const tx = makeTx("", [], 0);
    expect(tx.durationMs).toBe(0);
    expect(txOnAir(tx, 0)).toBe(false);
    expect(txKeyed(tx, 0)).toBe(false);
  });
});
