# 【弹弹动画】文字抖动 — 完整方案（筹码数字常态逐字角摆动）

> **状态：** 定稿方案，供实现执行  
> **范围：** 左侧 HUD「筹码数字」(`hud.scorePanel.chipMultSection.chipsText`) 常态持续抖动  
> **命名：** 参数面板专区 **「【弹弹动画】文字抖动」**；配置键 `textJitter`  
> **前置架构：** `CharLayerComponent` + `CharEffect`（`BreathingText` / `BounceText`）

---

## 0. 需求复述（验收标准）

| # | 需求 | 验收 |
|---|------|------|
| R1 | **每个数字独立抖动**，不是整串一起转 | 拆字后每字 `rotation` 各自相位不同 |
| R2 | **抖动中心 = 数字几何中心** | 单字 `anchor.x = 0.5`（CharLayer 已保证），绕字心旋转 |
| R3 | **顺时针 ↔ 逆时针** 来回、快速、轻微 | `rotation = A·sin(ωt + φ_i)`，小角度、高频率 |
| R4 | **常态化**，非触发式 | 挂载即注册 CharEffect，永不 `unregister`（除非 `enabled=false`） |
| R5 | **位数分级** | 1 位不抖；2 位用「原始」幅度；位数每 +1，**整体幅度 ×1.2** |
| R6 | 参数进 **文字视效** 分组下新专区 **【弹弹动画】文字抖动** | HTML + bind + CONFIG + clone/merge |

**非目标（本方案不做）：**

- 不改 `BounceTextComponent` 的触发弹弹语义（加分时仍走 `chipsBounce`）
- 不默认给倍率 / 牌型 / 预期分挂抖动（组件可复用，但 ScorePanel 本阶段只挂筹码）
- 不引入 npm 动画库

---

## 1. 与现有代码的关系

### 1.1 筹码数字现状

```
ScorePanel
  chipsText: UIText ("hud.scorePanel.chipMultSection.chipsText")
    └── BounceTextComponent("chipsBounce")  // 触发式，trigger() 才注册 CharEffect
```

- 文案：`String(chips)`，纯数字，右对齐 `anchor(1, 0.5)`
- 弹弹：结算加筹码时 `chipsBounceComp.trigger()` → 逐字 scale 脉冲

### 1.2 可复用基础设施

| 模块 | 作用 | 本方案用法 |
|------|------|------------|
| `CharLayerComponent` | 拆字、隐藏原生 Text、每帧复位 + 累加效果 | **不改拆字几何**；继续写 `acc.rotation` |
| `CharEffect` | `contribute(i, count, now, acc)` | 新效果只写 `acc.rotation` |
| `BreathingTextComponent` | **常驻**效果范本（`onAttach` 即 `registerEffect`） | 生命周期照抄 |
| `BounceTextComponent` | **触发**效果；与常驻可同层叠加 | 抖动 + 弹弹可同时存在 |

### 1.3 旋转枢轴（已满足 R2）

`CharLayerComponent.buildChars`：

```ts
t.anchor.set(0.5, anchorY);  // 水平居中
// position 放在单字中心 cx
```

因此 `ch.rotation = θ` **天然绕单字水平中心**摆动。  
垂直锚点沿用宿主 `anchorY`（筹码为 0.5）→ 字心旋转。

### 1.4 与弹弹共存

- 弹弹写 `acc.scale`（×）与可选瞬时 `acc.rotation`（+）
- 抖动持续写 `acc.rotation`（+）
- CharLayer：`rotation` **累加** → 弹弹扫过时 = 弹弹角 + 常态抖角；结束后只剩抖角  
- **无需改 Bounce**；顺序：注册先后均可（推荐抖动先注册，弹弹后叠加更直观，非硬性）

---

## 2. 动力学模型（定稿）

### 2.1 单字角位移

\[
\theta_i(t) = A_{\text{eff}} \cdot \sin\bigl(2\pi f\, t_{\text{sec}} + \varphi_i\bigr)
\]

- \(t_{\text{sec}} = (now - t_0) / 1000 \times speedRatio\)（可选；默认 `speedRatio=1`）
- \(f\) = `frequencyHz`（Hz）
- \(\varphi_i\) = 第 \(i\) 字相位（见 §2.3）
- \(A_{\text{eff}}\) = 有效最大摆角（弧度）

写回：

```ts
acc.rotation += theta_i;  // 弧度
```

**禁止：** 整串 Container 旋转、Tween 驱动、每帧重建 Text。

### 2.2 位数分级幅度（R5）

令 \(n\) = 当前字符串长度（`[...text].length`，与 CharLayer 拆字一致；筹码无多码点问题）。

\[
s(n) =
\begin{cases}
0 & n \le 1 \\
1.2^{\,n-2} & n \ge 2
\end{cases}
\]

\[
A_{\text{eff}} = \mathrm{deg2rad}(\texttt{baseAngleDeg}) \cdot s(n)
\]

| 位数 n | s(n) | 含义 |
|--------|------|------|
| 0 / 1 | 0 | 不抖 |
| 2 | 1 | 「原始数值」= `baseAngleDeg` |
| 3 | 1.2 | ×1.2 |
| 4 | 1.44 | 再 ×1.2 |
| 5 | 1.728 | … |

`digitGrowth` 默认 **1.2**，面板可调；公式统一为：

```ts
function digitAmplitudeScale(n: number, growth: number, minDigits: number): number {
  if (n < minDigits) return 0;           // minDigits 默认 2
  if (n === minDigits) return 1;
  return Math.pow(growth, n - minDigits);
}
```

> 若 `minDigits=2`：与上表一致。`growth` 仅作用在「超过最小位数」的增量上。

**只放大角度，不默认放大频率**（位数多时字更「晃得开」但仍同速；若以后要「越大越疯」再加 `frequencyGrowth`，本版不做）。

### 2.3 相位：每字独立

目标：避免整串同步「像一块板在转」。

**定稿：**

```ts
phi_i = i * phaseStaggerRad + phaseSeed
```

- `phaseStaggerDeg`：相邻字相位差（度），默认 **≈ 50°～70°**（面板暴露）
- `phaseSeed`：组件挂载时 `Math.random() * 2π` 一次即可；**文本变化不重置**（避免改数时相位跳变）

可选（面板不默认开）：`randomizePhaseOnRebuild` — 文本变化时重抽 seed（一般不需要）。

### 2.4 1 位数

\(s=0\) → \(\theta=0\)。  
**仍保持 CharEffect 注册**（与 Breathing 一致），方便位数从 1→2 时无缝起抖；也可在 `count < minDigits` 时 contribute 直接 return 0。

---

## 3. 组件设计

### 3.1 新文件

`src/ui/hierarchy/components/TextJitterComponent.ts`

```ts
export class TextJitterComponent extends UIComponent implements CharEffect {
  readonly type = "textJitter";
  readonly displayName = "【弹弹动画】文字抖动";

  private configKey = "textJitter";  // 读 CONFIG[configKey]
  private charLayer: CharLayerComponent | null = null;
  private startTime = 0;
  private phaseSeed = 0;

  constructor(configKey = "textJitter") { ... }
}
```

### 3.2 生命周期（对齐 Breathing，非常驻 vs 触发对照）

| 事件 | 行为 |
|------|------|
| `onAttach` | `ensureCharLayer`；`startTime = now`；`phaseSeed = random`；若 `CONFIG.enabled` → `registerEffect` |
| `apply` | 根据 `enabled` register / unregister |
| `onDetach` | `unregisterEffect` |
| `isActive` | `return enabled` |
| `contribute` | 读 CONFIG；算 \(A_{\text{eff}}\)、\(\theta_i\)；`acc.rotation +=` |

**不实现 `trigger()`** — 与 Bounce 语义分离。

### 3.3 注册到 registry

`src/ui/hierarchy/index.ts`：

```ts
componentRegistry.register({
  type: "textJitter",
  displayName: "文字抖动",
  factory: () => new TextJitterComponent(),
  canAttach: textJitterCanAttach, // 同 bounce：仅 UIText
});
```

- `charLayer` 的 `canAttach` 可继续用 `bounceTextCanAttach`（同为 UIText）
- Hierarchy 存档：`type: "textJitter"` + `data: { configKey }` 即可；运行时参数走全局 CONFIG，不塞 inspector 大表（与 Bounce 一致）

### 3.4 ScorePanel 挂载

```ts
// 构造 chipsText 后
this.chipsJitterComp = new TextJitterComponent("textJitter");
this.chipsText.addComponent(this.chipsJitterComp);
// 已有
this.chipsBounceComp = new BounceTextComponent("chipsBounce");
this.chipsText.addComponent(this.chipsBounceComp);
```

顺序建议：**先 Jitter 后 Bounce**（先常驻后触发，调试时更符合「底噪 + 脉冲」）。

`setChips` / `setText` **无需**额外调用；CharLayer 文本变化会 `rebuildIfNeeded`，效果仍注册。

---

## 4. 阴影：角抖跟随 / 呼吸不跟随（通道分离）

### 4.1 问题

`ShadowComponent` 整宿主 `generateTexture`。若仅在「有 rotation」时重烤，但烤时字仍带呼吸 `offsetY`，则**抖动一开，阴影会跟着上下起伏**——违反「呼吸不影响阴影」。

### 4.2 定稿机制

| 通道 | 数字本体 | 阴影 |
|------|----------|------|
| offsetX/Y（呼吸） | 生效 | **永不**进烤片；仅位移时不触发重烤 |
| rotation（文字抖动） | 生效 | 每帧重烤，**烤前钉回基线 XY**，保留 rot |
| scale/rot（弹弹） | 生效 | 同抖动路径 |

实现（`CharLayerComponent`）：

1. 判定 `silhouetteChanged` 只看 scale/rotation（忽略 offset）。
2. 重烤前：`position → (baseX, baseY)`，保留 `scale`/`rotation`。
3. `notifyVisualChanged()` 同步烤影。
4. 恢复带 offset 的 position（本帧渲染数字仍起伏）。

`TextJitter` 不设 `ignoreSilhouetteForShadow`。  
`ignoreSilhouetteForShadow` 仍保留给未来省性能路径。

### 4.3 场景表

| 场景 | 阴影行为 |
|------|----------|
| 仅呼吸 | 不重烤，影钉基线 |
| 仅抖动 | 每帧烤（基线 XY + rot） |
| 呼吸 + 抖动 | 影跟角抖，**不**跟 Y 起伏 |
| 弹弹 | scale+rot 进烤片，同样钉基线 XY |

---

## 5. 配置 schema

### 5.1 接口（`config.ts`）

```ts
/**
 * 【弹弹动画】文字抖动 — 常态逐字角摆动（筹码数字等）。
 * 位数分级：n<minDigits → 0；n==minDigits → baseAngleDeg；
 * n>minDigits → baseAngleDeg * digitGrowth^(n-minDigits)。
 */
export interface TextJitterConfig {
  /** 总开关 */
  enabled: boolean;
  /**
   * 2 位（= minDigits）时的最大摆角（度，单侧峰值）。
   * 实际 θ ∈ [-A, +A]。
   */
  baseAngleDeg: number;
  /** 角频率（Hz），越大越「快」 */
  frequencyHz: number;
  /** 相邻字相位差（度），避免整串同步 */
  phaseStaggerDeg: number;
  /** 位数增长底数，默认 1.2 */
  digitGrowth: number;
  /**
   * 开始抖动的最小位数（默认 2）。
   * n < minDigits → 幅度 0。
   */
  minDigits: number;
  /** 时间倍率（叠在 wall-clock 上；一般 1） */
  speedRatio: number;
}
```

### 5.2 推荐默认值（可调）

| 字段 | 默认 | 理由 |
|------|------|------|
| `enabled` | `true` | 产品要常态抖 |
| `baseAngleDeg` | `4`～`6` | 「轻微」；过大像故障 |
| `frequencyHz` | `6`～`10` | 「快速」来回 |
| `phaseStaggerDeg` | `55` | 相邻不同步 |
| `digitGrowth` | `1.2` | 需求原文 |
| `minDigits` | `2` | 1 位不抖 |
| `speedRatio` | `1` | 预留 |

建议首发默认：

```ts
textJitter: Object.freeze({
  enabled: true,
  baseAngleDeg: 5,
  frequencyHz: 8,
  phaseStaggerDeg: 55,
  digitGrowth: 1.2,
  minDigits: 2,
  speedRatio: 1,
}),
```

### 5.3 展开状态

`cardVisuals.expandedSections.textJitter: boolean`（与 `chipsBounce` 同级）。

### 5.4 clone / merge / applyConfig

与 `chipsBounce` 同模式：

- `cloneConfig`：`textJitter: { ...src.textJitter }`
- `applyConfig` / `applyToActiveDefault`：浅合并 `incoming.textJitter`
- **不必**进 `scaleTimeMS` 的 ms 列表（本配置无 ms 时长字段；`frequencyHz` 用 wall-clock）

### 5.5 gameSpeed

- **不**强制跟 `gameSpeed`（常态 UI 装饰；全局加速时抖速不变更稳）
- 若以后要跟，用 `speedRatio * gameSpeed` 乘在 `t_sec` 上即可，本版默认不乘

---

## 6. 参数面板（文字视效）

### 6.1 位置

`index.html` → 分组 **「文字视效」**  
建议插在 **【弹弹动画】筹码数字** 专区**之前**（先常态、后触发），或紧挨其后。  
专区标题：

```text
【弹弹动画】文字抖动
```

展开：`inp-expandTextJitter` / `val-expandTextJitter` / `sect-textJitter-params`  
绑定：`cardVisuals.expandedSections.textJitter`

### 6.2 控件清单（必要参数）

| 标签 | DOM id 前缀 | CONFIG 路径 | 控件 | step / 范围建议 |
|------|-------------|-------------|------|-----------------|
| 启用 | `inp-textJitterEnabled` | `textJitter.enabled` | toggle | — |
| 基础摆角 (°) | `inp-textJitterBaseAngleDeg` | `textJitter.baseAngleDeg` | number | 0.5，0～30 |
| 抖动频率 (Hz) | `inp-textJitterFrequencyHz` | `textJitter.frequencyHz` | number | 0.5，0～30 |
| 字间相位差 (°) | `inp-textJitterPhaseStaggerDeg` | `textJitter.phaseStaggerDeg` | number | 1，0～180 |
| 位数增长系数 | `inp-textJitterDigitGrowth` | `textJitter.digitGrowth` | number | 0.05，1～2 |
| 起始位数 | `inp-textJitterMinDigits` | `textJitter.minDigits` | number integer | 1～8 |
| 时间倍率 | `inp-textJitterSpeedRatio` | `textJitter.speedRatio` | number | 0.1，0.1～5 |

可选说明行（只读文案，不绑 CONFIG）：

> 1 位不抖；2 位用基础摆角；每多 1 位角度 ×增长系数。每字绕自身中心顺/逆时针正弦摆动。

### 6.3 ControlPanel 绑定

```ts
// === 【弹弹动画】文字抖动 ===
bindSectionExpand("inp-expandTextJitter", "val-expandTextJitter",
  "cardVisuals.expandedSections.textJitter", "sect-textJitter-params");
bindToggle("inp-textJitterEnabled", "val-textJitterEnabled", "textJitter.enabled");
bindNumber("inp-textJitterBaseAngleDeg", ..., "textJitter.baseAngleDeg", { digits: 1 });
bindNumber("inp-textJitterFrequencyHz", ..., "textJitter.frequencyHz", { digits: 1 });
bindNumber("inp-textJitterPhaseStaggerDeg", ..., "textJitter.phaseStaggerDeg", { digits: 1 });
bindNumber("inp-textJitterDigitGrowth", ..., "textJitter.digitGrowth", { digits: 2 });
bindNumber("inp-textJitterMinDigits", ..., "textJitter.minDigits", { integer: true });
bindNumber("inp-textJitterSpeedRatio", ..., "textJitter.speedRatio", { digits: 2 });
```

改参 **即时生效**（`contribute` 每帧读 CONFIG），无需事件总线。

### 6.4 Hierarchy 组件 inspector

简版即可（对齐 Bounce）：

```text
绑定的配置专区：textJitter
（参数请在「文字视效 → 【弹弹动画】文字抖动」调整）
```

---

## 7. 实现步骤（建议 PR 顺序）

| 步骤 | 内容 | 文件 |
|------|------|------|
| 1 | `TextJitterConfig` + DEFAULT + clone/merge | `config.ts` |
| 2 | `TextJitterComponent` + CharEffect | 新组件文件 |
| 3 | registry 注册 | `hierarchy/index.ts` |
| 4 | CharLayer 阴影忽略策略（§4.2 A1） | `CharLayerComponent.ts` |
| 5 | ScorePanel 挂载抖动组件 | `ScorePanel.ts` |
| 6 | HTML 专区 + ControlPanel bind | `index.html`, `ControlPanel.ts` |
| 7 | 手测：1/2/3/4 位筹码、弹弹叠加、enabled 关 | — |

**不强制**改 `shipping.json`（无组件序列化依赖时，代码 `addComponent` 即可；若 hydrate 会剥未知组件，保持代码侧固定挂载最稳）。

---

## 8. 核心伪代码

```ts
// TextJitterComponent.contribute
contribute(i: number, count: number, now: number, acc: CharFrame): void {
  const cfg = CONFIG.textJitter;
  if (!cfg.enabled) return;

  const scale = digitAmplitudeScale(count, cfg.digitGrowth, cfg.minDigits);
  if (scale <= 0 || cfg.baseAngleDeg === 0 || cfg.frequencyHz <= 0) return;

  const A = (cfg.baseAngleDeg * Math.PI) / 180 * scale;
  const t =
    ((now - this.startTime) / 1000) *
    Math.max(0.01, cfg.speedRatio);
  const phi =
    this.phaseSeed +
    i * ((cfg.phaseStaggerDeg * Math.PI) / 180);
  const omega = 2 * Math.PI * cfg.frequencyHz;

  acc.rotation += A * Math.sin(omega * t + phi);
}
```

```ts
function digitAmplitudeScale(n: number, growth: number, minDigits: number): number {
  const min = Math.max(1, Math.floor(minDigits));
  if (n < min) return 0;
  if (n === min) return 1;
  const g = Math.max(1, growth); // 或允许 <1 做「位数越多越稳」？需求是翻倍，保持 g 原样
  return Math.pow(g, n - min);
}
```

---

## 9. 边界与测试清单

| 用例 | 期望 |
|------|------|
| chips = `0` / `5`（1 位） | 无旋转 |
| chips = `12`（2 位） | 两字轻微反相/错相摆动 |
| chips = `120`（3 位） | 幅度 ≈ 2 位 × 1.2 |
| chips = `1200` | 幅度 ≈ 2 位 × 1.44 |
| 结算 trigger 弹弹 | 放大脉冲正常；结束后继续抖 |
| `enabled=false` | 立刻静止；可回退原生 Text（若无其它 effect） |
| 仅抖动 + 有 Shadow | 不卡顿；影不疯狂闪 |
| 调 `baseAngleDeg` / `frequencyHz` | 下一帧生效 |
| 右对齐多位数 | 字距与基线布局不变，只加 rot |

---

## 10. 扩展（本版不做，预留）

- 倍率数字同挂 `new TextJitterComponent("textJitter")` 或独立 `multTextJitter` 配置
- `frequencyGrowth` 随位数加快
- 轻微 `offsetX` 抖动（需评估阴影策略；位移类可不重烤）
- 与 `gameSpeed` 联动开关

---

## 11. 文件变更一览

| 文件 | 变更 |
|------|------|
| `src/game/config.ts` | `TextJitterConfig`、`textJitter` 默认、expandedSections、clone/merge |
| `src/ui/hierarchy/components/TextJitterComponent.ts` | **新建** |
| `src/ui/hierarchy/components/CharLayerComponent.ts` | 阴影 ignore 策略 |
| `src/ui/hierarchy/index.ts` | register `textJitter` |
| `src/ui/components/ScorePanel.ts` | chipsText 挂组件 |
| `index.html` | 文字视效专区 DOM |
| `src/debug/ControlPanel.ts` | bind 专区 |
| `docs/text-jitter-digit-wobble-plan.md` | 本文 |

---

## 12. 决策摘要（给实现者）

1. **新 CharEffect 常驻组件**，不要塞进 `BounceTextComponent.trigger`。  
2. **只写 `acc.rotation`**，枢轴靠现有 `anchor 0.5`。  
3. **幅度** \(A = \mathrm{base} \times 1.2^{n-2}\)（\(n\ge2\)），1 位为 0。  
4. **正弦角摆动** + 字间相位差。  
5. **阴影跟随微抖**（与弹弹同路径：每帧 `notifyVisualChanged` → Shadow 同步烤）。  
6. **CONFIG `textJitter` + 面板「【弹弹动画】文字抖动」**。  
7. **仅筹码数字** 首发挂载。
