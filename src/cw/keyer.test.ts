import { describe, expect, it } from "vitest";
import { IambicKeyer, type Paddle } from "./keyer.js";
import { decodeKeying } from "./decoder.js";

/** Dot unit used throughout: 60 ms (wpm 20). */
const D = 60;

/**
 * Send one character. Note the timing detail that makes this realistic: to keep
 * elements inside one character, the next paddle must be pressed **during** the
 * 1d element gap — press after the gap expires and the keyer closes the
 * character. Returns the clock time after the character has been flushed.
 */
function sendSymbol(k: IambicKeyer, sym: string, start: number, d = D): number {
  let t = start;
  let first = true;
  for (const c of sym) {
    const p: Paddle = c === "." ? "dot" : "dash";
    const len = c === "." ? d : 3 * d;
    k.press(p, t);
    if (!first) {
      t += d; // element gap, after which the pending paddle starts
      k.advance(t);
    }
    first = false;
    t += len;
    k.release(p, t); // element ends exactly here
    k.advance(t);
  }
  t += 3 * d; // 1d element gap + 2d more = the automatic 3d character gap
  k.advance(t);
  return t;
}

describe("IambicKeyer 时序基础", () => {
  it("dot unit 由 wpm 推导，也可显式指定", () => {
    expect(new IambicKeyer({ wpm: 20 }).unit).toBe(60);
    expect(new IambicKeyer({ wpm: 12 }).unit).toBe(100);
    expect(new IambicKeyer({ unit: 42 }).unit).toBe(42);
    // 缺省 wpm 也要有确定值
    expect(new IambicKeyer().unit).toBeGreaterThan(0);
  });

  it("默认模式是 B", () => {
    expect(new IambicKeyer().iambicMode).toBe("B");
  });

  it("点元素长 1d、划元素长 3d，元素间隔 1d", () => {
    const k = new IambicKeyer({ unit: D });
    k.press("dot", 0);
    k.advance(600);
    k.releaseAll(600);
    k.finish(600);

    const els = k.elements();
    // 600ms 内发满：点(60)+间隔(60) = 120ms 一个周期
    expect(els.length).toBeGreaterThanOrEqual(3);
    expect(els[0]).toEqual({ on: D, off: D });

    const k2 = new IambicKeyer({ unit: D });
    k2.press("dash", 0);
    k2.advance(1000);
    k2.releaseAll(1000);
    k2.finish(1000);
    expect(k2.elements()[0]?.on).toBe(3 * D);
  });

  it("单桨按住会连续重复该元素", () => {
    const k = new IambicKeyer({ unit: D });
    k.press("dot", 0);
    k.advance(600);
    k.releaseAll(600);
    k.finish(600);

    // 0..600 内发了 5 个点（600/120 = 5），第 6 个刚起头，由 finish() 补发完整
    const els = k.elements();
    expect(els.length).toBe(6);
    expect(els.every((e) => e.on === D)).toBe(true);
    expect(els[5]?.off).toBe(0); // 收尾元素没有后续间隔
  });

  it("自动插入 3d 字符间隔并结束字符", () => {
    const k = new IambicKeyer({ unit: D });
    k.press("dot", 0);
    k.release("dot", D);
    k.advance(D * 4); // 1d 元素间隔 + 2d 补足字符间隔

    expect(k.elements()).toEqual([{ on: D, off: 3 * D }]);
    expect(k.text()).toBe("E");
    expect(k.snapshot().busy).toBe(false);
  });
});

describe("IambicKeyer squeeze 与点划记忆", () => {
  it("双桨同时按下时点划交替", () => {
    const k = new IambicKeyer({ unit: D, mode: "B" });
    k.press("dot", 0);
    k.press("dash", 10);
    k.advance(600);
    k.releaseAll(600);
    k.finish(600);

    const ons = k.elements().map((e) => e.on);
    // 点(60) 划(180) 点(60) ...
    expect(ons.slice(0, 3)).toEqual([D, 3 * D, D]);
  });

  it("Mode A：松开双桨后只完成当前元素，丢弃记忆元素", () => {
    const k = new IambicKeyer({ unit: D, mode: "A" });
    k.press("dot", 0);
    k.press("dash", 10); // squeeze：记忆了划
    k.advance(D); // 点结束，进入元素间隔
    k.advance(2 * D); // 间隔结束 -> 开始划
    k.releaseAll(150); // 划还在发（120..300），此时松开双桨
    k.advance(1000);

    // 只发了 .-  => A；Mode A 不再补发记忆的点
    expect(k.text()).toBe("A");
  });

  it("Mode B：松开双桨后补发记忆的元素", () => {
    const k = new IambicKeyer({ unit: D, mode: "B" });
    k.press("dot", 0);
    k.press("dash", 10);
    k.advance(D);
    k.advance(2 * D);
    k.releaseAll(150);
    k.advance(1000);

    // .-. => R（划之后再补发记忆的点）
    expect(k.text()).toBe("R");
  });

  it("两种模式可切换", () => {
    const k = new IambicKeyer({ unit: D, mode: "A" });
    k.setMode("B");
    expect(k.iambicMode).toBe("B");
  });
});

describe("IambicKeyer 单词间隔与往返解码", () => {
  it("wordBreak 把字符间隔加宽到 7d 并分词", () => {
    const k = new IambicKeyer({ unit: D });
    let t = 0;
    t = sendSymbol(k, ".", t); // E
    k.wordBreak(t);
    t = sendSymbol(k, ".", t); // E

    expect(k.text()).toBe("E E");
    expect(k.elements()[0]?.off).toBe(7 * D);
  });

  it("敲出的元素流能被既有解码器还原（CQ 往返）", () => {
    const k = new IambicKeyer({ unit: D, mode: "B" });
    let t = 0;
    t = sendSymbol(k, "-.-.", t); // C
    t = sendSymbol(k, "--.-", t); // Q，与 C 同一词
    k.finish(t);

    const res = decodeKeying(k.elements(), { unit: D });
    expect(res.text).toBe("CQ");
    expect(res.unknown).toEqual([]);
    expect(k.text()).toBe("CQ");
  });

  it("7d 单词间隔在往返解码中确实产生空格", () => {
    const k = new IambicKeyer({ unit: D, mode: "B" });
    let t = 0;
    t = sendSymbol(k, "-.-.", t); // C
    t = sendSymbol(k, "--.-", t); // Q
    k.wordBreak(t);
    t = sendSymbol(k, ".-.", t); // R
    k.finish(t);

    expect(decodeKeying(k.elements(), { unit: D }).text).toBe("CQ R");
    expect(k.text()).toBe("CQ R");
  });

  it("逐字符发送同样能往返（SOS 用 squeeze 之外的常规键控）", () => {
    const k = new IambicKeyer({ unit: D, mode: "A" });
    let t = 0;
    t = sendSymbol(k, "...", t); // S
    t = sendSymbol(k, "---", t); // O
    t = sendSymbol(k, "...", t); // S
    k.finish(t);

    expect(decodeKeying(k.elements(), { unit: D }).text).toBe("SOS");
  });

  it("未在码表中的符号不臆造，记为 ?", () => {
    const k = new IambicKeyer({ unit: D });
    const t = sendSymbol(k, "........", 0); // 8 个点，无对应字符
    k.finish(t);
    expect(k.text()).toBe("?");
  });
});

describe("IambicKeyer 回调与其他", () => {
  it("onElement / onCharacter 按序触发", () => {
    const els: number[] = [];
    const chars: string[] = [];
    const k = new IambicKeyer({
      unit: D,
      onElement: (e) => els.push(e.on),
      onCharacter: (e) => chars.push(e.text),
    });
    let t = 0;
    t = sendSymbol(k, ".-", t); // A
    k.finish(t);

    expect(els).toEqual([D, 3 * D]);
    expect(chars).toEqual(["A"]);
  });

  it("finish() 收尾未完成的字符，不等 3d 间隔", () => {
    const k = new IambicKeyer({ unit: D });
    k.press("dot", 0);
    k.advance(D);
    k.release("dot", D);
    expect(k.text()).toBe(""); // 还没 flush
    k.finish(2 * D);
    expect(k.text()).toBe("E");
  });

  it("reset() 清空全部状态且不触发回调", () => {
    let fired = 0;
    const k = new IambicKeyer({ unit: D, onCharacter: () => fired++ });
    let t = 0;
    t = sendSymbol(k, ".-", t);
    expect(k.text()).toBe("A");
    k.reset();
    expect(k.text()).toBe("");
    expect(k.elements()).toEqual([]);
    expect(k.snapshot().busy).toBe(false);
    expect(fired).toBe(1); // reset 自身不再回调
  });

  it("setSpeed 改变后续元素长度", () => {
    const k = new IambicKeyer({ unit: D });
    k.press("dot", 0);
    k.release("dot", D);
    k.advance(4 * D);
    k.setSpeed({ wpm: 12 }); // d 变 100
    k.press("dot", 4 * D);
    k.release("dot", 4 * D + 100);
    k.advance(4 * D + 400);

    const els = k.elements();
    expect(els[0]?.on).toBe(D);
    expect(els[1]?.on).toBe(100);
  });

  it("时钟不回退：advance 到过去的时间不产生元素", () => {
    const k = new IambicKeyer({ unit: D });
    k.press("dot", 100);
    k.advance(1000);
    const before = k.elements().length;
    k.advance(500); // 回到过去
    expect(k.elements().length).toBe(before);
  });
});
