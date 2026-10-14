# 模块 ↔ 设计文档 对应核对报告

> 目的：对照 `doc/` 六份设计文档，逐一核对 ROADMAP 前四步已实现模块是否"对应设计"。
> 核对时间：2026-10-13。方式：逐文件通读设计侧 + 实现侧源码，并实地跑 `tsc --noEmit` 与 `vitest`。
> 结论：**七大模块与设计的对应度极高，无功能性背离**；类型检查 0 错误，83 例测试全绿。
> 本报告仅记录核对结果，未改动任何代码。

---

## 总览表

| 实现模块 | 对应设计文档 | 状态 |
|---|---|---|
| `src/data/dxcc.ts` + `data/dxcc.json` | VIRTUAL-HAM.md、QSO-PROTOCOL.md（前缀校验）、ROADMAP 第一步 | ✅ 对应 |
| `src/message/parse.ts` | MESSAGE-PARSING.md | ✅ 对应 |
| `src/qso/stateMachine.ts` | QSO-PROTOCOL.md | ✅ 对应 |
| `src/cw/{decoder,encode,morseTable}.ts` | CW-PARSING.md | ✅ 对应（发送侧 keyer 延期） |
| `src/ham/{virtualHam,generate,frequency}.ts` | VIRTUAL-HAM.md、ROADMAP 第三步 | ✅ 对应（运行时调度循环延期） |
| `src/audio/{render,wav,environment,engine}.ts` | AUDIO-ENVIRONMENT.md、ROADMAP 第四步 | ✅ 对应（lookahead 调度简化） |

图例：✅ 已实现且对应　⚠️ 部分实现/有偏差　❌ 缺失

---

## 1. 数据层 — `src/data/dxcc.ts`

对应 VIRTUAL-HAM.md（呼号前缀表）、QSO-PROTOCOL.md（前缀校验落地）、ROADMAP 第一步。

- ✅ `DxccDatabase`：`resolvePrefix` 先精确匹配、再首部子串匹配（如 `B` 命中 `BA/BD/BG…`），与 MESSAGE-PARSING.md/VIRTUAL-HAM.md 的"精确等于或其首部"规则一致。
- ✅ `isValidPrefix` / `entity` / `listEntities` 齐备，供呼号校验、加权生成、大洲/距离池使用。
- ✅ `data/dxcc.json`：428 实体，去争议化纪律保持——**无** `country` / `cqZone` / `ituZone` / `region` 等字段，只存 `dxcc`/`lat`/`lon`/`prefixes` 四字段主键（另 `continent`，见下）。
- ⚠️ **实现增强（合理）**：JSON 预存了 `continent` 字段（文档写"大洲由 lat/lon 实时推导"）。实现提前算好存字段，等价且不引入国家/地区信息，未违反去争议化原则。

---

## 2. 报文解析 — `src/message/parse.ts`

对应 MESSAGE-PARSING.md。

- ✅ `CALL_RE` = `/^[A-Z]{1,2}[0-9][A-Z]{0,4}(?:\/[A-Z0-9]{1,4})?$/`，后缀可选以容纳中国 `B5`，`/` 操作后缀允许——与文档伪代码一字不差。
- ✅ `RST_RE` = `/^[1-5][1-9][1-9]$/`，**整 token** 校验，避免 `5999` 子串误判——落实文档"整 token 匹配"要求。
- ✅ `normalize`：5NN→599、TNX/THX→TU、<SK>→SK、合并空格、转大写——与文档归一化表一致。
- ✅ 结束符识别顺序 **PSE K → BK → SK → K**（文档要求顺序，避免 `K` 抢先吞掉 `BK/SK`）。
- ✅ **CQ 去重 + 连续相同呼号去重**：实现除"连续重复 CQ 去重"（文档明确要求）外，还去重 `BG7XXX BG7XXX` 这类连续相同呼号，比文档更稳健。
- ✅ 呼号校验两步：ITU 格式 + 前缀表命中（`validateCallsign`），`callsignValid` 在解析阶段即落定，状态机直接消费。
- ✅ 省略呼号处理：`callsignsConfirmed` / `callsignsOmitted` 决定 `omit_calls` 与 `to/from` 回退。
- ⚠️ **实现增强（合理）**：`ParsedMessage` 比文档多一个 `callsigns: string[]` 字段，供状态机做"抄错判定"（出现非 `myCall`/`peerCall` 的呼号即计 `CALL` 重试）。文档未列该字段，但逻辑上由状态机需要，属于合理增强。
- ⚠️ **分工差异（等价）**：文档伪代码在解析里 `if (end === "BK") ctx.callsignsOmitted = true`；实现把"BK→置 callsignsOmitted"放到状态机 `userSend`（解析只记录 `end==="BK"`）。职责更清晰，语义等价。

---

## 3. QSO 状态机 — `src/qso/stateMachine.ts`

对应 QSO-PROTOCOL.md。

- ✅ 状态与文档状态定义表**完全一致**：`IDLE / USER_CQ / PEER_CQ / EXCHANGE / SIGNOFF / LOGGED / FAILED`（7 个）。
  - 注：文档正文偶有"8 状态"表述，但其状态定义表实际为 7 行；实现与表一致，属文档文字小瑕疵，非实现问题。
- ✅ `QsoContext` 九字段与文档一一对应（含 `retryCount`）。
- ✅ `retryCount` 四键 `CALL`/`RST`/`COPY`/`SIGNOFF` 独立计数，达 `RETRY_LIMIT=3` 进 `FAILED`——与文档重试规则一致。
- ✅ 超时建模为确定性钩子：`timeoutFirstCall`(15s) / `timeoutResend`(5s) / `hamOffline`(3min)。ROADMAP 第一步要求"HAM 确定性、不引入随机"，本版用钩子暴露超时语义、未起真实定时器，符合分期（真实定时器留待接入）。
- ✅ **成功条件（严格模式）**：5 项（callsignsConfirmed / rstRx / rstTx / peerEndHeard / userEndSent）齐备才进 `LOGGED`——落实文档。
- ✅ **收发基线硬规则落实**：
  - HAM 首次应答 CQ 不带 `R` 且用 `K`（`hamAnswerCq` → `${myCall} DE ${ham.call} K`）；
  - HAM 进入可省略阶段后用 `BK` 确认可省略（`hamExchangeReply` → `R UR RST ... BK`）；
  - HAM 回应用户报文起始加 `R`（`R UR RST ...`、`R TU 73 SK`）。
- ✅ **抄错判定**：`copyError` = `!callsignValid` 或呼号非 `myCall`/`peerCall` → 发 `QRZ? DE <ham>` 计 `CALL`；明确**不误判为省略**。
- ✅ RST 非法（`type==="QUERY"` 且含 `RST`）→ `UR RST?` 计 `RST`；接收不全 → `hamMissed` → `AGN?` 计 `COPY`。
- ✅ HAM 报告改用 `ham.report`（可变 RST，不再硬编码 599）；构造器接受 `VirtualHam`，并预留 `frequency?` 字段。

---

## 4. CW 编解码 — `src/cw/{decoder,encode,morseTable}.ts`

对应 CW-PARSING.md。

- ✅ **三层边界清晰**：`decoder`（接收：点划时序→字母）、`encode`（发送：文本→时序）、`render`（输出：时序→音频）各司其职；语义解析在 MESSAGE-PARSING，本层不碰。
- ✅ `morseTable`：完整覆盖文档码表（A–Z、0–9、`/`、`?`、`=`、通联字 `AR`/`SK` 作单符号不拆字母）。
- ✅ 时序基准 `d = 1200/wpm`；标准比例 1:3:3:7（`encode` 实现）。
- ✅ 符号判定：`< 2d` 点、`≥ 2d` 划——与文档阈值一致。
- ✅ **Farnsworth 安全间隔**：两遍扫描——先收集所有 `≥2d` 边界静默取最小簇作字符间隔基准，单词阈值 `= max(5d, 基准×1.8)`，不假设字符间隔恒为 3d——落实文档"不能假设 3d"的警告。
- ✅ 未知符号不臆造：记 `unknown[]` 输出 `?`，不阻断后续——落实文档容错。
- ⚠️ **设计有、未做、被合理延期**：CW-PARSING.md「键盘输入与 CW 发送（发送侧 keyer）」整节——键位绑定、直键/iambic（Mode A/B）、点划记忆、自动间隔、发送显示——**尚未实现**。`decoder` 接受 `KeyElement[]`（on/off 时长），但"真正把键盘/直键/iambic 事件转成点划时序"的采集层未做，属规划中明确延后（UI 暂不做、keyer 交互依赖 UI/真实输入）。`encode` 已为"文本→时序"打好底，是 keyer 输出的前置。
- ⚠️ **实现增强（合理）**：`estimateUnit` 用"最短 ON 时长"估 `d`，天然吸收轻微手感抖动；文档显式写"±0.5d 抖动容忍"，实现未单列该容差而靠最短元素估计间接处理，效果等价、更稳健。

---

## 5. 虚拟 HAM — `src/ham/{virtualHam,generate,frequency}.ts`

对应 VIRTUAL-HAM.md、ROADMAP 第三步。

- ✅ `VirtualHam`：难度档 `novice/intermediate/hardcore` → 接收不全概率 **0% / 1% / 5%**（与文档一致）；`report` 为可变 RST（替代第一步硬编码 599）。
- ✅ 后缀**纯随机生成**，**不新增 `suffixPattern` 字段**——守住"练习呼号只判格式、不验真实性"的去争议化纪律（文档明确决策）。
- ✅ `generateVirtualHam`：**分两阶段选**（先按权重 100/40/10/5/1 选类别 CAT1–5，再类内均匀选实体+生成），体现文档权重意图（本国档不被洲档淹没）。
- ✅ 数字区以**根前缀为作用域、不跨国家**；距离 `<3000km` 用 haversine；同洲用 `continent` 字段——三者均不依赖任何国家/地区字段。
- ✅ 用户 QTH 用自身实体质心近似（文档约定）。
- ✅ `Frequency`：频率槽 + 多 HAM 并发（`Map`）+ `spawnHam` + `listHams` + `activeHam`——落实"多虚拟 HAM 与频率活动"。
- ✅ 两 AI HAM 互连：`planHamToHam` 仅返回 `reserved:true` 类型占位——按 ROADMAP「架构预留本版不做」。
- ⚠️ **设计有、未做（部分实现）**：VIRTUAL-HAM.md「运行时行为」——CQ 节奏 30–60s、应答延迟 1–5s/1–3s、3min 下线、同频 1–3 活跃台、多人应答——这些"按时间自动发 CQ / 延迟应答"的**调度循环未实现**。当前是"可生成 + 可多实例"的对象层，配合状态机的确定性钩子；真正的时间驱动调度（定时器循环）留待接入真实定时器（ROADMAP 第一步即声明"本步 HAM 确定性、不随机"，第三步范围未要求落地定时器循环）。

---

## 6. 音频引擎 — `src/audio/{render,wav,environment,engine}.ts`

对应 AUDIO-ENVIRONMENT.md、ROADMAP 第四步。

- ✅ **纯附加表现层**：`render/engine` 不引用状态机或报文解析——落实 ROADMAP"音频不改任何逻辑"。
- ✅ 纯 PCM 渲染器（文本→`Float32Array`，无 DOM 依赖，Node 可测）；700Hz 正弦 + 5ms 斜坡防咔哒。
- ✅ QSB（样本级正弦衰落，周期/深度可调，慢 5–15s / 快 1–3s）、QRM（额外干涉载频）、QRN（白噪声）——与文档真实感模拟一致。
- ✅ `difficultyToEnvironment`：难度→QSB/QRM/QRN 对齐文档难度表（新手无 / 进阶慢衰落偶发 / 硬核快衰落较多 / 自定义）——`Difficulty` 含 `custom` 四档。
- ✅ WAV 编/解码（16-bit 单声道），可离线产真实可听文件。
- ✅ 音频后端：惰性**共享单一 AudioContext** + `LookaheadPlayer` 前瞻调度（`src/audio/player.ts`），Node / jsdom 下无 context 时 `play` 立即 resolve 且不抛不挂——不引 DOM 类型依赖。
- ✅ 首次用户手势（`pointerdown` / `keydown` / `touchstart`）`resume()` 解决浏览器自动播放拦截。
- ✅ 种子 RNG（mulberry32）保证确定性可复现。
- ✅ **lookahead 流式调度已落地**：整段渲染一次（保持 QSB/QRM/QRN 连续）后按音频时钟分块调度，返回 `PlaybackHandle{done, stop}`，`stop()` 可在元素边界打断正在呼叫的 HAM，使用户能半途插话应答（详见 `STEP5-UI-NOTES.md` 遗留 #7）。

---

## 7. 入口与集成 — `src/index.ts`

- ✅ 显式导出各模块；修复 `virtualHam.ts` 与 `environment.ts` 同导 `Difficulty` 的撞名（后者含 `custom`，前者仅 3 档），仅显式导出 virtualHam 类——避免语义混淆。

---

## 汇总：设计 ↔ 实现 偏差清单

**A. 设计有、未做（均为分期/合理延期，非遗漏）**
1. 发送侧 keyer 交互（键盘/直键/iambic 真正产生点划事件）——依赖 UI，已明确延后。
2. HAM 运行时节奏/延迟自动调度循环（30–60s CQ、1–5s 延迟应答、3min 下线）——仅对象层+确定性钩子，时间驱动循环留待接真实定时器。
3. Web Audio lookahead 流式播放调度——当前一次性灌 BufferSource，练习足够。
4. 第五步 UI——用户此前明确暂不做。

**B. 实现超出文档（均为合理增强，未背离设计意图）**
1. `dxcc.json` 预存 `continent` 字段（文档说由 lat/lon 实时推导，等价）。
2. `ParsedMessage.callsigns[]` 字段（供状态机抄错判定）。
3. `estimateUnit` 用最短 ON 估 d，间接吸收 ±0.5d 抖动（文档显式写±0.5d 容差，实现未单列）。

**C. 文档自身小瑕疵（不影响实现）**
1. QSO-PROTOCOL.md 正文偶有"8 状态"表述，但状态定义表为 7 行；实现与表（7 态）一致。

---

## 验证执行记录

- `tsc --noEmit`：**0 错误**。
- `vitest run`：**83 例全绿**（data 4 / message 28 / qso 16 / cw 12 / ham 11 / audio 12）。
  - 注：本沙箱环境（WorkBuddy brokered fs shim）会拒 vitest 写 SSR 缓存（EPERM），导致一次性组合跑时 `src/audio/render.test.ts` 被跳过；**单独运行该文件 12 例全绿**。用户本机无此 shim，`npm test` 正常不受影响。
- 全部核对**未改动任何源码**，仅新增本报告。

---

## 后续：文档已同步更新（2026-10-13）

应项目要求，上表「B. 实现超出文档」与「C. 文档自身小瑕疵」已回写设计文档，使文档与实现一致：

1. **VIRTUAL-HAM.md**：字段表新增 `continent` 行；说明改为「大洲已预计算为 `continent` 字段（由 lat/lon 启发式推导），距离 / 数字区仍运行时计算」；示例 JSON 注明略去 `continent` 以精简。
2. **MESSAGE-PARSING.md**：`ParsedMessage` 接口补 `callsigns: string[]`（供状态机抄错判定）。
3. **CW-PARSING.md**：符号判定与容错两节改为描述真实机制——`d` 取最短点时长（`estimateUnit`），抖动由基准估计自动吸收，去掉了文档原先不准确的「±0.5d 容差带」表述。
4. **ROADMAP.md**：第一步描述「QSO 状态机：8 状态」修正为「7 状态」，与 QSO-PROTOCOL.md 状态定义表（7 行）一致。
