# 第五步 UI：实现说明与遗留问题

分支：第五步的工作已作为 **PR #7（squash）合入 `master`**（分支原名 `feat/keyer-sidetone`，推送前改名为 `feat/app-v1`）。其后的原型迭代见下方 Prototype 章节，当前在 `feat/ui-v2` 上。本文件是进度说明，不是设计文档，故放在仓库根而非 `doc/`。

---

## Prototype v2（2026-10-15，分支 `feat/ui-v2`）

用户验收 v1 后提出的三条改动，均在本分支完成（基于已合入的 `master`）：

1. **开台 / 关台开关**：默认**关台**，避免一打开就被突发的虚拟 HAM 报文惊到。`App` 新增 `powered` 状态与 `setPower()`。（关台的语义见下方 v2.1 更正——它**只关接收**，不关环境。）
2. **电台风格界面**：外壳改为常驻**电台面板**（频率大号显示 + 波段 + 模式 `CW` + 开台/关台 + 设置齿轮），下方一条"波段频谱"示意条（真实瀑布图/频谱属后续版本）。二级导航精简为 **电台 / 日志 / 关于**；**设置**由独立页面改为齿轮弹出的**模态框**。原"频率页"与"CW 翻译页"合并为单一**电台页**（调谐 + 波段活动 + 通联面板）；通联进行中时在同页显示收发记录 / 发送 / 电键输入。
3. **呼号生成修复**：`src/ham/generate.ts` 的呼号后缀由 1–3 位改为 **2–3 位**（原先会生成 `BG4I` 这类非法呼号）；新增回归测试。

涉及文件：`src/ui/app.ts`（重写外壳）、新增 `src/ui/pages/radio.ts`、`src/ui/pages/cw.ts` 导出改为 `renderQsoPanel`、`src/ui/pages/settingsPage.ts` 导出改为 `renderSettingsPanel(host)`、删除 `src/ui/pages/frequency.ts`；`src/ham/generate.ts`；`src/ui/styles.css`（电台 / 电源 / 频谱 / 模态框样式）。

验证：`tsc` 0 错；`vite build` 通过（39 模块，JS 87.16 kB / CSS 7.24 kB）；**全套 277 例通过**（28 文件，较 v1 的 271 例 +6）。

### v2.1 更正：关台只是「不接收」，环境不随人下线（2026-10-15）

v2 首版把关台实现成了「停调度器 + 停音频 + 清空当前波段」，这是错的。用户指出：要模拟真实环境，**虚拟 HAM 在启动时就应在所有波段上生成并持续活动**，关台只是不接收——「真实环境并不是我一下线大家也跟着下线的」。

改法：

- `App` 改为**每个波段持有一个 `QsoSession`**（共 4 个），启动时全部 `seedHams()` + `start()`：**环境在开机前就已经在所有波段上运行**，且永不因电源状态而重建/清空。
- `QsoSession` 新增 `setReceiving(on)` / `isReceiving`：这只是"接收机的开关"。关台时**不接话、不发声、不发射**（`handleActivity` 不再把 CQ 接入会话、`engine.stop()`、`userSend`/`userCallsCq` 直接拒绝），但 `Frequency.advance()` 照常推进——到点仍呼叫、超时仍下线补位。**频段、台上的台、进行中的通联全部原样保留。**
- 只有「开着台 + 当前波段」才在接收；其余波段在后台静默运行。
- 切波段 = 接收跟着人走，旧波段**不拆掉**（切回去还是同一个会话与同一批台）；波段内 ±1 kHz 调谐只 `retune()` 拨轮频率，不换台（1 kHz 不该等于换一批台）。
- 关台界面上会说明「本频段仍有 N 个电台在活动」，让"环境不随人下线"这件事**可见**。

涉及文件：`src/ui/app.ts`（每波段会话 + `applyReceiving` / `watchBand`）、`src/ui/session.ts`（`receiving` / `retune`）、`src/ui/pages/radio.ts` + `styles.css`（待机文案）；新增 `src/ui/session.power.test.ts`（7 例）。

---

## Prototype v3：频谱瀑布图（2026-10-15，分支 `feat/ui-v2`）

用户要求把 v2 里那条"示意频谱条"做成**真的瀑布图**：窗口 ±10 kHz、CW 信号按强度显示为亮斑、**调谐时只有最上方新画的行在动**，因此调频会在瀑布上拖出一条曲线。

实现（无新增依赖，全部在本仓库内）：

- **数据模型** `src/ham/spectrum.ts`（新）：`SpectrumSignal` / `SpectrumSnapshot`、`SPECTRUM_SPAN_HZ = 20_000`、`BAND_SIGNAL_SPREAD_HZ = 25_000`（v3.7 前为 9_000）、以及装饰性**背景弱载波**生成。
  - `VirtualHam` 增加 **`freqHz`（绝对频率 Hz）** 与 **`strength`（0..1）**。频率是**绝对值**，不是相对拨轮的——这正是"调谐会画出斜线"的原因：动的不是信号，是窗口。
  - `generateVirtualHam` 按波段参考频率（`referenceHz`）把台散布在 ±25 kHz 内（v3.7 前为 ±9 kHz）并给出强度（强度由它报告的 RST 决定，配一点按呼号哈希的个体差异，**不消耗会话 RNG**）。`Frequency` 透传 `referenceHz` / `spreadHz`。
  - 除可通联的台之外还有 8–15 个**装饰性背景载波**（v3.7 前为 3–6 个）（`workable: false`、强度 < 0.45），让波段看起来像真实波段；它们不参与通联。
- **渲染器** `src/ui/waterfall.ts`（新，canvas）：纯函数 `renderRow` / `brightnessToRgb` / `freqAtX` / `xAtFreq` / `easeCenter` / `keyingLevel` / `keyingSeed` 全部可单测；`Waterfall` 类负责滚动（`drawImage` 自拷贝下移 1 行 + `putImageData` 写新行）、显示中心缓动、点击调谐、启停与 dispose。
  - **调谐曲线**：每一行用**该行时刻的显示中心**计算，历史不动；显示中心以约 190 ms 时间常数缓动跟随拨轮，把"一步一跳"抹成平滑曲线。
  - **CW 点划**：正在呼叫的台按确定性的 CW 键控包络（种子来自呼号 + 频率）呈现点划；守听的台只留一条很暗的载波。
  - **点击调谐**：点击瀑布把拨轮调到该处；落在可通联电台附近（±300 Hz）自动吸附。关台时拒绝调谐。
  - **可测性**：时钟（`now`）与帧调度（`schedule`）可注入；`context: null` 可无头运行；**2D context 延迟到元素真正有布局时才获取**，因此在 jsdom 下既不报错也不刷新噪声。
- **接线**（`src/ui/app.ts`）：瀑布图放在常驻电台面板里，**canvas 与标签只建一次**、跨重绘复用（canvas 的画面存在元素里，重建会丢历史——即"可变状态不放 DOM"这条铁律的又一例）。开台才滚动，关台**冻结**并压暗，标签提示"本波段其他电台仍在活动"。`App.tuneTo(hz)` 负责点击调谐（夹在当前波段内）。
- 电台页的信号强度条改为**取当前波段最强台的 `strength`**，与瀑布图给同一信号的亮度一致。

涉及文件：新增 `src/ham/spectrum.ts(+test)`、`src/ui/waterfall.ts(+test)`、`src/ui/session.spectrum.test.ts`；改 `src/ham/{virtualHam,generate,frequency}.ts`、`src/ui/{session,app,styles.css}.ts`、`src/ui/pages/radio.ts`、`src/ui/storage/qsoStaging.ts`（暂存快照带上 `freqHz`/`strength`，刷新后恢复到原位）。

验证：`tsc` 0 错；`vite build` 通过（41 模块，JS 96.61 kB / CSS 7.22 kB）；**全套 332 例通过**（32 文件，较 v2.1 的 291 例 +41）。

---

## Prototype v3.1：CW 偏频——失谐时听到的音调（2026-10-15，分支 `feat/ui-v2`）

用户指出：CW 监听时若频率没对上，**听到的声音会有音调偏移**（原理与 SSB 的 LSB/USB 偏频相同，40m 及以下用 LSB、20m 及以上用 USB）。此前实现里所有 HAM 报文都按设定的 CW 音调播出，**调谐只影响画面、不影响听感**——这项是缺的。

实现（`src/ham/tuning.ts` 为新模块，纯逻辑、可单测）：

- `heardToneHz({ toneHz, stationHz, dialHz })` = `音调 ± (对方频率 − 拨轮频率)`，符号由边带决定：**USB 取 +、LSB 取 −**。正对频（两边相等）时恰好回到设定音调。
  - 于是**往上调拨轮**：USB 音调变低、LSB 音调变高（与真实电台一致）。
- `sidebandFor(freqHz)`：**低于 10 MHz 用 LSB，10 MHz 及以上用 USB**（80m / 40m → LSB，20m / 15m → USB）。
- 音调夹在 **250 – 1800 Hz**。真实接收机的 CW 通带只有几百 Hz 宽，失谐过大音符会跑出可听范围；这里保持**单调**映射再夹住，让"偏离越多越明显"始终成立（**有意简化**：不模拟过零点折回与通带之外的完全静音）。
- `QsoSession.playHam()` 用该模型算出**对方报文实际播出的音调**（用 `...extra` 覆盖 `play()` 里的默认音调）；`dialHz` / `partnerToneHz()` / `partnerDetuneHz()` 供界面读取。**用户自己的发报不受影响**——自己的信号永远正对频。
- 界面：电台面板的模式旁新增**边带徽标**（`CW` `USB` / `LSB`）；通联面板状态行显示对方**当前实际被听到的音调**，偏频 ≥50 Hz 时标出偏移量（"音调 880 Hz · 偏频 +180 Hz"，用 `.hint.tone-off` 着色）。这样"瀑布上看到的位置"与"耳朵听到的音"能对上。

顺带修正 `doc/AUDIO-ENVIRONMENT.md` 中与实现不符的频段表（原写 7/14/21/28 MHz、100 Hz 步进，实际是 80m/40m/20m/15m 与 1 kHz 步进）。

涉及文件：新增 `src/ham/tuning.ts` + `tuning.test.ts`、`src/ui/session.tuning.test.ts`；改 `src/ui/session.ts`、`src/ui/app.ts`、`src/ui/pages/cw.ts`、`src/ui/styles.css`、`src/ui/pages/cw.test.ts`、`src/ui/app.test.ts`；文档 `doc/AUDIO-ENVIRONMENT.md`、`doc/UI.md`。

验证：`tsc` 0 错；`vite build` 通过（42 模块，JS 97.53 kB / CSS 7.26 kB）；**全套 353 例通过**（34 文件，较 v3 的 332 例 +21）。

---

## Prototype v3.2：频率读数 / 500 Hz 通带 / 1 kHz 电台网格（2026-10-16，分支 `feat/ui-v2`）

用户补充了三条现实约束，其中两条此前没有实现：

1. **CW 显示的频率就是信号载波频率**——把拨轮对到 7.010000、PITCH 设 700 Hz，听到的就是 700 Hz，**不需要在读数上再加 700 Hz**。这条 v3.1 已经满足（正对频即设定音调），这次在代码注释与文档里写明，并补了直白的测试。
2. **接收机滤波带宽 500 Hz**，中心在拨轮上：**±250 Hz 以内收得到，之外收不到**。
3. **虚拟 HAM 的发送频率以 1 kHz 为单位**——7.010 的隔壁就是 7.011，避免互相干扰。

实现：

- **通带（`src/ham/tuning.ts`）**：新增 `PASSBAND_HZ = 500` / `PASSBAND_HALF_HZ = 250`、`inPassband(stationHz, dialHz)`、`audibleToneHz(opts)`（通带内给音调，通带外给 `null`）。`heardToneHz` 保持原样（纯映射 + 夹取），通带判断单独一层。
  - **通带外的台不只是"音调怪"，而是完全听不到**：`QsoSession` 里通带外的 CQ 事件直接跳过（不接话、不发声、不选为通联对象），`playHam()` 遇到 `null` 音调就整条不播。波段上其它台照常按节奏呼叫——瀑布图上看得到，只是没在听。
  - 由此"必须先找到并调准信号"成了真实操作节奏：`heardActiveHam()` 只认通带内的台；`nearestWorkableHam()` 给"搜索"用（最近的台，不论多远）。
- **1 kHz 网格（`src/ham/spectrum.ts` / `generate.ts`）**：新增 `SIGNAL_GRID_HZ = 1000` / `snapToGrid()` / `SIGNAL_GRID_SLOTS`，`placeFreq` 改为对齐网格（原 10 Hz 量化删除，`quantiseHz` 一并移除），装饰性背景载波同样对齐。`Frequency.spawnHam` 新增第 5 个位置参数 `atHz`（把台钉在某频率上），并新增落点去重：与同波段的台撞格或撞呼号就重抽（`atHz` 指定的除外）。
  - 500 Hz 通带 + 1 kHz 间距 ⇒ **一个通带里永远只容得下一台**，这正是用户说的"避免互相干扰"。
- **界面**：瀑布图正中用 CSS 叠出通带的**两条边界线**（宽度由 `PASSBAND_HZ / SPECTRUM_SPAN_HZ` 内联算出，固定居中，因为显示与滤波器都以拨轮为中心）；电台页新增 **±100 Hz 微调**按钮（原来只有 ±1 kHz，无法体验偏调音色与通带边缘）；波段活动列表改为「呼号 / 频率 + 相对偏移 / 状态 / 通带内·通带外」，通带内为空时明说；S 表只统计通带内的台。
  - **「监听：等 HAM 发 CQ」**：通带内已有台就直接听；否则**自动把拨轮扫到波段上最近的台**再让它呼叫（等价于用手扫旋钮）。波段上没有台时按钮置灰。
  - **「我发 CQ」**：应答者一定在**拨轮频率**上——通带内没有台时就在拨轮频率处新建一台（`spawnHam(dialHz)`），这正是空中发生的事。
  - 通联面板状态行：通带内显示"音调 N Hz · 偏频 ±M Hz"，调出通带则改为"对方已在通带之外（偏 ±N Hz）· 调回 ±250 Hz 才听得到"。

**行为变化（需要知道）**：v3.1 里"往旁边调 1 kHz，声音变得很尖"的现象**不再成立**——1 kHz 早就出了 500 Hz 通带，听到的是静默。这是新规格的直接结果，也是"用耳朵把信号调进通带"这一练习想要的效果。

涉及文件：改 `src/ham/spectrum.ts`(+test)、`src/ham/tuning.ts`(+test)、`src/ham/generate.ts`、`src/ham/frequency.ts`、`src/ui/session.ts`、`src/ui/app.ts`、`src/ui/bands.ts`、`src/ui/pages/radio.ts`、`src/ui/pages/cw.ts`、`src/ui/styles.css`，以及各测试文件（多数是"先把拨轮对准台，再让它呼叫"的适配）；文档 `doc/AUDIO-ENVIRONMENT.md`、`doc/VIRTUAL-HAM.md`、`doc/UI.md`。

验证：`tsc` 0 错；`vite build` 通过（42 模块，JS 99.95 kB / CSS 7.61 kB）；**全套 365 例通过**（34 文件，较 v3.1 的 353 例 +12）。

---

## Prototype v3.3：CW 边带可切换（CW-L / CW-U）与可调滤波带宽（2026-10-16，分支 `feat/ui-v2`）

用户提出两项操作自由度：

1. **边带要能由用户切**：方向虽有频段约定，但要给一个可切换的选项，命名为 **`CW-L` / `CW-U`**（**日志里永远是 `CW`**）；波段只决定**初始**是 L 还是 U，**模式标签本身可点**来切换。
2. **滤波带宽给几个选项**：**500 / 250 / 100 Hz**。

实现：

- **纯逻辑（`src/ham/tuning.ts`）**：新增 `SidebandPreference`（`"auto" | "LSB" | "USB"`）、`resolveSideband(pref, dialHz)`（`auto` 时跟随 `sidebandFor`）、`sidebandLabel()`（`CW-L` / `CW-U`）、`otherSideband()`；新增 `PASSBAND_OPTIONS = [500, 250, 100]` 与 `normalisePassband()`（非选项值一律回落到 500）。`inPassband()` 增加可选带宽参数、`TuningOptions` 增加 `passbandHz`，**默认仍是 500 Hz**，既有调用与测试不受影响。
- **设置（`src/ui/settingsSchema.ts`）**：新增 `cwSideband`（默认 `"auto"`）与 `passbandHz`（默认 500，非法值回落）。
- **会话（`src/ui/session.ts`）**：新增 `sideband` / `passbandHz` / `passbandHalfHz` getter；通带判定（`canHear`、`heardActiveHam`、`unheardHams`、`partnerInPassband`）与 `hamToneHz` 全部改用当前设置。
- **界面**：电台面板原本的「`CW` 徽标 + 独立边带徽标」合并成**一个可点的模式标签 `CW-L` / `CW-U`**——点一下翻到另一侧并**固定**（不再跟随波段），再点翻回；设置面板新增「**CW 接收**」区块，含「CW 边带」（自动 / CW-L / CW-U，用来恢复跟随波段）与「接收滤波带宽」（500 / 250 / 100 Hz）。瀑布图正中的通带标记**宽度改为跟随所选带宽**（500 Hz = 窗口的 2.5%，100 Hz = 0.5%）；电台页与通联面板里写死的 ±250 Hz 改为按当前带宽显示。

**口径**：`CW-L` / `CW-U` 是**接收侧的操作偏好**（哪一侧边带解调），不是工作模式——日志字段恒为 `CW`（`logRecord.mode` 的类型就是字面量 `"CW"`，有测试锁死）。

涉及文件：改 `src/ham/tuning.ts`(+test)、`src/ui/settingsSchema.ts`(+test)、`src/ui/session.ts`(+test)、`src/ui/app.ts`(+test)、`src/ui/pages/{radio,cw,settingsPage}.ts`(+test)、`src/ui/logRecord.ts`、`src/ui/styles.css`；文档 `doc/AUDIO-ENVIRONMENT.md`、`doc/VIRTUAL-HAM.md`、`doc/UI.md`。

验证：`tsc` 0 错；`vite build` 通过（42 模块，JS 101.76 kB / CSS 7.87 kB）；**全套 380 例通过**（34 文件，较 v3.2 的 365 例 +15）。

---

## Prototype v3.4：堆叠应答（pile-up）（2026-10-19，分支 `feat/ui-v2`）

用户排了四项功能（优先级从高到低）：**堆叠 → HAM 互相通联 → 滤波器衰减 → S 表优化**，要求一项一项来。本轮只做第一项。

**设计口径**（用户确认 / 纠正后）：

- 发 CQ 后 **2–3 台**同时应答，全部落在**呼叫者的拨轮频率**上（CW 堆叠里大家零拍同一个目标）。因此**1 kHz 网格不适用于应答者**——网格约束的是「波段上守听 / 自行呼叫的台」；堆叠应答者按定义就在同一频率上。
- **没点名不散场，而是各自静默后重呼**：每台报完呼号静默 **3–7 秒**（各自独立抽取，用来岔开），到点且用户没在发报就重呼；用户正在发报时各台守听，看这条报文是否叫到自己。每台最多重复 **4 次**，都没被点名则离场。
- **点名是唯一推进条件**：回复里出现某台呼号，该台成为通联对象，其余离场；被点名者回 `R UR RST ... BK`，**不再重发一次 `MYCALL DE HAM`**（它刚才已经报过）。
- 关台不产生堆叠；堆叠不写暂存，刷新即失去。

**实现**：

- **纯逻辑（`src/ham/pileup.ts`）**：`PileupCaller`（`ham` / `spawned` / `nextCallAt` / `calls`）、`pileupSize`（2–3）、`pileupSilenceMs`（3–7 s）、`pileupCallText`（呼号连报两遍）、`matchCaller`（整句里找呼号，取**最先出现**的那台；大小写不敏感）。
- **状态机（`src/qso/stateMachine.ts`）**：新增 `beginUserCq()`（堆叠阶段只有 CQ、还没有 partner）与 `hamAcceptedSelection()`（点名后直接进入 `EXCHANGE`、写入 `rstRx`、返回 `R UR RST ... BK`）。
- **会话（`src/ui/session.ts`）**：`pileup` 字段与 `pileupCallers()` / `heardPileupCallers()` / `isPileupCaller()`；`state` 在「有堆叠、无 machine」时合成 `USER_CQ`，`inQso` 同视为进行中。`userCallsCq` 改为**只阻塞 CQ 本身**、应答者按「前一台报完 + 0.5–1.5 s」排程（用 `textToTiming` 实算报码时长，避免单声道下互相切断）；`drivePileup()` 每 tick 只放一台，`answerPileup()` 负责点名 / 不点名两条路径；`spectrum()` 的 `active` 增加「正在发报」的键控窗口（`keyingUntil`）。
- **界面**：`cw.ts` 状态行加「N 台同时应答」，发送区改为**每个已听到的台的「点名 X」按钮**（并按 `calls > 0` 过滤——没报过呼号的台不是你能抄到的名字），加一句「必须点名」的提示；`app.ts` 瀑布图标签改为「N 台同时应答 · 回复时请点名」，右上角显示「堆叠 ×N」。
- **容量**：为堆叠临时生成的台在离场时**下线**（不占波段常驻名额）；原本就在波段上的台回到守听。

涉及文件：新增 `src/ham/pileup.ts`(+test)、`src/ui/session.pileup.test.ts`；改 `src/qso/stateMachine.ts`、`src/ui/session.ts`、`src/ui/pages/cw.ts`(+test)、`src/ui/app.ts`、`src/ui/session.activity.test.ts`；文档 `doc/VIRTUAL-HAM.md`、`doc/QSO-PROTOCOL.md`、`doc/UI.md`。

验证：`tsc` 0 错；`vite build` 通过（42 模块，JS 105.52 kB / CSS 7.87 kB）；**全套 395 例通过**（36 文件，较 v3.3 的 380 例 +15）。

---

## Prototype v3.5：波段更热闹——每波段 5–9 台（2026-10-19，分支 `feat/ui-v2`）

用户反馈「一个波段只有三个台吗？我觉得可以有更多」。这是个纯密度调整，不动任何交互语义。

- **数量**：`ACTIVE_HAMS_MIN / MAX` 由 **1–3** 改为 **5–9**，每个波段各自抽一次并固定。真实 CW 波段就该是「一片信号」，而不是一两个台。
- **容量上限来自频谱**：台站仍对齐 **1 kHz 网格**、落在波段参考频率 **±9 kHz** 内，共 **19 个槽位**（`SIGNAL_GRID_SLOTS`）。台一多，随机落点撞车的概率明显上升，所以 `spawnHam` 的重抽次数 **8 → 16**，并且仍撞车时**改落一个空槽**（`freeSlotHz`，在空闲槽里随机挑），不再把两台叠在同一列。装饰载波（3–6 个）另算，最多时约 15 / 19 列有内容。
- **补位语义修正**：`seedHams(n)` 现在把 n 同时设为**补位目标**（原来只补到会话的随机默认值）。所以「显式设 3 台」在有人 3 分钟无应答下线后仍是 3 台，而不是跳回 5–9。
- **要更多需要放宽频谱**：19 是 ±9 kHz / 1 kHz 网格的硬上限。想再往上（比如十几二十台）得把台站摊到更宽的波段切片上，那样瀑布窗口一次只看得见其中一部分——**调谐时会不断遇到新台**，是另一种体验。→ **已在 v3.7 采纳**。

涉及文件：`src/ham/activity.ts`、`src/ham/frequency.ts`、`src/ui/session.ts`、`src/ham/activity.test.ts`、`src/ham/ham.test.ts`、`src/ui/session.activity.test.ts`；文档 `doc/VIRTUAL-HAM.md`。

验证：`tsc` 0 错；`vite build` 通过（42 模块，JS 105.94 kB / CSS 7.87 kB）；**全套 398 例通过**（36 文件，较 v3.4 的 395 例 +3）。

---

## Prototype v3.6：HAM 互相通联（2026-10-19，分支 `feat/ui-v2`）

四项功能队列的第 ② 项。口径此前已定：**随机发生、两台同频、用户不可插话**，且波段要 ≥3 台（两台互连 + 至少留一台给操作者）。

- **纯逻辑（`src/ham/hamQso.ts`）**：`hamQsoScript(a, b)` 返回标准 6 行（CQ → 应答 → RST → RST → 73 → 73）；`hamQsoIntervalMs`（30–90 s）、`hamQsoGapMs`（0.6–1.6 s）；`pickHamQsoPair` 只从**非通联中**的台里挑，并且**优先挑正在呼叫 CQ 的那台**当呼叫方——这正是现实里「有人应了正在发的 CQ」。`HAM_QSO_MIN_STATIONS = 3`。
- **为什么不用 `QsoMachine`**：状态机的价值在于解释**操作者输入**（抄错、省略呼号、重发），而两台虚拟台没有输入可解释。脚本更短、更可测，也不会污染操作者自己的 `machine`。
- **会话（`src/ui/session.ts`）**：`hamQso` 状态 + `driveHamQso()`（每 tick 按 `now` 推进一行）、`startHamQso()` / `endHamQso()`。应答方通过新增的 `Frequency.moveHam()` **调到呼叫方频率**，结束后**回到原频点**（原位被占则落到空槽）。`VirtualHam.freqHz` 因此由 `readonly` 改为可变。
- **不能插话**：两台标记 `inQso`，自然被排除在 `heardActiveHam` / `nearestWorkableHam` 之外，也不会应答操作者的呼叫。操作者在这个频率发 CQ 时**不生成堆叠应答**（v3.7 修订：原先写的是"静默让位"，用户指出应当是插不进去）；签完 73 后呼叫方由 `resumeCq()` 隔 2–6 s 重新呼叫。
- **对操作者不可见（v3.7 修订，见下节）**：真实情况下看不到别人是否在通联，所以界面上不留任何痕迹；`spectrum()` 对这对台仍**只画一根亮柱**（同频，这是物理事实而非提示），键控窗口取两者较晚者。
- **不插入的场合**：操作者自己有通联或堆叠时不启动（单声道音频会互相切断）；关台/在别的波段时照常推进，只是听不到。

涉及文件：新增 `src/ham/hamQso.ts`(+test)、`src/ui/session.hamQso.test.ts`；改 `src/ham/virtualHam.ts`、`src/ham/frequency.ts`、`src/ui/session.ts`、`src/ui/pages/radio.ts`(+test)、`src/ui/app.ts`；文档 `doc/VIRTUAL-HAM.md`、`doc/QSO-PROTOCOL.md`、`doc/UI.md`、`doc/ROADMAP.md`。

验证：`tsc` 0 错；`vite build` 通过（42 模块，JS 109.79 kB / CSS 7.87 kB）；**全套 415 例通过**（38 文件，较 v3.5 的 398 例 +17）。

---

## Prototype v3.7：波段更宽、互相通联不可见（2026-10-19，分支 `feat/ui-v2`）

用户两点反馈：
1. 「真实情况是看不到 HAM 之间是否在通信的。我不要这个功能。」
2. 「调谐过程中遇到新台，这是一种真实的体验，所以要这样。」——采纳 v3.5 末尾预留的「放宽频谱」路线。

- **互相通联彻底不可见**：删掉 `HamQsoView` 与 `hamQsoInfo()` / `isHamQsoStation()` / `hamQsoPartnerOf()`——会话层不再提供查询，UI 就无从泄漏。活动列表不再单列 `A ↔ B`，徽标不再写「与 X 通联」（`ACTIVITY_LABEL` 换成 `activityLabel()`，`inQso` 与「守听」显示成同一件事），瀑布标签与右上角的相关分支删除。后台通联本身、以及「两台不会被当成可通联对象」的语义**原样保留**：唯一线索是调过去听到的报文。
- **发 CQ 不再被拒绝，也插不进去**：`userCallsCq()` 里「频率被占用」的早退与提示删除。若那一对就在当前通带上，`formPileup()` 直接返回空——**没有台应答**（正在通联的人不会丢下对方去应一个陌生呼叫），CQ 照常发出去、然后安静下来，界面不解释任何事；「我发 CQ」也不再置灰。（最初的写法是让那一对"静默让位"，用户否掉了：**应当是插不进去，而不是把别人赶走**。）
- **通联结束后呼叫方继续呼叫**：`HamActivity.resumeCq()` + `Frequency.resumeCq()`。原来两台一律 `markListening()`（退回 30–60 s 常规间隔），现在**呼叫方隔 2–6 s 重新呼叫 CQ**并重置放弃计时，应答方照旧回原频点守听。于是"等他们通联完了再上去"有了真实的入口。
- **`userSend()` 无对象时静默 return**：原来会提示「正在通联，无法插话」（发送框本来只在有通联时出现）。
- **波段切片放宽**：`BAND_SIGNAL_SPREAD_HZ` **9 kHz → 25 kHz**（51 个 1 kHz 槽位），`ACTIVE_HAMS_MIN/MAX` **5–9 → 12–18**，装饰背景载波 **3–6 → 8–15**（按切片同比放大，窗口内的观感不变）。25 kHz 是挑出来的数：四个波段的默认中心 ±25 kHz 都正好落在频段边界之内（7.000–7.050、14.000–14.050……），不会把台摆到频段外。
- **窗口仍比波段窄**：瀑布保持 `SPECTRUM_SPAN_HZ = 20 kHz`（±10 kHz）。新增纯函数 `inSpectrumWindow(hz, centerHz)`，电台页「波段活动」列表与瀑布标签的计数都**只算窗口内的台**——把看不见的台列出来就等于把「调谐找人」降级成读清单。「监听」按钮仍扫全波段最近的台（等价于手动扫旋钮）。调谐面板补一句：台站散布 ±25 kHz，瀑布只看得到 ±10 kHz。
- **没有做的事**：`nearestWorkableHam()` 不变（搜索本来就要穿过整段）；没有给窗口加缩放/滚动——窗口宽度属于「这台电台的屏幕」，不该由用户拉伸。

涉及文件：`src/ham/spectrum.ts`(+test)、`src/ham/activity.ts`(+test)、`src/ham/frequency.ts`、`src/ui/session.ts`、`src/ui/app.ts`、`src/ui/pages/radio.ts`(+test)、`src/ui/session.hamQso.test.ts`、`src/ui/session.activity.test.ts`；文档 `doc/VIRTUAL-HAM.md`、`doc/UI.md`、`doc/QSO-PROTOCOL.md`、`doc/ROADMAP.md`。

验证：`tsc` 0 错；`vite build` 通过（44 模块，JS 108.62 kB / CSS 7.87 kB）；**全套 418 例通过**（38 文件）。较 v3.6 净 +3：删掉 2 例「互连可见性」UI 测试，新增 2 例 `inSpectrumWindow`、1 例「插不进去」与 1 例「结束后续呼」，另把 `activity` 的区间用例补齐。

---

## 技术选型

**原生 TypeScript + Vite，零运行时依赖。**

UI 本身仍然不引框架，理由是与项目既有约定一致——核心逻辑是纯 TS 模块，UI 只做 DOM 呈现层。

> **更正（2026-10-14）**：此前写着「沙箱内 npm install 走不通（代理 502），不能引入新依赖」，**这条是错的**。实测在同一环境下 `npm ping` → `PONG`、`npm view jsdom version` → `30.1.2`、`npm install` 均正常。被拦的只是 **git 的 HTTPS CONNECT 隧道**，npm registry 走普通 HTTPS 请求不受影响，不能由前者推出后者。

据此新增了两个 **devDependency，仅用于测试，不进运行时 bundle**（`vite build` 产物 38 模块 / 83.11 kB，与加装依赖前一致）：

| 包 | 用途 |
|---|---|
| `jsdom` | 让 UI 测试跑在真实 DOM 上（测试文件以 `// @vitest-environment jsdom` 逐文件声明） |
| `fake-indexeddb` | jsdom 不提供 IndexedDB，用它补上才能覆盖日志的写入 / 编辑 / 清空 |

`tsconfig.json` 的 `lib` 增加了 `DOM`（TypeScript 自带 `lib.dom.d.ts`，无需装 `@types`）。

## 已完成的功能

### 页面（5 个，按 UI.md）

| 视图 | 内容 |
|---|---|
| 电台 | 波段切换、±1 kHz 主调谐 / ±100 Hz 微调、信号强度条、虚拟 HAM 活跃列表（含通带内外）、两种发起通联的方式；进入通联后同页显示收发记录 / 发送 / 电键输入 |
| 日志 | 表格（DATE/TIME_UTC/CALL/FREQ_MHZ/MODE/RST_RX/RST_TX）、逐行编辑保存、清空全部、常驻水印 |
| 关于 | 免责声明、版本、项目范围 |
| 设置（齿轮弹出的模态框） | 呼号（带校验）、音调、WPM、Farnsworth 开关与速度、CW 边带、接收滤波带宽、难度、辅助模式、电键类型与键位绑定、iambic A/B、侧音开关与音量 |

### 其他

- **免责声明**：首次启动弹窗（确认后不再弹出）、关于页、日志页水印、页脚，四处文案统一由 `src/ui/disclaimer.ts` 提供。
- **存储**：设置走 localStorage，日志走 IndexedDB；严格不提供导出功能。
- **日志自动写入**：满足 UI.md 六个条件（LOGGED + 呼号已确认 + 双向 RST + 双方结束语）才写入，且用 `logWritten` 标记防重复。
- **辅助模式**：默认关闭；关闭时对方报文显示为 `█`，可逐条点「显示」对照，不写日志、不做标记。
- **电键**：直键输入走既有 `MorseDecoder`；点/划由最短按键时长估计点单位判定，无需精确对齐设定速度。
- **难度联动音频**：HAM 发报按难度叠加 QSB/QRM/QRN；并按 `missProbability` 概率触发接收不全（`AGN?`）。

### 新增文件

```
index.html
src/ui/styles.css              暗色主题样式
src/ui/css.d.ts                CSS 导入类型声明
src/ui/dom.ts                  DOM 小工具
src/ui/bands.ts (+test)        四个频段与调谐
src/ui/settingsSchema.ts(+test) 设置默认值/校验/呼号校验
src/ui/logRecord.ts (+test)     日志字段推导与写入条件
src/ui/disclaimer.ts           免责声明文案
src/ui/session.ts              QSO 会话（状态机+HAM+音频）
src/ui/keyer.ts                直键输入
src/ui/app.ts                  外壳/导航/设置更新
src/ui/main.ts                 入口
src/ui/storage/settingsStore.ts localStorage
src/ui/storage/logStore.ts     IndexedDB
src/ui/pages/{radio,cw,logPage,settingsPage,about}.ts
```

## 验证结果

- `tsc --noEmit`：**0 错误**
- `vite build`：**通过**（42 模块，JS 105.94 kB / CSS 7.87 kB；测试依赖 jsdom / fake-indexeddb 不进生产包）
- 测试：**全套 418 例通过**（38 个文件）
  - Prototype v3.7 波段切片 / 互连不可见 / 插不进去 **净 +3 例**：`src/ham/spectrum.test.ts` 新增 2 例（`inSpectrumWindow` 的边界与可指定宽度）；`src/ui/pages/radio.test.ts` 删掉 2 例「互连可见性」、把「列出当前频率上的 HAM」改写为「**窗口内才列、窗口外不列**」；`src/ui/session.hamQso.test.ts` 6 例全部改写为**只凭可观测事实**断言（两台同频且都 `inQso`、调过去听得到 6 行、在这个频率发 CQ 无人应答、那一对照旧把话说完（插不进去）、签完 73 后呼叫方 2–6 s 内重新呼叫、不被当成可通联对象、结束后回原频点、自己通联时不插入）
  - Prototype v3.6 HAM 互相通联 **17 例**：纯逻辑 `src/ham/hamQso.test.ts` 8 例（6 行脚本的内容与交替顺序、30–90 s / 0.6–1.6 s 区间与越界钳制、至少 3 台、优先挑正在呼叫的台、只从非通联台里挑、永远选中两个不同台）；会话 `src/ui/session.hamQso.test.ts` 6 例（见 v3.7；v3.6 时曾是「在占用频率发 CQ 被拒」等可见性断言）；电台页 `src/ui/pages/radio.test.ts` 2 例（v3.7 已删）
  - Prototype v3.5 波段密度 **3 例**：`src/ham/activity.test.ts` 区间改为 12–18（含越界钳制与 `resumeCq` 的重呼延迟）、`src/ham/ham.test.ts` 1 例（连摆 12 台仍各自独占一个 1 kHz 槽位）、`src/ui/session.activity.test.ts` 2 例（默认播种得到 12–18 台且频率不重复；**显式设 3 台后补位仍回到 3 台**）
  - Prototype v3.3 边带切换 / 可调带宽 **15 例**：`src/ham/tuning.test.ts` 新增 5 例（`resolveSideband` 跟随波段或固定、模式标签 `CW-L` / `CW-U` 与 `otherSideband`、`PASSBAND_OPTIONS` 与 `normalisePassband` 回落、`inPassband` 自定义带宽边界 ±带宽/2、通带越窄越先静默）；`src/ui/settingsSchema.test.ts` 2 例（`cwSideband` 保留 LSB/USB 其余回落 auto、`passbandHz` 只接受 500/250/100）；`src/ui/session.tuning.test.ts` 4 例（20m 上固定 LSB → 音调方向反转、40m 上固定 USB → 反向、250 Hz 时偏 200 Hz 即听不到、100 Hz 时只有 ±50 Hz 内收得到）；`src/ui/app.test.ts` 新增/改写 3 例（模式标签随波段显示 CW-L / CW-U、**点击标签切换并固定**、**瀑布通带标记宽度跟随带宽** 2.5% → 0.5%）；`src/ui/pages/settingsPage.test.ts` 2 例（CW 边带与接收滤波带宽两个下拉的默认值、选项与提交）
  - Prototype v3.2 CW 通带 / 1 kHz 网格 **12 例**：`src/ham/tuning.test.ts` 新增 4 例（带宽 = 500 Hz / ±250 Hz 内外的 `inPassband` 分界 / `audibleToneHz` 通带内给音调、通带外给 null / **频率读数即载波频率**：PITCH 只决定侧音高低）、`src/ham/spectrum.test.ts` 1 例（`snapToGrid` 落到 1 kHz 格、装饰载波也在网格上）；`src/ui/session.tuning.test.ts` 重写为 12 例（通带内音调偏移 USB/LSB 方向、正对频回设定值、**通带边缘外 1 Hz 即静默**、**通联中调走 1 kHz 声音直接消失而不是变尖**、通带外的台不接入会话且一点声音都不播、空通带不会被自动选中、用户自己发报不受影响）；`src/ui/pages/radio.test.ts` 新增 5 例（**±100 Hz 微调**、通带与网格说明文案、活动列表标出通带内外、空波段「监听」置灰、有台时「监听」**自动把拨轮扫过去**、已对准时不扫描）；`src/ui/pages/cw.test.ts` 1 例（调出通带后状态行明说"已在通带之外"）
  - Prototype v3.1 CW 偏频 **21 例**：纯模型 `src/ham/tuning.test.ts` 9 例（边带划分含 10 MHz 分界、正对频回到设定音调、USB/LSB 方向相反、单调性、失谐线性不取整、上下限夹取、显式覆盖边带、`detuneHz` 带符号）、会话音频 `src/ui/session.tuning.test.ts` 9 例（用 `AudioPlayer` 记录**实际播出的音调**：USB 台在上方→音调升高、往上调拨轮→音调变低、LSB 反向、正对频→设定值、隔 1 kHz→夹到下/上限、跟随 `toneHz` 设置、**用户自己发报不受影响**、无通联对象时为 null）、`app.test.ts` 模式标签 1 例（40m `CW-L` / 20m、15m `CW-U`，v3.3 起改为点击切换并固定）、`cw.test.ts` 状态行音调读数 2 例
  - Prototype v3 瀑布图 **41 例**：`src/ui/waterfall.test.ts` 23 例 —— 亮度映射/坐标换算/缓动 **7 例**（亮度单调、`freqAtX`↔`xAtFreq` 互逆、缓动收敛不瞬移）、单行渲染 **5 例**（信号落列正确、**拨轮上移时同一绝对频率的信号向左移＝调谐曲线**、亮度随强度、空频段只有底噪、窗外信号不参与）、CW 键控 **4 例**、组件生命周期与点击调谐 **7 例**（无 context 不抛错、显示中心缓动、电源控滚动、点击交给 onTune / 附近吸附 / 远处不吸附、dispose 后不响应）；`src/ham/spectrum.test.ts` 6 例（±10 kHz、10 Hz 量化、可复现的 PRNG、背景载波弱且标记不可通联且按种子稳定）；`src/ui/session.spectrum.test.ts` 6 例（窗口中心＝拨轮、台都作为可通联信号、**调谐只移窗口不移台**、背景载波、同会话稳定、呼叫中的台标为 active）；`src/ui/app.test.ts` 瀑布图 6 例（canvas 存在、**重绘不换 canvas**、关台/开台文案、点击调谐含夹波段、关台拒绝调谐、会话提供频谱数据）
  - Prototype v2 / v2.1 **14 例**：`app.test.ts` 的环境与电源 4 例（各波段启动即有台 / 关台不清空 / 只有「开机 + 当前波段」在接收 / 换波段再换回不拆波段）、`radio.test.ts` 待机文案 2 例、新增 `session.power.test.ts` 7 例（关台不接话不发声 / 关台后频段仍运转且超时换台 / 关台不清空已建立通联 / 关台不发射 / 再开台续收 / 关台切断音频 / `retune` 不换台）、呼号后缀回归 1 例
  - UI 部分 **95 例**：其中 26 例是 node 环境纯逻辑（设置校验 13 / 日志推导 8 / 频段 5），**69 例是 jsdom 下的真实 DOM 交互测试**，含「跑完一次完整 QSO → 自动入库 → 日志页显示」的端到端用例
  - iambic 键控与侧音 **53 例**：核心 `src/cw/keyer.ts` 20 例（含 Mode A/B 差异、squeeze、CQ 往返解码）、UI 封装 10 例、CW 页双桨输入 5 例、设置页电键类型 2 例、侧音 16 例
  - HAM 自主发 CQ **27 例**：核心 `src/ham/activity.ts` 16 例（区间钳制、反复重呼、3 分钟下线、通联中不下线、恢复守听）、会话层接线 11 例（注入时钟与等待，含「通联中不被其他台呼叫打断」「下线后自动补位」）
  - 健壮性三项 **12 例**：错误边界面板 2 例 + `safeRenderPage` 边界 3 例（node/jsdom）、发送 busy 保护 2 例（node）、进行中通联暂存 5 例（jsdom，覆盖写入 / 草稿 / 刷新恢复 / 完成即清 / reset 即清）
  - 音频后端 **11 例**：lookahead 调度器 4 例（无 context 立即解析 / 按音频时钟分块覆盖整段 / stop 中断 / 新播放打断旧）、引擎 4 例（Node 无音频不抛不挂 / 存在 AudioContext 时可用 / 注入 context 走调度器 / stop 中断）、会话层音频插话 3 例（HAM CQ 不占用发送 / 用户插话切断环境音频 / 用户发送仍受 busy 保护）

> 沙箱内跑测试的注意点（本机无此问题）：多个测试文件并发时，vitest 写临时缓存会被 WorkBuddy 的 fs 沙箱拒 EPERM。规避方式是重定向临时目录并串行执行：
> `mkdir -p .vitest-tmp && TMP=$PWD/.vitest-tmp TEMP=$PWD/.vitest-tmp npx vitest run --no-file-parallelism`

## 遗留问题与限制

1. ~~**UI 没有自动化测试。**~~ **已解决（2026-10-14）**：装 `jsdom` + `fake-indexeddb` 后，五个页面的关键路径均已自动化覆盖——App 外壳与导航切换、首次免责弹窗与「我已知晓」、频率页频段/调谐/HAM 列表、CW 页遮蔽与单条揭示/宏/发送/新通联、日志页写入/编辑/清空与 IndexedDB 缺失时的降级、设置页呼号校验与各项保存/恢复默认、关于页免责与范围。**仍然无法自动化的是真实浏览器行为**：Web Audio 发声与自动播放限制、实际音频听感、`npm run dev` 下的视觉与手感——这些仍需你手动过一遍。
1. ~~**UI 没有错误边界，任一页面抛异常就整页白屏。**~~ **已解决（2026-10-14）**：`App.renderPage()` 改用 `safeRenderPage()` 包 try/catch，异常时就地渲染「该页面出错了」面板 + 重试按钮（`src/ui/errorPanel.ts`），导航、其他页面与后台 HAM 调度不受影响；`safeRenderPage` 与错误面板均有单测。
1. ~~**发送没有并发保护，连点会交错报文。**~~ **已解决（2026-10-14）**：`QsoSession` 增加 `sending` 标志，`userSend` / `userCallsCq` / `hamCallsCq` 发送中再次调用直接丢弃后续，并暴露 `isSending` 供 CW 页发送按钮在忙时禁用；有单测验证并发只生效一次、顺序发送不受影响。
1. ~~**刷新页面等于进行中的通联全部作废。**~~ **已解决（2026-10-14）**：`QsoMachine` 新增 `snapshot()` / `applySnapshot()` / `fromSnapshot()`；新增 `src/ui/storage/qsoStaging.ts` 把进行中的 QSO（状态机 + 对方 HAM + 收发记录 + 草稿）暂存到 localStorage，`App` 构造时 `restoreStaging()` 恢复，通联完成（`LOGGED`/`FAILED`）、`reset`、换频时清理，避免已完成的 QSO 被复活；有 jsdom 单测覆盖「写入—刷新—恢复—继续到完成」。
2. ~~**浏览器自动播放限制**：首次发声可能被浏览器拦截，需先有一次用户点击。~~ **已解决（2026-10-14）**：音频后端改为**惰性共享单一 AudioContext**，首次 `pointerdown` / `keydown` / `touchstart` 即 `resume()`（侧音自身的 context 早已如此处理），不再每次播放新建并关闭 context；Node / jsdom 下仍无 context、播放立即 resolve 且不抛不挂。
3. ~~**iambic 键控未实现**，设置里的 A/B 模式是预留项，当前只有直键。~~ **已实现（2026-10-14）**：核心 `src/cw/keyer.ts`（Mode A/B、squeeze 点划记忆、自动 3d/7d 间隔），UI 侧设置页可切「直键 / iambic」并绑定点划键位，CW 页支持双桨输入与空格分词。**侧音已实现（2026-10-14）**：`src/audio/sidetone.ts`，直键跟随按键、iambic 跟随元素起止，可在设置页开关与调音量（默认开、40%）。
4. ~~**HAM 之间互相通联仍是占位**（`planHamToHam`）。~~ **已实现（2026-10-19）**：`src/ham/hamQso.ts` + `QsoSession` 调度。波段 ≥3 台时随机发生、两台同频、按操作者速度播标准 6 行。**v3.7 起对操作者完全不可见**：没有「正在通联」标记、没有旁听入口；在这个频率上发 CQ 不会被拒绝，但也**没有人应答**——插不进去是真实行为，不是限制。签完 `73` 后原来那个呼叫方会隔 2–6 s 重新呼叫 CQ。`planHamToHam` 作为类型占位保留，不再代表「未实现」。
5. ~~**HAM 不会自主定时发 CQ**：频率页是「点按钮触发」。~~ **已实现（2026-10-14）**：核心 `src/ham/activity.ts` —— CQ 间隔 30–60 s 随机、无人应答时反复重呼、连续 3 分钟无应答下线、频段维持 **12–18** 个活跃；时钟与随机源全部注入、模块内无定时器，故 3 分钟的下线判定可在毫秒内测完。会话层 `QsoSession` 以 1 s 驱动循环推进它，应答延迟 1–5 s、回复延迟 1–3 s（取代原先硬编码的 1200 ms）。频率页显示各台状态（守听 / 呼叫 CQ 中；别人是否在通联**不可见**）。**交互约束**：用户已在交换中时，频段上其他台的呼叫不会被接入，以免打断进行中的通联。
6. **信号强度条**取**当前通带内**最强那台的强度（通带内没有台时为 0），不是真实传播模型；瀑布图上带外信号亮着但不会让 S 表起跳。
7. ~~**lookahead 流式播放调度**未实现（ROADMAP 已列为延后），当前是一次性灌 BufferSource。~~ **已实现（2026-10-14）**：新增 `src/audio/player.ts` 的 `LookaheadPlayer`——整段渲染一次（保持 QRN/QSB 连续）后按音频时钟分块前瞻调度，返回 `PlaybackHandle{done, stop}`，`stop()` 可随时在元素边界打断；`CwAudioEngine` 改用共享 context + 该调度器。HAM 连续发 CQ 时，用户可**半途插话应答**，会话层 `hamCallsCq` 不再占用 `sending`（HAM CQ 改为非阻塞、后台播放），`userSend` / `userCallsCq` 起始调用 `engine.stop()` 切断环境 HAM 音频；`reset` / `dispose` 亦停音频。
8. **全局快捷键**做不到：Web 页面失焦无法捕获键盘，需迁 Tauri 才能解决（UI.md 已知限制）。
9. **直键解码的已知边界**：点单位由最短按键时长估计，若一段报文全是划会导致误判（解码器既有说明）。
10. **设置项在失焦时提交**（change 事件），避免边输入边重渲染打断输入。
11. **辅助模式的「显示」状态只存在内存**，刷新页面后重置。
12. ~~**电键发报没有侧音**。~~ **已解决（2026-10-14）**：新增 `src/audio/sidetone.ts`，直键按下即响、松开即停，iambic 跟随元素阶段（自动间隔静音），设置页可开关与调音量。已知边界：浏览器可能要求先点击页面才允许发声（与第 2 条同源）。
13. **iambic 键位默认 `KeyZ` / `KeyX`**（2026-10-14 由左右 Ctrl 改为此值）：相邻便于 squeeze、不与浏览器快捷键冲突。Web 页面失焦时仍捕获不到键盘（需 Tauri，见第 8 条）。
14. ~~**关台会把整个波段清空**（`setPower(false)` 曾 `dispose()` + 重建会话）。~~ **已解决（2026-10-15）**：关台现在只是「不接收」——`QsoSession.setReceiving(false)` 不接话、不发声、不发射，但频段、台上的台与进行中的通联原样保留；虚拟 HAM 在应用启动时就在**所有波段**生成并持续活动（`App` 每波段持有一个会话），不再随电源开关起落。已知取舍：无论是否开机，4 个频段的后台节奏都一直在跑（各 1 s 一次 `advance()`、每波段 12–18 台，开销仍可忽略）；波段内的台不随 ±1 kHz 调谐更换（1 kHz 不等于换一批台，更贴近真实）。
15. ~~**偏频模型不模拟"通带之外听不到"**（有意简化，2026-10-15）。~~ **已更新（2026-10-16）**：CW 通带已实现——默认 500 Hz 宽、中心在拨轮，**超出 ±带宽/2 的台完全听不到**，不会被接入会话、不发声（见 Prototype v3.2），带宽可选 **500 / 250 / 100 Hz**（v3.3）。仍然保留的简化是**滤波器裙边**：真实滤波器越靠近边缘音量越降、过零点还会折回，这里在通带边缘一刀切、通带内保持单调映射并夹在 250–1800 Hz。
16. **边带固定后不再跟随波段**（v3.3，有意）：点一次模式标签就把边带固定下来（例如在 40m 上切到 `CW-U` 后，切到 15m 也仍是 `CW-U`）。理由：这是操作者的显式选择，跟着波段跑才是意外。想恢复"跟随波段"，在设置 → CW 接收 → CW 边带里选「自动」。

## 如何验收

```bash
npm run build      # 生产构建
npm test           # 415 例测试（含 jsdom 下的 UI 交互，无需浏览器；canvas 画面本身测不到）
npm run typecheck  # 类型检查
npm run dev        # 手动验收：发声 / 听感 / 视觉 / 手感（这些只能人过一遍）
```

建议的手动验收路径：齿轮里填呼号 → 电台面板点「开台」→ **先看几秒瀑布图**（应当看到几条亮斑，正在呼叫的台在冒点划；画面正中两条细线之间是 500 Hz 通带）→ **点「+1 kHz」连按几次**（信号应当斜着拖出一条曲线，而不是整幅平移）→ **在瀑布上点一下某个亮斑**（拨轮应当跳到它上面）→ 电台页「监听：等 HAM 发 CQ」→ 抄收并应答 → 走完 RST 与 73 SK → 日志页应出现一条记录。
顺便验一下新语义：**不点开台**，逐个波段切过去，每个波段都应当已经有虚拟 HAM 在名单里（关台只是不接收）；开台 → 关台 → 再开台，波段、名单与进行中的通联应当**原样还在**，而不是被清空重来。
**通带验收**（v3.2 新增，人耳才能判断）：开台时如果通带内没有台，瀑布上方标签会直接说明"通带内没有信号 · 窗口里有 N 个信号"——此时按「监听」应当看到拨轮**被自动扫到某个亮斑上**，随后听到它的 CQ；如果自己在两个亮斑中间停住，应当**什么都听不到**（这是对的）。与某台通联中用 **±100 Hz 微调**慢慢走开：通带内音调变高/变低（40m 往下、20m 往上），状态行显示"偏频 ±N Hz"；走出通带边缘后声音**直接消失**、状态行改为"对方已在通带之外"——调回来应当原样恢复。
**边带与带宽验收**（v3.3 新增）：① 点电台面板上的 `CW-U` / `CW-L` 标签，标签文本应当立刻翻转，**音调方向也随之翻转**（同一台、同一拨轮位置，L 与 U 下的音调一个变高一个变低）；切到别的波段后标签保持你选的那一侧。② 设置 → CW 接收 → 「CW 边带」选「自动」，标签应当重新跟随波段（20m → `CW-U`，40m → `CW-L`）。③ 把带宽依次调到 **250 / 100 Hz**：瀑布正中那层标记应当**明显变窄**，电台页的"接收通带 N Hz"与通联面板里的"±N Hz"数字同步变化；100 Hz 时只有用 ±1 kHz 精确压在某台上才听得到，稍微用 ±100 Hz 走开一格就静默。④ 无论如何切边带/带宽，**日志里那条记录的 MODE 都应当是 `CW`**。
**堆叠验收**（v3.4 新增，人耳才能判断）：开台 → 点「我发 CQ」→ 应当**陆续**听到 2–3 个不同的呼号各报两遍（不是齐射，也不会互相切断），状态行出现「N 台同时应答」、发送区出现对应的「点名 XXX」按钮。① **不点名**，直接发 `R BK`：没有人回你，各台在 3–7 秒后继续重呼——这是对的；② **点名**其中一台（点按钮再发送）：被点的那台回 `R UR RST 599 BK`，其余台消失，状态变为「交换信息中」，随后按正常流程走到 73 SK 并存日志；③ 一直不点名：约半分钟后各台依次停止呼叫，界面回到「开始通联」。真实听感（尤其三台的声音是否容易分辨）只能人耳判断。

**后台互连验收**（v3.6 新增，v3.7 改为「看不见」）：**这一项现在验的是"看不见"**。开台后在波段上到处走走（±1 kHz 连点十几下，或直接按「监听」）——你会**遇到**某一段上有两台的报文交替出现（先是 CQ，然后 `A DE B K`，再 `R UR RST 599 599 BK`……直到两声 `R TU 73 SK`），中间有半秒多的空档。此时界面应当**毫无提示**：活动列表不单列这一对、徽标不写「与 X 通联」、瀑布标签与右上角不显示、「我发 CQ」也不置灰。你若就在这个频率上发 CQ，**不会有人应答**（CQ 照常发出，随后安静下来），而那两台继续把 6 行说完——界面上不会有任何解释。等它们签完两声 `73 SK`，**过上几秒会听到其中一台重新 `CQ CQ CQ DE ...`**：这时候应答它，就等于"等他们通联完再上去"。这就是验收点：**能否察觉"别人在通联"，只取决于你有没有调过去听。**

**波段切片验收**（v3.7 新增）：① 电台页的调谐说明应当写着「台站散布在中心 ±25 kHz……瀑布一次只看得到 ±10 kHz」。② 沿波段连点「+ 1 kHz」十来下：亮斑会不断从窗口一侧进入、另一侧离开，**每次只看到其中一部分**——这就是"调谐遇到新台"。③ 「波段活动」列表只该出现**当前窗口里**的台；调一段以后旧名字消失、新名字出现。④ 打开任一时刻的 `session.listHams()` 应能看到 12–18 个台（列表里只会显示其中一部分）。

同一流程已有一条自动化用例覆盖（`src/ui/pages/logPage.test.ts` 的「完整跑通一次 QSO」），所以手动验收应把注意力集中在**自动化测不到的部分**：CW 音调是否真的响、音色是否舒服、浏览器首次是否拦自动播放。

## Git 状态

v1 内容已作为 PR #7（squash）合入 `master`。v2 / v2.1 / v3 / v3.1 / v3.2 / v3.3 / v3.4 / v3.5 / v3.6 / v3.7 的改动只在本地 `feat/ui-v2` 分支，**未推送**（按约定推送在你本机/远程桌面用 GitHub Desktop 完成）。
