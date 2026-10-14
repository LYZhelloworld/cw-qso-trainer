# 第五步 UI：实现说明与遗留问题

分支：`feat/keyer-sidetone`（基于 `master` 的 `476b4f6`，在上游 UI 落地之后继续叠加 iambic / 侧音 / HAM 自主 CQ / 三项健壮性修复）。本文件是进度说明，不是设计文档，故放在仓库根而非 `doc/`。

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

| 页面 | 内容 |
|---|---|
| 频率 | 四个频段切换、±1 kHz 调谐、当前频率显示、信号强度条、虚拟 HAM 活跃列表、两种发起通联的方式 |
| CW 翻译 | 辅助模式开关、收发记录（对方内容可遮蔽/单条显示）、文本发送、常用短语宏、直键电键输入、状态与 RST 显示 |
| 日志 | 表格（DATE/TIME_UTC/CALL/FREQ_MHZ/MODE/RST_RX/RST_TX）、逐行编辑保存、清空全部、常驻水印 |
| 设置 | 呼号（带校验）、音调、WPM、Farnsworth 开关与速度、难度、辅助模式、电键键位绑定、iambic A/B（预留） |
| 关于 | 免责声明、版本、项目范围 |

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
src/ui/pages/{frequency,cw,logPage,settingsPage,about}.ts
```

## 验证结果

- `tsc --noEmit`：**0 错误**
- `vite build`：**通过**（39 模块，JS 84.39 kB / CSS 5.29 kB；测试依赖 jsdom / fake-indexeddb 不进生产包）
- 测试：**全套 271 例通过**（28 个文件）
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
4. **HAM 之间互相通联仍是占位**（`planHamToHam`），未实现。**2026-10-14 明确暂缓，不排期。**
5. ~~**HAM 不会自主定时发 CQ**：频率页是「点按钮触发」。~~ **已实现（2026-10-14）**：核心 `src/ham/activity.ts` —— CQ 间隔 30–60 s 随机、无人应答时反复重呼、连续 3 分钟无应答下线、频段维持 1–3 个活跃；时钟与随机源全部注入、模块内无定时器，故 3 分钟的下线判定可在毫秒内测完。会话层 `QsoSession` 以 1 s 驱动循环推进它，应答延迟 1–5 s、回复延迟 1–3 s（取代原先硬编码的 1200 ms）。频率页显示各台状态（守听 / 呼叫 CQ 中 / 通联中）。**交互约束**：用户已在交换中时，频段上其他台的呼叫不会被接入，以免打断进行中的通联。
6. **信号强度条**由频率上 HAM 数量推导，不是真实传播模型。
7. ~~**lookahead 流式播放调度**未实现（ROADMAP 已列为延后），当前是一次性灌 BufferSource。~~ **已实现（2026-10-14）**：新增 `src/audio/player.ts` 的 `LookaheadPlayer`——整段渲染一次（保持 QRN/QSB 连续）后按音频时钟分块前瞻调度，返回 `PlaybackHandle{done, stop}`，`stop()` 可随时在元素边界打断；`CwAudioEngine` 改用共享 context + 该调度器。HAM 连续发 CQ 时，用户可**半途插话应答**，会话层 `hamCallsCq` 不再占用 `sending`（HAM CQ 改为非阻塞、后台播放），`userSend` / `userCallsCq` 起始调用 `engine.stop()` 切断环境 HAM 音频；`reset` / `dispose` 亦停音频。
8. **全局快捷键**做不到：Web 页面失焦无法捕获键盘，需迁 Tauri 才能解决（UI.md 已知限制）。
9. **直键解码的已知边界**：点单位由最短按键时长估计，若一段报文全是划会导致误判（解码器既有说明）。
10. **设置项在失焦时提交**（change 事件），避免边输入边重渲染打断输入。
11. **辅助模式的「显示」状态只存在内存**，刷新页面后重置。
12. ~~**电键发报没有侧音**。~~ **已解决（2026-10-14）**：新增 `src/audio/sidetone.ts`，直键按下即响、松开即停，iambic 跟随元素阶段（自动间隔静音），设置页可开关与调音量。已知边界：浏览器可能要求先点击页面才允许发声（与第 2 条同源）。
13. **iambic 键位默认 `KeyZ` / `KeyX`**（2026-10-14 由左右 Ctrl 改为此值）：相邻便于 squeeze、不与浏览器快捷键冲突。Web 页面失焦时仍捕获不到键盘（需 Tauri，见第 8 条）。

## 如何验收

```bash
npm run build      # 生产构建
npm test           # 260 例测试（含 jsdom 下的 UI 交互，无需浏览器）
npm run typecheck  # 类型检查
npm run dev        # 手动验收：发声 / 听感 / 视觉 / 手感（这些只能人过一遍）
```

建议的手动验收路径：设置页填呼号 → 频率页「监听：等 HAM 发 CQ」→ CW 页抄收并应答 → 走完 RST 与 73 SK → 日志页应出现一条记录。
同一流程已有一条自动化用例覆盖（`src/ui/pages/logPage.test.ts` 的「完整跑通一次 QSO」），所以手动验收应把注意力集中在**自动化测不到的部分**：CW 音调是否真的响、音色是否舒服、浏览器首次是否拦自动播放。

## Git 状态

改动只在本地 `feat/keyer-sidetone` 分支，**未推送**（按约定推送在你本机/远程桌面用 GitHub Desktop 完成）。
