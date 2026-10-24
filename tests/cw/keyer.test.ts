import { describe, expect, it } from "vitest";
import { IambicKeyer, type Paddle } from "../../src/cw/keyer.js";
import { decodeKeying } from "../../src/cw/decoder.js";

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

/**
 * Play a run of paddle taps in real time order. A tap goes down at `i * spacing`
 * and up `hold` ms later; when `hold > spacing` the next press lands before the
 * previous release — which is exactly what fast alternation looks like.
 */
function playTaps(k: IambicKeyer, taps: Paddle[], spacing: number, hold: number): void {
  const events: Array<{ at: number; down: boolean; paddle: Paddle }> = [];
  taps.forEach((p, i) => {
    events.push({ at: i * spacing, down: true, paddle: p });
    events.push({ at: i * spacing + hold, down: false, paddle: p });
  });
  // At the same instant a release happens before a press ("hold 0" still works).
  events.sort((a, b) => a.at - b.at || Number(a.down) - Number(b.down));
  for (const e of events) {
    if (e.down) k.press(e.paddle, e.at);
    else k.release(e.paddle, e.at);
  }
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
  it("连续快速交替按左右桨：每次按键都产生一个元素（不重叠）", () => {
    const k = new IambicKeyer({ unit: D });
    playTaps(k, ["dot", "dash", "dot", "dash", "dot", "dash"], 50, 20);
    k.advance(5000);

    expect(k.elements().map((e) => e.on)).toEqual([D, 3 * D, D, 3 * D, D, 3 * D]);
  });

  it("连续快速交替按左右桨：稍微重叠也不吞键", () => {
    const k = new IambicKeyer({ unit: D });
    // 按住 60 ms、每 50 ms 按下一键：下一键在上一键松开之前按下，手快时很常见
    playTaps(k, ["dot", "dash", "dot", "dash", "dot", "dash"], 50, 60);
    k.advance(5000);

    expect(k.elements().map((e) => e.on)).toEqual([D, 3 * D, D, 3 * D, D, 3 * D]);
  });

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
  it("长停顿后自动分词：下一个字符算新词，元素间隔反映实际沉默", () => {
    const k = new IambicKeyer({ unit: D });
    let t = sendSymbol(k, ".", 0); // E，字符在 3d 后收尾
    t = sendSymbol(k, ".", t + 4 * D); // 再停 4d（距上一元素 7d）→ 新词
    k.finish(t);

    expect(k.text()).toBe("E E");
    // 最后一个点的尾巴按真实停顿时长记，接收侧解码器才会在这里断词。
    expect(k.elements()[0]?.off).toBe(7 * D);
  });

  it("快速连按会排队播放，不会因为元素在途而丢键", () => {
    const k = new IambicKeyer({ unit: D });
    k.press("dot", 0);
    k.release("dot", 10);
    k.press("dash", 20); // 点的元素还没发完
    k.release("dash", 30);
    k.press("dot", 40);
    k.release("dot", 50);
    k.advance(2000);

    // .-. => R：三次按键全部按顺序发出，没有被吞掉。
    expect(k.text()).toBe("R");
    expect(k.elements().map((e) => e.on)).toEqual([D, 3 * D, D]);
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

  it("长停顿在往返解码中确实产生空格", () => {
    const k = new IambicKeyer({ unit: D, mode: "B" });
    let t = 0;
    t = sendSymbol(k, "-.-.", t); // C
    t = sendSymbol(k, "--.-", t); // Q
    t = sendSymbol(k, ".-.", t + 4 * D); // R：停 4d（距上一元素 7d）
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

  it("snapshot.keying 只在元素发声时为真（侧音的依据）", () => {
    const k = new IambicKeyer({ unit: D, mode: "B" });
    k.press("dot", 0);
    expect(k.snapshot().keying).toBe(true);

    k.advance(D); // 元素结束，进入 1d 元素间隔
    expect(k.snapshot().keying).toBe(false);
    expect(k.snapshot().busy).toBe(true); // 字符还没结束

    k.press("dash", D); // squeeze：下一个元素
    k.advance(2 * D);
    expect(k.snapshot().keying).toBe(true);

    k.finish();
    expect(k.snapshot().keying).toBe(false);
  });
});
