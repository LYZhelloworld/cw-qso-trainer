# cw-qso-trainer

离线 CW（摩尔斯电码）通联练习器：抄收虚拟电台、用直键或 iambic 双桨发报、走完标准 QSO 流程并记录练习日志。

设计文档见 [doc/](./doc/README.md)（按能力域拆分，`doc/README.md` 是目录索引）。

---

## 目标

为业余无线电爱好者提供一个**离线、可交互的 CW 练习环境**，模拟真实业余无线电通联过程，帮助用户练习：

- 抄收 CW 报文
- 使用直键或 iambic 键发送 CW
- 完成标准 QSO 流程
- 记录练习通联日志

## 核心功能

- 模拟业余无线电四个 CW 频段：7 / 14 / 21 / 28 MHz
- 虚拟 HAM 随机开台、持续发 CQ、应答用户；波段上还有别人在互相通联
- 用户通过键盘模拟直键或 iambic 发送 CW
- 随时可发报，无需"开始通联"；发报时接收中断（半双工），频谱上只剩自己的信号
- 只靠耳朵：不显示对方是谁，也不回放收发记录；调准频率就听到正在发的报文
- 八个功能键（F1–F8）发常用报文，报文写在可编辑的模式配置文件里（`DX.msg` / `CQWW.msg` / `WPX.msg`），支持 `{MYCALL}` / `{THEIRCALL}` / `{RST}` / `{EXCH}` 等宏；报告按 CW 习惯发短码（`599` → `5NN`、`579` → `5BN`），日志里记原始数字
- 三种通联模式，机头上一键切换：**DX**（日常通联）、**CQWW**（交换 CQ 分区）、**WPX**（交换自增序号）。比赛里报告恒为 `5NN`、收尾只有 `TU`
- 日志由自己在录入行手记（对方呼号 + 两个 RST，比赛再加对方的分区 / 序号），回车即发结束语并落账；三本账各自独立，带一行**核对**——只说错在哪一项（呼号 / 交换信息 / RST），不给正确答案

## 开发与运行

需要 Node.js 22+。

```powershell
npm install
npm run dev        # 浏览器里跑：http://localhost:5173
```

### Windows 桌面版

需要 Rust 工具链（stable，MSVC）与 VS 2022 生成工具；系统要有 WebView2 运行时（Windows 11 自带，安装包会附带引导安装）。

```powershell
npm run desktop        # 开发模式（Tauri 窗口 + Vite 热更新）
npm run desktop:build  # 打出免安装 exe：src-tauri/target/release/cw-qso-trainer.exe
```

首次运行会在 exe 旁生成 `app-data/`（WebView2 数据、设置、日志）和 `app-data/messages/` 下的三份报文（`DX.msg` / `CQWW.msg` / `WPX.msg`，可以直接改）——把 exe 和这个文件夹一起拷走，数据、练习记录和自定义报文就都在。exe 要放在**可写目录**（不要放 `Program Files`）；未签名，首次运行可能弹 SmartScreen 提示。

## 呼号数据

虚拟电台的呼号前缀与地理位置来自业余无线电通用的国家文件 [`data/cty.dat`](./data/cty.dat)——由 Jim Reisert AD1C 维护、[country-files.com](https://www.country-files.com/cty/) 发布，每周更新。文件随仓库入库，构建时直接内联，**构建与运行都不联网**。

刷新它是一次显式动作：

```powershell
npm run update:cty
```

脚本先下载到临时文件，校验结构（八段冒号字段、坐标可解析）与记录数（≥300 条）通过后才原子替换；校验失败或网络不可用时保留原文件。也可以从 [bigcty 页](https://www.country-files.com/bigcty/) 手动下载覆盖 `data/cty.dat`。

文件里的国家 / 地区名称在解析时即被丢弃，只留下经纬度、大洲与前缀——这是「不显示对方是谁」的一部分。

## 免责声明

> 本软件仅供练习使用。其中生成的呼号为虚拟呼号，可能与现实存在的呼号重复，不代表真实的无线电环境，也不能作为真实的通联记录。

免责声明在首次启动弹窗、关于页、日志页水印与页脚四处常驻。

## 术语表

| 术语 | 含义 |
|---|---|
| CW | 连续波，即摩尔斯电码通信 |
| QSO | 无线电通联 |
| CQ | 呼叫任意电台 |
| DE | 来自 |
| RST | 信号报告：可读性、强度、音调 |
| SK | 结束通联 |
| BK | 插入，建议省略呼号 |
| K | 请回答 |
| PSE K | 请回答 |
| AGN? | 请重发 |
| QRZ? | 谁在呼叫我？（呼号抄错专用） |
| R | 收到确认，表示已抄收对方上一条报文（见 [QSO 协议](./doc/QSO-PROTOCOL.md) 的「R（收到确认）」） |
| QSB | 信号衰落 |
| QRM | 人为干扰 |
| QRN | 大气噪声 |
| CQ 分区 | CQ 杂志划分的 40 个通联区，CQWW 比赛里作为交换信息（见 [比赛模式](./doc/CONTEST.md)） |
| 序号 | WPX 比赛里每通联一次加一的流水号，从 `001` 起 |
| 短码 | cut numbers：数字在 CW 里用更短的字母代替（`0` → `T`、`9` → `N`），见 [快速报文与日志录入](./doc/MESSAGES.md) |
| TEST | 比赛呼叫，`CQ TEST` 即"我在参加比赛" |
| WPM | 每分钟单词数 |
| iambic | 双桨键 |
| Farnsworth | 字符速度不变，间隔拉长 |
