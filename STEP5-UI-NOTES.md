# 第五步 UI：实现说明与遗留问题

分支：`feat/ui`（基于 `master` 的 `476b4f6`）。本文件是进度说明，不是设计文档，故放在仓库根而非 `doc/`。

---

## 技术选型

**原生 TypeScript + Vite，零新增依赖。** 原因有二：

1. 沙箱内 npm install 走不通（代理 502），不能引入 React/Vue 等框架；
2. 与项目既有约定一致——核心逻辑是纯 TS 模块，UI 只做 DOM 呈现层。

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
- `vite build`：**通过**（33 模块，JS 64.66 kB / CSS 5.03 kB）
- 测试：**新增 26 例，全套 97 例通过**（另有音频 12 例在沙箱组合跑中因缓存写入被拒而跳过，单独跑通过）

## 遗留问题与限制

1. **UI 没有自动化测试。** vitest 环境是 node，没有 DOM；装 jsdom 需要联网（沙箱 502）。纯逻辑（设置校验、日志推导、频段）已单测覆盖，**DOM 交互需你 `npm run dev` 手动验收**。
2. **浏览器自动播放限制**：首次发声可能被浏览器拦截，需先有一次用户点击。音频后端目前每次播放新建并关闭 AudioContext。
3. **iambic 键控未实现**，设置里的 A/B 模式是预留项，当前只有直键。
4. **HAM 之间互相通联仍是占位**（`planHamToHam`），未实现。
5. **HAM 不会自主定时发 CQ**：频率页是「点按钮触发」，真实的节奏调度循环按 ROADMAP 仍属延后项。
6. **信号强度条**由频率上 HAM 数量推导，不是真实传播模型。
7. **lookahead 流式播放调度**未实现（ROADMAP 已列为延后），当前是一次性灌 BufferSource。
8. **全局快捷键**做不到：Web 页面失焦无法捕获键盘，需迁 Tauri 才能解决（UI.md 已知限制）。
9. **直键解码的已知边界**：点单位由最短按键时长估计，若一段报文全是划会导致误判（解码器既有说明）。
10. **设置项在失焦时提交**（change 事件），避免边输入边重渲染打断输入。
11. **辅助模式的「显示」状态只存在内存**，刷新页面后重置。

## 如何验收

```bash
npm run dev      # 打开提示的地址
npm run build    # 生产构建
npm test         # 测试
```

建议验收路径：设置页填呼号 → 频率页「监听：等 HAM 发 CQ」→ CW 页抄收并应答 → 走完 RST 与 73 SK → 日志页应出现一条记录。

## Git 状态

改动只在本地 `feat/ui` 分支，**未推送**（按约定推送在你本机/远程桌面用 GitHub Desktop 完成）。
