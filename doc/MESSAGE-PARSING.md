# 报文解析（字母文本 → 结构化报文）

> 本文件负责把 CW 解码产出的**字母文本** → **结构化报文**（`ParsedMessage`）的语义解析，供 [QSO 协议](./QSO-PROTOCOL.md) 的状态机消费。
> 上游：字母文本由 [CW 编解码](./CW-PARSING.md) 的摩斯解码层产出；下游：状态机见 [QSO 协议](./QSO-PROTOCOL.md)；虚拟 HAM 策略见 [虚拟 HAM 策略](./VIRTUAL-HAM.md)。

---

## 输入与输出

- 输入：一串大写字母文本（如 `CQ CQ CQ DE BG7XXX BG7XXX PSE K`），由摩斯解码层产出，已合并多余空格、统一大写。
- 输出：`ParsedMessage` 结构（见下）。

## 归一化规则

| 原始 | 归一化 |
|---|---|
| `5NN` | `599` |
| `TNX` / `THX` | `TU` |
| `<SK>` | `SK` |
| 多空格 | 单空格 |
| 小写 | 大写 |

> 归一化只处理「写法变体」，不改变语义；呼号本身不做归一化（保持用户所抄）。

## RST 格式与校验

合法 RST 是三位数字，每位独立约束：

```regex
^[1-5][1-9][1-9]$
```

- 第一位（可辨度）：1–5
- 第二位（强度）：1–9（不为 0）
- 第三位（音调）：1–9（不为 0）

示例（合法）：`599`、`589`、`579`、`5NN` → `599`（先经归一化）

不合法示例：`5999`（四位）、`ABC`、`59`（两位）、`5NNN`（归一化后仍非三位数字）

> **校验对象（明确）**：RST 是对**独立的 RST token** 校验，不是对整条消息。解析时先在分词后的消息 token 中找出形如三位数字、且**整体匹配**上述正则的 token（即整 token 匹配 `^[1-5][1-9][1-9]$`），才认定为 RST；消息中偶然出现的三位数字子串（如呼号里的数字、或其他数字）不会被误判。为避免 `5999` 这类被词边界 `\b` 部分命中，务必用「整 token 匹配」而非「消息内子串搜索」。

不合法时，虚拟 HAM 发：

```text
UR RST?
```

## 解析器输出结构

```typescript
interface ParsedMessage {
  to: string | null;        // 接收方呼号，或 "CQ"
  from: string | null;      // 发送方呼号
  type: "CQ" | "CALL" | "RST" | "END" | "QUERY" | "UNKNOWN";
  rst: string | null;       // 归一化后的 RST
  end: "PSE_K" | "K" | "BK" | "SK" | null;
  omit_calls: boolean;      // 是否省略了呼号
  callsignValid: boolean;   // 提取到的呼号是否通过格式 + 前缀表校验（供状态机判抄错 / 非法）
  callsigns: string[];      // 提取到的全部呼号 token（已对连续重复去重），供状态机做抄错判定（出现非 myCall/peerCall 的呼号即计 CALL 重试）
  raw: string;              // 原始文本
}
```

> `callsignValid` 由解析器在提取呼号 token 时即执行校验（见「呼号合法性校验」），状态机消费时直接读取，无需重复校验。

## 解析流程

```text
1. 转大写，合并空格
2. 识别结束符：PSE K / K / BK / SK / 无
3. 移除 DE
4. 提取呼号 token，并对每个呼号 token 做合法性校验（格式 + 前缀表）
5. 根据上下文判断 to / from
6. 识别消息类型
7. 处理 BK：记录「用户使用过 BK」（callsignsOmitted 语义见 QSO 协议——仅作显式记录，省略资格的唯一判据是 callsignsConfirmed）
8. 返回 ParsedMessage
```

## 重复的 CQ 去重

标准惯例 `CQ` 重复三遍（`CQ CQ CQ`）。第 4 步提取呼号 token 时，需先对连续重复的 `CQ` 去重为一个，否则 `CQ CQ CQ DE BG7XXX…` 会被误判为 `to = CQ, from = CQ`（发送方变成 `CQ` 而非用户呼号）。去重后再进入第 5 步的 to / from 判定。

## 呼号合法性校验（前缀表落地）

> 这一步把 [QSO 协议](./QSO-PROTOCOL.md) 中「呼号合法性在消费前校验」的要求在此落地。

提取到呼号 token 后，对每个非 `CQ` 的呼号 token 执行两步校验：

1. **ITU 格式**：匹配 `[A-Z]{1,2}[0-9][A-Z]{0,4}(/[A-Z0-9]{1,4})?`（后缀字母可选，以容纳中国 `B5` 这类异地 / 便携呼号；`/` 操作后缀仍允许）。
2. **前缀表命中**：从呼号提取「字母前缀」（首个数字前的字母，并先去掉 `/...` 操作后缀），该字母前缀必须命中 `data/dxcc.json` 的 `prefixes` 全集——要么精确等于某个 token，要么是其首部子串（如 `B` 是 `BA` / `BD` / `BG` / … 的首部）。

- 两步都通过 → `callsignValid = true`。
- 任一不通过（如杜撰前缀 `ZZ1ABC`、格式非法）→ `callsignValid = false`。
- 状态机据此判断：若已确认 `peerCall` 而本条呼号 `callsignValid == false` 或与 `peerCall` 不一致，均计 `CALL` 重试并发 `QRZ?`——**切勿误当作「省略呼号」处理**，否则会掩盖用户的抄号错误。

## 呼号省略处理

- 若报文无呼号，且 `callsignsConfirmed` 或 `callsignsOmitted` 为真：
  - 用户发送：`to = peerCall`，`from = myCall`
  - 对方发送：`to = myCall`，`from = peerCall`
- `BK` 后用户仍可带呼号，不视为错误
- 只要双方呼号已明确，可随时省略呼号
- 省略资格的唯一判据是 `callsignsConfirmed`（见 [QSO 协议](./QSO-PROTOCOL.md)）

## 用户发 PSE K 的处理

- 用户在后续阶段发 `PSE K` 不视为错误
- 虚拟 HAM 正常回应
- 虚拟 HAM 自身不会在后续阶段发 `PSE K`

---

## 报文解析伪代码（实现参考）

> 该实现消费摩斯解码产出的字母文本，并遵循 [QSO 协议](./QSO-PROTOCOL.md) 定义的报文格式规范。

```typescript
// ITU 呼号格式（后缀字母可选，以容纳 B5 这类异地/便携呼号）
const CALL_RE = /^[A-Z]{1,2}[0-9][A-Z]{0,4}(?:\/[A-Z0-9]{1,4})?$/;
const RST_RE = /^[1-5][1-9][1-9]$/;  // 整 token 匹配

function validateCallsign(token: string): boolean {
  if (!CALL_RE.test(token)) return false;
  // 去掉 /... 操作后缀，取首个数字前的字母前缀
  const base = token.split("/")[0];
  const prefix = base.replace(/[0-9].*$/, "");  // 首个数字前的字母
  // 命中 data/dxcc.json 的 prefixes 全集：精确等于或为首部子串
  return DXCC_PREFIXES.some((p: string) => prefix === p || prefix.startsWith(p));
}

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

  // 4. 提取呼号 token + 合法性校验
  const tokens = text.split(" ");
  const calls: string[] = [];
  const msgTokens: string[] = [];
  let callsignValid = true;
  for (const t of tokens) {
    if (t === "CQ") { calls.push("CQ"); }
    else if (CALL_RE.test(t)) {
      calls.push(t);
      if (!validateCallsign(t)) callsignValid = false;  // 标记非法（交由状态机判抄错）
    }
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

  // RST：对独立 token 整 token 匹配，避免子串误判
  const rstTok = msgTokens.find((t) => RST_RE.test(t));
  if (rstTok) {
    rst = rstTok;
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

  // 7. 处理 BK（仅记录用户使用过 BK；省略资格判据见 QSO 协议）
  if (end === "BK") {
    ctx.callsignsOmitted = true;
  }

  return { to, from, type, rst, end, omit_calls: omitCalls, callsignValid, raw };
}
```
