import { describe, expect, it } from "vitest";
import { IambicKeyerInput, StraightKeyer } from "../../src/ui/keyer.js";

/** Key A (.-) with a 60 ms dot: down 0..60, gap 60, dash 120..300. */
function keyA(): StraightKeyer {
  const k = new StraightKeyer(() => {}, 50);
  k.keyDown(0);
  k.keyUp(60);
  k.keyDown(120);
  k.keyUp(300);
  return k;
}

describe("StraightKeyer", () => {
  it("键控期间 isDown 反映按键状态", () => {
    const k = new StraightKeyer(() => {});
    expect(k.isDown).toBe(false);
    k.keyDown(0);
    expect(k.isDown).toBe(true);
    k.keyUp(60);
    expect(k.isDown).toBe(false);
  });

  it("currentSymbols 实时回显点划", () => {
    const k = keyA();
    expect(k.currentSymbols()).toBe(".-");
  });

  it("finish 把点划序列解码成字母", () => {
    const texts: string[] = [];
    const k = new StraightKeyer((t) => texts.push(t), 50);
    k.keyDown(0);
    k.keyUp(60);
    k.keyDown(120);
    k.keyUp(300);

    k.finish();
    expect(texts).toEqual(["A"]);
    expect(k.hasContent).toBe(false);
  });

  it("字符间隔≥3d 时切分出多个字符", () => {
    const texts: string[] = [];
    const k = new StraightKeyer((t) => texts.push(t), 50);
    // E (.) then wait 3d, then T (-)
    k.keyDown(0);
    k.keyUp(60);
    k.keyDown(300);
    k.keyUp(480);
    k.finish();
    expect(texts).toEqual(["ET"]);
  });

  it("clear 丢弃尚未解码的内容", () => {
    const k = keyA();
    expect(k.hasContent).toBe(true);
    k.clear();
    expect(k.hasContent).toBe(false);
    expect(k.currentSymbols()).toBe("");
  });

  it("忽视键盘自动重复产生的重复 keyDown", () => {
    const texts: string[] = [];
    const k = new StraightKeyer((t) => texts.push(t), 50);
    k.keyDown(0);
    k.keyDown(10); // auto-repeat, ignored
    k.keyUp(60);
    k.finish();
    expect(texts).toEqual(["E"]);
  });

  it("停手一段时间后自动 flush（idle 超时）", async () => {
    const texts: string[] = [];
    const k = new StraightKeyer((t) => texts.push(t), 20);
    k.keyDown(0);
    k.keyUp(60); // dot -> E
    expect(texts).toEqual([]);

    await new Promise((r) => setTimeout(r, 40));
    expect(texts).toEqual(["E"]);
  });

  it("没有内容时 finish 不触发回调", () => {
    let calls = 0;
    const k = new StraightKeyer(() => {
      calls += 1;
    }, 50);
    k.finish();
    expect(calls).toBe(0);
  });

  it("onKeying 跟随按键起停，供侧音发声", () => {
    const keying: boolean[] = [];
    const k = new StraightKeyer(() => {}, 50, (on) => keying.push(on));
    k.keyDown(0);
    k.keyDown(10); // auto-repeat: 不重复触发
    k.keyUp(60);
    expect(keying).toEqual([true, false]);
  });

  it("按着键时 finish/clear 会把音调停掉", () => {
    const keying: boolean[] = [];
    const k = new StraightKeyer(() => {}, 50, (on) => keying.push(on));
    k.keyDown(0);
    k.finish();
    expect(keying).toEqual([true, false]);

    const k2 = new StraightKeyer(() => {}, 50, (on) => keying.push(on));
    k2.keyDown(0);
    k2.clear();
    expect(keying).toEqual([true, false, true, false]);
  });
});

/**
 * The iambic input class owns the timing loop, so tests inject both the clock
 * and the tick driver — no real timers, fully deterministic.
 */
function manualIambic(mode: "A" | "B" = "A") {
  let clock = 0;
  const drivers: Array<() => void> = [];
  const texts: string[] = [];
  const symbols: string[] = [];
  const keying: boolean[] = [];

  const input = new IambicKeyerInput({
    wpm: 20, // dot = 60 ms
    mode,
    onText: (t) => texts.push(t),
    onSymbols: (s) => symbols.push(s),
    onKeying: (on) => keying.push(on),
    now: () => clock,
    startTicking: (cb) => {
      drivers.push(cb);
      return () => {
        const i = drivers.indexOf(cb);
        if (i >= 0) drivers.splice(i, 1);
      };
    },
  });

  /** Move the clock to `t` and run every registered tick callback once. */
  const tick = (t: number): void => {
    clock = t;
    for (const cb of [...drivers]) cb();
  };

  return { input, texts, symbols, keying, tick, drivers };
}

describe("IambicKeyerInput", () => {
  it("敲完一个点后自动 flush 出字符", () => {
    const { input, texts, tick } = manualIambic();
    input.press("dot");
    tick(60);
    input.release("dot");
    expect(texts).toEqual([]); // 还在等字符间隔

    tick(240); // 1d 元素间隔 + 2d = 3d 字符间隔结束
    expect(texts).toEqual(["E"]);
  });

  it("停久一点（距上一元素 7d）自动补一个空格", () => {
    const { input, texts, tick } = manualIambic();
    input.press("dot");
    tick(60);
    input.release("dot");
    tick(240); // 3d 字符间隔结束，E 收尾
    expect(texts).toEqual(["E"]);

    // 再停 4d（相对收尾时刻）= 距上一元素 7d：下一个字符算新词。
    tick(240 + 4 * 60);
    input.press("dot");
    tick(540);
    input.release("dot");
    tick(720);

    expect(texts).toEqual(["E", " ", "E"]);
  });

  it("finish 收尾时把已开始的元素发完", () => {
    const { input, texts, tick } = manualIambic();
    input.press("dot");
    tick(10); // 元素刚开始
    input.finish();
    expect(texts).toEqual(["E"]);
  });

  it("squeeze 时点划交替，Mode A 松开即停", () => {
    const { input, tick } = manualIambic("A");
    input.press("dot");
    input.press("dash");
    tick(60); // 点结束
    tick(120); // 元素间隔结束 -> 划开始
    tick(300); // 划结束
    input.release("dot");
    input.release("dash");
    tick(600); // 字符间隔结束

    expect(input.text()).toBe("A"); // .-
  });

  it("同样的 squeeze，Mode B 会补发记忆的元素", () => {
    const { input, tick } = manualIambic("B");
    input.press("dot");
    input.press("dash");
    tick(60);
    tick(120);
    tick(300);
    input.release("dot");
    input.release("dash"); // 此时补发记忆的点
    tick(900);

    expect(input.text()).toBe("R"); // .-.
  });

  it("clear 清空已发内容", () => {
    const { input, texts, tick } = manualIambic();
    input.press("dot");
    tick(60);
    input.release("dot");
    tick(240);
    expect(texts).toEqual(["E"]);

    input.clear();
    expect(input.text()).toBe("");
    expect(input.currentSymbols()).toBe("");
  });

  it("onKeying 只在元素发声时为真，自动间隔期间保持静默", () => {
    const { input, keying, tick } = manualIambic();
    input.press("dot");
    expect(keying).toEqual([true]); // 点在发

    tick(60); // 点结束，进入 1d 元素间隔
    expect(keying).toEqual([true, false]);
    input.release("dot");
    expect(keying).toEqual([true, false]); // 间隔里松开也不重复触发

    input.press("dash"); // 下一个元素开始
    tick(120);
    expect(keying).toEqual([true, false, true]);
  });

  it("clear / finish 时若还在发声会先把音调停掉", () => {
    const { input, keying, tick } = manualIambic();
    input.press("dot");
    tick(10); // 元素刚开始
    input.clear();
    expect(keying).toEqual([true, false]);

    const second = manualIambic();
    second.input.press("dot");
    second.tick(10);
    second.input.finish();
    expect(second.keying).toEqual([true, false]);
  });
});
