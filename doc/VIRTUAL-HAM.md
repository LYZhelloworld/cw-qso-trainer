# 虚拟 HAM 策略（生成、前缀与地理位置）

> 本文件集中描述虚拟 HAM 的**生成策略**、**呼号前缀与地理位置的关系**，以及虚拟 HAM 在频段上的**运行时行为**。
> 相关：QSO 状态机在各阶段调用这些行为，见 [QSO 协议](./QSO-PROTOCOL.md)；报文解析见 [CW 解析与编码](./CW-PARSING.md)；接收不全的音频触发见 [音频与电磁环境](./AUDIO-ENVIRONMENT.md)。

---

## 呼号前缀表与地理位置

### 呼号前缀表

自行维护一份 JSON 表（静态资源，随应用打包）：

```json
{
  "B":   { "country": "China", "cqZone": 24, "ituZone": 44, "continent": "AS", "lat": 35.0, "lon": 105.0 },
  "BG7": { "country": "China", "cqZone": 24, "ituZone": 44, "continent": "AS", "lat": 23.1, "lon": 113.3, "region": 7 },
  "VR2": { "country": "Hong Kong", "cqZone": 24, "ituZone": 44, "continent": "AS", "lat": 22.3, "lon": 114.2 },
  "JA":  { "country": "Japan", "cqZone": 25, "ituZone": 45, "continent": "AS", "lat": 36.2, "lon": 138.2 },
  "W":   { "country": "USA", "cqZone": 5,  "ituZone": 8,  "continent": "NA", "lat": 39.8, "lon": -98.6 },
  "DL":  { "country": "Germany", "cqZone": 14, "ituZone": 28, "continent": "EU", "lat": 51.2, "lon": 10.4 }
}
```

字段说明：

| 字段 | 含义 |
|---|---|
| `country` | DXCC 国家 / 地区 |
| `cqZone` | CQ Zone |
| `ituZone` | ITU Zone |
| `continent` | 大洲代码 |
| `lat` / `lon` | 参考经纬度 |
| `region` | 呼号数字区（可选） |

> 注：世界上合法的呼号前缀（国家 / 地区标识）是**有限集合**，应枚举为完整列表，而非依赖宽松正则。呼号校验时，前缀必须命中此表，再结合 ITU 格式判定整体合法性：基本为「1–2 字母前缀 + 数字 + 1–4 字母后缀」，但中国允许 `B` + 数字的无后缀异地 / 便携形式（如 `B5`），且可带 `/P`、`/M`、`/5` 等操作后缀（见 [QSO 协议](./QSO-PROTOCOL.md) 的「用户呼号」一节）。完整前缀表已落地于 [`../data/dxcc.json`](../data/dxcc.json)，校验时只需判定「字母前缀是否命中该表」，**不记录其国家 / 地区归属**。

> 完整数据集已落地：[`../data/dxcc.json`](../data/dxcc.json)。生成脚本（从 RSGB 前缀列表 + ITU 网格生成）**不纳入仓库**，仅暂存在本地 [`../.workbuddy/staging/build-dxcc.py`](../.workbuddy/staging/build-dxcc.py)（含 `./sources/` 源文件），需要重跑时可用。该文件以 **DXCC 标记**为主键，每个实体仅含 `dxcc` / `lat` / `lon` / `prefixes` 四个字段——**刻意不存国家 / 地区名称与 ISO 代码**，以规避争议；坐标由国家质心近似推导、非实体精确位置。运行时所需的「前缀 → 坐标」查表应由该文件派生（展开 `prefixes` 数组后建立前缀到实体的映射）。

### 位置推断

- 根据呼号前缀推断
- 无法推断时，视为地理位置不可用
- 无法推断时，虚拟 HAM 生成概率均等

---

## 虚拟 HAM 生成策略

### 生成优先级

用户决定：**同呼号数字区 > 同国家 > 同大洲 > 其他**

权重示例：

```text
同呼号数字区：100
邻近数字区：40
同国家：30
同大洲：10
距离 < 3000 km：5
距离 < 8000 km：2
其他：1
```

### 生成算法

```text
function generatePeerCall(myCall, myLoc, prefixTable):
  candidates = []
  for each prefix in prefixTable:
    loc = prefixTable[prefix]
    weight = baseWeight(myLoc, loc)
    candidates.push({ prefix, weight })

  totalWeight = sum(candidates.weight)
  r = random(0, totalWeight)
  pick prefix by cumulative weight
  generate random suffix matching prefix pattern
  return full call
```

> `baseWeight` 按上方优先级与权重计算，并叠加距离权重（`< 3000 km` / `< 8000 km`）。

### 呼号后缀生成

- 前缀确定后，按该前缀规则生成后缀
- 例如 `BG7` 生成 `BG7XXX`，`JA` 生成 `JA1ABC`
- 后缀长度、字母数字混合模式按前缀表配置

> 待补：当前前缀表 JSON 尚未包含后缀模式字段（如 `BG7` → `3 字母`）。需在数据模型中补充 `suffixPattern` 等规则，供 `generatePeerCall` 读取。

---

## 虚拟 HAM 运行时行为

### 生成优先级（频段分布）

```text
同呼号数字区 > 同国家 > 同大洲 > 其他
```

### CQ 行为

- 每隔 **30 – 60 秒**随机发一次 CQ
- 连续 **3 分钟**无应答，下线
- 同一频段同时活跃 **1 – 3 个**

### 应答延迟

- 用户发 CQ 后，虚拟 HAM 随机延迟 **1 – 5 秒**再应答
- 用户应答虚拟 HAM 的 CQ 后，对方随机延迟 **1 – 3 秒**再回复

### 接收不全

- 默认概率 **1% – 5%**，可调
- 触发时虚拟 HAM 发 `AGN?` 或 `QRZ?`
- 要求用户全文重发
- 不模拟具体丢失内容

### 行为约束

- 虚拟 HAM 不会在后续阶段发 `PSE K`
- 虚拟 HAM 不会主动违反通联协议
- 用户发 `PSE K` 在后续阶段，虚拟 HAM 正常回应，不视为错误

### 多人应答

- 第一版只允许一个虚拟 HAM 应答
- 后续版本加入多人同时应答和冲突处理
