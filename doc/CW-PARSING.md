# CW 解析与编码（输入 → 报文 → 音频）

> 对应设计目标的第一块：CW 的解析（用户键盘输入 → 结构化报文）以及报文转音频（文本 → CW 音频）。
> 相关：报文「格式规范」见 [QSO 协议](./QSO-PROTOCOL.md)；音频环境（底噪/QSB/QRM）见 [音频与电磁环境](./AUDIO-ENVIRONMENT.md)；UI 见 [UI 界面](./UI.md)。

---

## 键盘输入与 CW 发送

### 键位绑定

- 用户可自定义
- 直键：一个键
- iambic：点键 + 划键
- 默认建议：空格为直键；左右 Ctrl 或左右 Shift 为 iambic 点划

### 直键（Straight Key）

- 按下发 CW，松开停止
- 用户手动控制点划时长

### iambic 键

支持两种模式：

| 模式 | 行为 |
|---|---|
| Mode A | 松开双桨时，只完成当前元素，不发送记忆的下一个元素 |
| Mode B | 完成当前元素后，还会发送记忆的下一个元素 |

两种模式均可切换。

### 辅助功能

| 功能 | 说明 |
|---|---|
| 点划记忆 | 按点后按划，会发送点划 |
| 自动字符间隔 | 系统自动插入 3 单位间隔 |
| 自动单词间隔 | 用户按空格或特定键，系统插入 7 单位间隔 |

### 发送显示

- 仅辅助模式显示实时解码文本
- 不统计错误率

---

## 报文解析（用户输入 → 结构化报文）

> 解析器的任务：把用户通过键盘/键发出的文本（或未来从 paddle 时序还原的文本）转换为 `ParsedMessage` 结构，供 [QSO 协议](./QSO-PROTOCOL.md) 的状态机消费。

### 归一化规则

| 原始 | 归一化 |
|---|---|
| `5NN` | `599` |
| `TNX` / `THX` | `TU` |
| `<SK>` | `SK` |
| 多空格 | 单空格 |
| 小写 | 大写 |

### RST 格式与校验

合法 RST：

```regex
^[1-5][1-9][1-9]$
```

示例：

- `599`
- `589`
- `579`
- `5NN` → `599`

不合法示例：

- `5999`
- `ABC`
- `59`
- `5NNN`

不合法时，虚拟 HAM 发：

```text
UR RST?
```

### 解析器输出结构

```typescript
interface ParsedMessage {
  to: string | null;        // 接收方呼号，或 "CQ"
  from: string | null;      // 发送方呼号
  type: "CQ" | "CALL" | "RST" | "END" | "QUERY" | "UNKNOWN";
  rst: string | null;       // 归一化后的 RST
  end: "PSE_K" | "K" | "BK" | "SK" | null;
  omit_calls: boolean;      // 是否省略了呼号
  raw: string;              // 原始文本
}
```

### 解析流程

```text
1. 转大写，合并空格
2. 识别结束符：PSE K / K / BK / SK / 无
3. 移除 DE
4. 提取呼号 token
5. 根据上下文判断 to / from
6. 识别消息类型
7. 处理 BK：设置 callsignsOmitted = true
8. 返回 ParsedMessage
```

### 重复的 CQ 去重

标准惯例 `CQ` 重复三遍（`CQ CQ CQ`）。第 4 步提取呼号 token 时，需先对连续重复的 `CQ` 去重为一个，否则 `CQ CQ CQ DE BG7XXX…` 会被误判为 `to = CQ, from = CQ`（发送方变成 `CQ` 而非用户呼号）。去重后再进入第 5 步的 to / from 判定。

### 呼号省略处理

- 若报文无呼号，且 `callsignsConfirmed` 或 `callsignsOmitted` 为真：
  - 用户发送：`to = peerCall`，`from = myCall`
  - 对方发送：`to = myCall`，`from = peerCall`
- `BK` 后用户仍可带呼号，不视为错误
- 只要双方呼号已明确，可随时省略呼号

### 用户发 PSE K 的处理

- 用户在后续阶段发 `PSE K` 不视为错误
- 虚拟 HAM 正常回应
- 虚拟 HAM 自身不会在后续阶段发 `PSE K`

---

## 报文转音频（编码 / CW keyer）

> 把一条结构化/文本报文按 WPM 与 Farnsworth 规则编码为 CW 音频（点/划时序 + 700 Hz 音调）。

### 速度与时序

- WPM 范围：**5 – 40**，默认 **20**
- 支持 Farnsworth 间隔
- 标准比例：点 : 划 : 字符间隔 : 单词间隔 = **1 : 3 : 3 : 7**

### CW 音调生成

- 默认：**700 Hz**
- 可调范围：**400 – 1000 Hz**
- 波形：正弦波
- 实现：`OscillatorNode` 生成 700 Hz 正弦波（见 [音频与电磁环境](./AUDIO-ENVIRONMENT.md) 音频架构）

---

## 报文解析伪代码（实现参考）

> 该实现直接消费 [QSO 协议](./QSO-PROTOCOL.md) 定义的报文格式规范。

```typescript
function parseMessage(raw: string, ctx: QsoContext, direction: "rx" | "tx"): ParsedMessage {
  // 1. 归一化
  let text = raw.toUpperCase().replace(/\s+/g, " ").trim();
  text = text.replace(/5NN/g, "599");
  text = text.replace(/\bTNX\b|\bTHX\b/g, "TU");
  text = text.replace(/<SK>/g, "SK");

  // 2. 识别结束符
  let end: ParsedMessage["end"] = null;
  if (/\bPSE\s+K\b/.test(text)) { end = "PSE_K"; text = text.replace(/\bPSE\s+K\b/, ""); }
  else if (/\bBK\b/.test(text)) { end = "BK"; text = text.replace(/\bBK\b/, ""); }
  else if (/\bSK\b/.test(text)) { end = "SK"; text = text.replace(/\bSK\b/, ""); }
  else if (/\bK\b/.test(text)) { end = "K"; text = text.replace(/\bK\b/, ""); }
  text = text.trim();

  // 3. 移除 DE
  text = text.replace(/\bDE\b/g, " ").replace(/\s+/g, " ").trim();

  // 4. 提取呼号 token
  // ITU 呼号格式：1–2 字母前缀 + 数字 + 1–4 字母后缀（见 QSO-PROTOCOL.md「用户呼号」）
  const CALL_RE = /^[A-Z]{1,2}[0-9][A-Z]{1,4}(?:\/[A-Z0-9]{1,4})?$/;
  const tokens = text.split(" ");
  const calls: string[] = [];
  const msgTokens: string[] = [];
  for (const t of tokens) {
    if (t === "CQ") { calls.push("CQ"); }
    else if (CALL_RE.test(t)) { calls.push(t); }
    else { msgTokens.push(t); }
  }

  // 5. 判断 to / from
  let to: string | null = null;
  let from: string | null = null;
  let omitCalls = false;

  if (calls.length === 0) {
    if (ctx.callsignsConfirmed || ctx.callsignsOmitted) {
      omitCalls = true;
      to = direction === "tx" ? ctx.peerCall : ctx.myCall;
      from = direction === "tx" ? ctx.myCall : ctx.peerCall;
    }
  } else if (calls.length === 1) {
    const c = calls[0];
    if (c === "CQ") {
      to = "CQ";
      from = direction === "tx" ? ctx.myCall : ctx.peerCall;
    } else if (c === ctx.myCall) {
      to = ctx.myCall;
      from = direction === "tx" ? ctx.myCall : ctx.peerCall;
    } else if (c === ctx.peerCall) {
      to = ctx.peerCall;
      from = direction === "tx" ? ctx.myCall : ctx.peerCall;
    } else {
      to = c;
      from = direction === "tx" ? ctx.myCall : null;
    }
  } else {
    to = calls[0];
    from = calls[1];
  }

  // 6. 识别消息类型
  let type: ParsedMessage["type"] = "UNKNOWN";
  let rst: string | null = null;

  const rstMatch = text.match(/\b[1-5][1-9][1-9]\b/);
  if (rstMatch) {
    rst = rstMatch[0];
    type = "RST";
  } else if (/\bRST\b/.test(text)) {
    type = "QUERY";
  } else if (/\b(TU|73|SK)\b/.test(text)) {
    type = "END";
  } else if (/\b(QRZ\?|AGN\?|\?)\b/.test(text)) {
    type = "QUERY";
  } else if (calls.includes("CQ")) {
    type = "CQ";
  } else if (calls.length > 0) {
    type = "CALL";
  }

  // 7. 处理 BK
  if (end === "BK") {
    ctx.callsignsOmitted = true;
  }

  return { to, from, type, rst, end, omit_calls: omitCalls, raw };
}
```
