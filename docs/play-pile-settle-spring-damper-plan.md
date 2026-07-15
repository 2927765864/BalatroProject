# 出牌堆结算效果 — 弹簧阻尼变化（AI 可执行完整方案 · 定稿）

> **状态：** 定稿，供实现执行（禁止自我发挥）  
> **时间节点：** 2026-07-15  
> **选型代号：** 组合 R1（数值 MSMD + 半隐式欧拉 + 双通道独立弹簧 + ωn/ζ 标定）  
> **命名：** 弹簧阻尼变化结算效果  
> **前置：** 本仓库 `docs/elastic-rope-rotation-damping-plan.md`（角弹簧 ζ/ωn 定稿）；`docs/elastic-rope-traction-card-model.md`（积分/settle 习惯）

---

## 0. 执行约束（给 AI，必须逐条遵守）

1. **只实现本文写明的选型与公式**，禁止改用：
   - 关键帧表 `s1–s5 / t1–t5 / r1–r4`（删除，不得保留兼容双路径）
   - 外部 npm 动画库运行时依赖（react-spring / framer-motion / wobble / motion / gsap 等）
   - 把结算 scale/rot 写进 `ElasticRopeMotion` 平移/旋转积分器
   - 用 CSS `linear()` / cubic-bezier 弹簧生成器驱动游戏内卡牌
   - Verlet / RK4 / 完整刚体 / 四元数
   - 把 `elasticRopeCard.airDrag.linearCoeff` 直接当缩放/角阻尼系数
2. **允许对照、禁止复制依赖的开源：** 下列仓库/文章仅作公式与参数心智对照；实现必须自写 TypeScript，可抄公式与函数结构，**不得** `npm install` 这些包。
3. **每个实现步骤**必须同时满足：理论依据 → 具体实现 → 参考依据；禁止未引用的「经验改法」。
4. **通道隔离：** 只写 `CardView.scoringScaleMul` 与 `CardView.scoringRotOffset`；禁止写 `card.x/y`、禁止 `setMoveTarget` 驱动结算弹跳。
5. **出牌堆与小丑同构：** `playPileSettleEffect` 与 `jokerSettleEffect` 共用同一 `animateCardSettle` 实现与同一 schema（默认值可不同）。
6. **倍速：** `scaleTimeMS` 定义为 `effectiveMS = baseMS / gameSpeed`（见 `src/game/config.ts`）。弹簧积分使用 **有效 dt**（见 §7），禁止恢复旧「仅 t4/t5 缩放」特例。

---

## 1. 定稿技术选型一览（禁止替换）

| 模块 | 定稿方案 | 禁止方案 |
|------|----------|----------|
| 动力学 | 标准二阶质量–弹簧–阻尼（MSMD），状态 `(x, v)` | 关键帧 Tween；一阶指数平滑作默认 |
| 标定 | 对外 `mass, angularFreq(ωn), dampingRatio(ζ)`；对内 \(k=m\omega_n^2,\; c=2\zeta m\omega_n\) | 只暴露 raw k,c 无 ζ；tension/friction 命名作唯一 API |
| 积分 | 半隐式欧拉 + `maxDtSec` + `substeps`（与绳同结构） | 显式欧拉；无 cap 的单步大 dt |
| 通道 | scale 与 rot **各一个** 1D 弹簧，默认 **共享** ωn/ζ/mass | 单相位映射双输出；rot∝v_scale 假耦合 |
| 激励 | 位置阶跃 + 可选速度冲量（默认速度冲量=0） | 多脉冲模拟旧 5 段 |
| 结束 | 位置阈值 ∧ 速度阈值 + `maxDurationMS` 硬帽 | 仅固定 duration；ζ=0 无兜底 |
| 数字触发 | 固定 `textTriggerMS`（首次） | 默认用多次过峰逻辑 |
| 代码落点 | 新建 `src/motion/SpringDamper1D.ts`；改写 `PlayPileFx.animateCardSettle` | 塞进 `ElasticRopeMotion`；npm spring |
| 时钟 | 使用与 `TweenManager` 相同的 **App 帧 dt**（`GameController` → `tween.update(dtMS)` 同源），通过 **Tween 驱动伪目标或独立帧回调** 见 §8 | 独立 `requestAnimationFrame` 与暂停脱节 |
| 配置迁移 | 硬切：删除 s/t/r 字段；旧 JSON 缺字段由 DEFAULT 补齐 | 双读旧关键帧路径长期共存 |

---

## 2. 符号与公式（实现必须逐字遵守）

### 2.1 符号

| 符号 | 含义 | 单位 |
|------|------|------|
| \(x\) | 通道状态（scale 为无量纲倍率；rot 为弧度） | scale: 1；rot: rad |
| \(v\) | 通道速度 | scale: 1/s；rot: rad/s |
| \(x^*\) | 目标：scale 恒为 `1`；rot 恒为 `0` | 同 x |
| \(m\) | `mass` | 无量纲质量，>0 |
| \(\omega_n\) | `angularFreq` | rad/s |
| \(\zeta\) | `dampingRatio` | 无量纲 |
| \(k\) | 刚度 | \(k = m \omega_n^2\) |
| \(c\) | 阻尼系数 | \(c = 2\zeta m \omega_n\) |
| \(h\) | 子步长 | s，`h = dtSec / substeps` |

### 2.2 运动方程

\[
m\ddot{x} = -k(x - x^*) - c\dot{x}
\quad\Leftrightarrow\quad
\ddot{x} + 2\zeta\omega_n\dot{x} + \omega_n^2(x - x^*) = 0
\]

**理论依据：** 标准二阶系统 / 有阻尼谐振子；\(\zeta<1\) 欠阻尼（过冲）、\(\zeta=1\) 临界、\(\zeta>1\) 过阻尼。

**参考依据：**

- 本仓库定稿：`docs/elastic-rope-rotation-damping-plan.md` §2.4（同一 \(k=I\omega_n^2,\;c=2\zeta I\omega_n\) 形式，此处用 mass 替代 inertia）
- [Wikipedia: Harmonic oscillator — Damped](https://en.wikipedia.org/wiki/Harmonic_oscillator)（\(\omega_0,\zeta\) 标准形）
- [Ryan Juckett — Damped Springs](https://www.ryanjuckett.com/damped-springs/)（ζ/ωn 参数化、帧率无关动机）
- [Daniel Holden — Spring-It-On](https://theorangeduck.com/page/spring-roll-call) + [orangeduck/Spring-It-On](https://github.com/orangeduck/Spring-It-On)（spring damper 工程分类；**对照「坏阻尼」段落，禁止采用文中标记为 bad 的写法作为默认**）
- [Toqoz — Spring-based Animation](https://toqoz.fyi/springs.html) + [SpringTransform.cs](https://github.com/Toqozz/blog-code/blob/master/spring_transforms/Assets/SpringTransform.cs)（transform 各分量独立弹簧）
- [skevy/wobble](https://github.com/skevy/wobble)（`stiffness/damping/mass` 心智；**禁止 npm 依赖**）
- [charmbracelet/harmonica](https://github.com/charmbracelet/harmonica)（Juckett Go 端口；对照 API 边界，本方案用数值积分非解析系数）

### 2.3 半隐式欧拉（每个子步）

对单通道，目标 \(x^*\)：

```
// 理论：半隐式（symplectic）欧拉：先更新 v 再更新 x
// 参考：Gaffer on Games — Integration Basics
//   https://gafferongames.com/post/integration_basics/
// 本仓平移：ElasticRopeMotion.ts 子步内 vx+=ax*h; x+=vx*h
// 本仓角：  ElasticRopeMotion.ts springDamper 子步 torque/I

k = m * wn * wn
c = 2 * zeta * m * wn
a = (-k * (x - xTarget) - c * v) / m
v = v + a * h
x = x + v * h
```

**禁止：** `x = x + v*h` 再用旧 v 算 a 的显式欧拉作为默认（Orange Duck「spring_damper_bad」类问题）。

### 2.4 刚度/阻尼由 ωn、ζ 生成

```
m = max(1e-6, mass)
wn = clamp(angularFreq, 1e-6, 60)   // 与绳 angularFreq 上限 60 对齐
zeta = max(0, dampingRatio)        // 允许 >1；禁止负
// 若 zeta === 0：仍积分，但必须依赖 maxDurationMS 结束（见坑 P1）
k = m * wn * wn
c = 2 * zeta * m * wn
```

**参考依据：** 绳文档 §2.4；WinUI Spring `DampingRatio` 语义表（0=永不休止，&lt;1 过冲，=1 临界，&gt;1 过阻尼）— [Microsoft Learn: Spring animations](https://learn.microsoft.com/en-us/windows/apps/develop/composition/spring-animations)。

### 2.5 双通道

| 通道 | 状态变量 | 目标 \(x^*\) | 写入字段 |
|------|----------|--------------|----------|
| scale | `xS, vS` | `1` | `card.scoringScaleMul = xS` |
| rot | `xR, vR` | `0` | `card.scoringRotOffset = xR`（弧度） |

两通道 **独立积分**；**共享** 同一组 `mass, angularFreq, dampingRatio, maxDtSec, substeps`（定稿不拆分 scale/rot 的 ωn，除非未来文档修订）。

**参考依据：** Toqoz SpringTransform「每个分量一根弹簧」；本仓 `scoringScaleMul`/`scoringRotOffset` 合成点在 `CardView` 最终 scale/rotation。

### 2.6 激励（动画开始时设一次初值）

```
// scale
xS = 1 + impulseScale          // impulseScale 无量纲，可负（先缩小）可正（先放大）
vS = impulseScaleVel           // 默认 0；单位 1/s

// rot（配置为度，运行时转弧度）
xR = impulseRotDeg * Math.PI / 180
vR = impulseRotVelDeg * Math.PI / 180   // 默认 0；单位 deg/s → rad/s
```

**理论依据：** 二阶系统由初值 \((x_0,v_0)\) 与目标决定响应；位置阶跃 = 非零势能；速度冲量 = 动能一击（与 Juckett/wobble「initial velocity」一致）。

**参考依据：** [Maxime Heckel — Physics behind spring animations](https://blog.maximeheckel.com/posts/the-physics-behind-spring-animations/)（damping 耗散使动画可停）；Medium「spring takes initial velocity」。

### 2.7 结束条件

```
scaleSettled =
  abs(xS - 1) < settleEpsScale && abs(vS) < settleVelScale
rotSettled =
  abs(xR - 0) < settleEpsRot && abs(vR) < settleVelRot
bothSettled = scaleSettled && rotSettled

// 硬帽（秒，逻辑时间，已含 gameSpeed 缩放后的 maxDurationMS）
timedOut = elapsedSec >= maxDurationSec

if (bothSettled || timedOut) {
  xS = 1; vS = 0; xR = 0; vR = 0
  card.scoringScaleMul = 1
  card.scoringRotOffset = 0
  resolve()
}
```

**理论依据：** 与绳 `settle.distancePx ∧ speedPxPerSec` 同构；硬帽防止 ζ→0 永不收敛（Android SpringAnimation 文档：damping=0 永不 rest）。

**参考依据：**

- 本仓 `ElasticRopeMotion` settle 块
- [React Native Reanimated #132](https://github.com/software-mansion/react-native-reanimated/issues/132)：`restSpeedThreshold` + `restDisplacementThreshold`
- [Android SpringAnimation](https://developer.android.com/develop/ui/views/animations/spring-animation)：`canSkipToEnd` / 无阻尼永不结束
- 社区：无阈值时弹簧「永远差一点」——必须 ε 或 precision（Kaliber / Framer 系文章中的 precision 停机）

---

## 3. 配置 Schema（必须按此字段）

### 3.1 删除字段（禁止保留在类型与 DEFAULT）

`s1,s2,s3,s4,s5, t1,t2,t3,t4,t5, r1,r2,r3,r4`  
及相关 HTML id：`inp-playPileSettleEffectS*` / `T*` / `R*`、`inp-jokerSettleEffectS*` / `T*` / `R*`。

### 3.2 新类型（`playPileSettleEffect` 与 `jokerSettleEffect` 同构）

```ts
playPileSettleEffect: {
  enabled: boolean;
  /** 保留：第一张结束后停留；受 scaleTimeMS */
  firstIntervalMS: number;
  /** 保留：每张递减；受 scaleTimeMS */
  intervalReductionMS: number;
  /** 保留：最后一张后停留；受 scaleTimeMS */
  lastIntervalMS: number;

  /** 质量 m；默认 1 */
  mass: number;
  /** 自然频率 ωn (rad/s)；默认见 DEFAULT */
  angularFreq: number;
  /** 阻尼比 ζ；默认见 DEFAULT（欠阻尼） */
  dampingRatio: number;

  /** 初始 scale 偏离：xS0 = 1 + impulseScale */
  impulseScale: number;
  /** 初始 scale 速度 (1/s)；默认 0 */
  impulseScaleVel: number;
  /** 初始旋转偏离 (度) */
  impulseRotDeg: number;
  /** 初始角速度 (deg/s)；默认 0 */
  impulseRotVelDeg: number;

  /** 结束：|scale-1| */
  settleEpsScale: number;
  /** 结束：|vS| */
  settleVelScale: number;
  /** 结束：|rot| rad 阈值用「度」配置，运行时 *π/180 */
  settleEpsRotDeg: number;
  /** 结束：|vR| 用 deg/s 配置 */
  settleVelRotDeg: number;
  /** 最长逻辑时长 ms；受 scaleTimeMS；超时硬贴目标 */
  maxDurationMS: number;

  /** 积分：单帧最大步长秒；对齐绳习惯 */
  maxDtSec: number;
  /** 积分：子步数 */
  substeps: number;

  /** 结算数字：动画开始后延迟 ms 调 onStage2；受 scaleTimeMS */
  textTriggerMS: number;
};
```

`jokerSettleEffect`：**相同字段**（无额外字段）。

### 3.3 DEFAULT 数值（必须写入 `config.ts` Object.freeze）

视觉锚点：旧关键帧约 s2=1.20、|r2|≈4°、总段长约 640ms。下列为 **定稿初值**（允许策划在面板微调，禁止 AI 改公式）。

| 字段 | playPile 默认 | joker 默认 | 说明 |
|------|---------------|------------|------|
| enabled | true | true | |
| firstIntervalMS | 300 | 300 | 保留 |
| intervalReductionMS | 60 | 60 | 保留 |
| lastIntervalMS | 150 | 150 | 保留 |
| mass | 1 | 1 | |
| angularFreq | 14 | 14 | rad/s，约数个可见半周期 |
| dampingRatio | 0.45 | 0.45 | 欠阻尼过冲 |
| impulseScale | -0.08 | -0.08 | 先略缩（对齐旧 s1≈0.92 方向） |
| impulseScaleVel | 0 | 0 | |
| impulseRotDeg | 0.5 | 0.5 | 对齐旧 r1 量级 |
| impulseRotVelDeg | -40 | -40 | 提供旋转动能，替代旧 r2 大幅摆动 |
| settleEpsScale | 0.004 | 0.004 | |
| settleVelScale | 0.05 | 0.05 | 1/s |
| settleEpsRotDeg | 0.15 | 0.15 | |
| settleVelRotDeg | 2 | 2 | deg/s |
| maxDurationMS | 1200 | 1200 | 硬帽 |
| maxDtSec | 1/30 | 1/30 | 与绳 `maxDtSec` 习惯一致；若绳默认不同则读绳 DEFAULT 抄同一数字 |
| substeps | 4 | 4 | |
| textTriggerMS | 120 | 120 | 对齐旧 t1 |

**实现时：** 打开 `CONFIG.elasticRopeCard.integration` 的 `maxDtSec`/`substeps` 默认值，若存在则 **原样抄写** 到上表对应字段（保持全项目积分习惯一致）；若读取失败再用 `1/30` 与 `4`。

### 3.4 mergeConfig

- `merged.playPileSettleEffect = { ...DEFAULT.playPileSettleEffect, ...incoming.playPileSettleEffect }`
- 对 incoming 中 **遗留** `s1` 等键：**忽略不报错**（展开后多余键不进类型即可）
- shipping.json：删除旧 s/t/r；写入新字段或依赖 DEFAULT

---

## 4. 调试面板必须公开的参数

### 4.1 必须公开（HTML + ControlPanel bind）

**专区标题：** `【出牌】出牌堆的结算效果` / 小丑对应专区同理。

| UI 标签（中文建议） | 绑定路径 | 控件 | step/范围建议 |
|--------------------|----------|------|----------------|
| 开关 | `*.enabled` | checkbox | |
| 第一张后间隔 ms | `*.firstIntervalMS` | number | step 10, min 0, max 2000 |
| 间隔递减 ms | `*.intervalReductionMS` | number | step 5, min 0, max 1000 |
| 最后间隔 ms | `*.lastIntervalMS` | number | step 10, min 0, max 2000 |
| 自然频率 ωn | `*.angularFreq` | number | step 0.5, min 0.5, max 60 |
| 阻尼比 ζ | `*.dampingRatio` | number | step 0.05, min 0, max 3 |
| 质量 m | `*.mass` | number | step 0.05, min 0.05, max 10 |
| 初始缩放偏离 | `*.impulseScale` | number | step 0.01, min -0.5, max 0.5 |
| 初始旋转角 ° | `*.impulseRotDeg` | number | step 0.1, min -45, max 45 |
| 文字触发延迟 ms | `*.textTriggerMS` | number | step 10, min 0, max 2000 |
| 最长时长 ms | `*.maxDurationMS` | number | step 50, min 100, max 5000 |

### 4.2 必须公开但可放在「进阶」折叠（仍要 bind，默认展开或与绳 settle 同级）

| UI 标签 | 绑定路径 |
|---------|----------|
| 初始缩放速度 | `*.impulseScaleVel` |
| 初始角速度 °/s | `*.impulseRotVelDeg` |
| settle 缩放位置阈值 | `*.settleEpsScale` |
| settle 缩放速度阈值 | `*.settleVelScale` |
| settle 角位置阈值 ° | `*.settleEpsRotDeg` |
| settle 角速度阈值 °/s | `*.settleVelRotDeg` |
| 最大 dt 秒 | `*.maxDtSec` |
| 子步数 | `*.substeps` |

### 4.3 禁止出现在面板

任何 `s1–s5`、`t1–t5`、`r1–r4` 控件；禁止「阶段 1–5」文案。

### 4.4 实现文件

- `index.html`：`sect-playPileSettleEffect-params`、小丑结算专区同步改
- `src/debug/ControlPanel.ts`：删除旧 bind，添加新 bind（模式照抄现有 `bindNumber`/`bindToggle`）

---

## 5. 代码落点与 API（禁止改路径语义）

### 5.1 新建 `src/motion/SpringDamper1D.ts`

**必须导出：**

```ts
export interface SpringDamper1DParams {
  mass: number;
  angularFreq: number;  // ωn rad/s
  dampingRatio: number; // ζ
}

export class SpringDamper1D {
  x = 0;
  v = 0;

  reset(x: number, v: number): void;
  /**
   * 积分 dtSec 秒（调用方已 cap / 已按 gameSpeed 处理有效时间）。
   * 内部：dt = min(dtSec, maxDtSec)；h = dt/substeps；子步半隐式欧拉。
   */
  step(
    dtSec: number,
    xTarget: number,
    params: SpringDamper1DParams,
    maxDtSec: number,
    substeps: number,
  ): void;

  isSettled(xTarget: number, epsPos: number, epsVel: number): boolean;
}
```

**`step` 伪代码（必须等价）：**

```
m = max(1e-6, params.mass)
wn = clamp(params.angularFreq, 1e-6, 60)
zeta = max(0, params.dampingRatio)
k = m * wn * wn
c = 2 * zeta * m * wn
dt = min(max(0, dtSec), max(1e-6, maxDtSec))
n = max(1, floor(substeps))
h = dt / n
for i in 0..n-1:
  a = (-k * (this.x - xTarget) - c * this.v) / m
  this.v += a * h
  this.x += this.v * h
  if !finite(this.x) or !finite(this.v): this.x = xTarget; this.v = 0; break
```

**参考依据：** `ElasticRopeMotion.step` 子步结构；Gaffer Integration Basics；绳文档半隐式欧拉。

**单元烟测（可选但推荐，写在文件底 `export function __selfTest` 或独立测试）：**

- ζ=1, x0=2, target=1, 足够时间后 |x-1| 与 |v| 小于阈值
- ζ=0.3 应出现至少一次 (x-1) 符号变化（过冲）再 settle

### 5.2 改写 `PlayPileFx.animateCardSettle`

**新签名：**

```ts
animateCardSettle(
  tm: TweenManager,
  card: CardView,
  cfg: PlayPileSettleSpringConfig, // 即新 schema（已在 pipeline 做过 scaleTimeMS 的字段）
  onTextTrigger?: () => void,
): Promise<void>
```

**行为（必须）：**

1. `tm.killOf(card)` — 清掉该卡旧 tween，避免与 scoring 字段冲突。
2. 构造 `scaleSpring = new SpringDamper1D()`，`rotSpring = new SpringDamper1D()`。
3. `scaleSpring.reset(1 + cfg.impulseScale, cfg.impulseScaleVel)`  
   `rotSpring.reset(deg2rad(cfg.impulseRotDeg), deg2rad(cfg.impulseRotVelDeg))`
4. 立即写一次 `card.scoringScaleMul` / `scoringRotOffset`。
5. **驱动循环：** 禁止独立 rAF。采用下列 **唯一允许** 方式之一（优先 A）：

#### 驱动方式 A（定稿优先）— 无渲染代理 + TweenManager

```
// 创建代理对象，Tween 仅用于每帧被 TweenManager.update 推进
const driver = { t: 0 }
let elapsedMS = 0
let textFired = false
const maxMS = cfg.maxDurationMS  // 调用方已 scaleTimeMS

const params = { mass: cfg.mass, angularFreq: cfg.angularFreq, dampingRatio: cfg.dampingRatio }

return new Promise((resolve) => {
  const finish = () => {
    scaleSpring.x = 1; scaleSpring.v = 0
    rotSpring.x = 0; rotSpring.v = 0
    card.scoringScaleMul = 1
    card.scoringRotOffset = 0
    resolve()
  }

  // 使用超长 duration 的线性 tween 占位，在 onUpdate 里读真实 dt
  // 若当前 Tween API 无 onUpdate(dt)：则用方式 B
  ...
})
```

**若 `Tween` 类不支持 per-frame onUpdate：** 必须用方式 B，禁止发明第三种时钟。

#### 驱动方式 B（Tween 无 per-frame 回调时）— 挂到 CardView 临时 tick

1. 在 `CardView` 增加可选：

```ts
/** 结算弹簧每帧回调；null 表示未在结算 */
settleSpringTick: ((dtMS: number) => void) | null = null;
```

2. 在 `CardView.update(dtMS)` 末尾（在 `stepElasticRope` 之后）：

```ts
this.settleSpringTick?.(dtMS);
```

3. `animateCardSettle` 内：

```ts
card.settleSpringTick = (dtMS) => {
  const speed = CONFIG.gameSpeed
  const effectiveDtMS = dtMS * (Number.isFinite(speed) && speed > 0 ? speed : 1)
  // 说明：scaleTimeMS 是 ms/speed；等价于时间流逝加快 speed 倍
  // 故积分应用 effectiveDtMS = dtMS * gameSpeed，使动画在 wall-clock 上变短
  const dtSec = effectiveDtMS / 1000
  elapsedMS += effectiveDtMS

  scaleSpring.step(dtSec, 1, params, cfg.maxDtSec, cfg.substeps)
  rotSpring.step(dtSec, 0, params, cfg.maxDtSec, cfg.substeps)
  card.scoringScaleMul = scaleSpring.x
  card.scoringRotOffset = rotSpring.x

  if (!textFired && elapsedMS >= cfg.textTriggerMS) {
    textFired = true
    onTextTrigger?.()
  }

  const rotEps = cfg.settleEpsRotDeg * Math.PI/180
  const rotVelEps = cfg.settleVelRotDeg * Math.PI/180
  const done =
    (scaleSpring.isSettled(1, cfg.settleEpsScale, cfg.settleVelScale) &&
     rotSpring.isSettled(0, rotEps, rotVelEps)) ||
    elapsedMS >= cfg.maxDurationMS
  if (done) {
    card.settleSpringTick = null
    finish()
  }
}
```

4. **清理：** Promise resolve 前、`tm.killOf` 场景、或外部中断时必须 `card.settleSpringTick = null` 并硬置 mul/rot。

**gameSpeed 与 dt 的定稿约定（禁止改）：**

- 文档 `scaleTimeMS`：`effectiveMS = baseMS / gameSpeed`（加速时间隔变短）。
- 弹簧：wall-clock 一帧 `dtMS` 对应逻辑时间 `dtMS * gameSpeed`（加速时同一 wall 帧推进更多逻辑时间 → 更快 settle）。
- `textTriggerMS`、`maxDurationMS` 在 **Pipeline 传入前** 已 `scaleTimeMS`；`elapsedMS` 累加的是 **逻辑 ms**（即上面的 `effectiveDtMS`），与已缩放阈值比较。

**理论依据：** 逻辑时间与 wall 时间解耦；与「时长 / speed」一致。  
**参考依据：** `config.ts` `scaleTimeMS` 注释；Juckett「与帧率无关的同一物理时间」。

### 5.3 `PlayPipeline.ts`

```ts
const raw = CONFIG.playPileSettleEffect
const settleEffectCfg = {
  ...raw,
  firstIntervalMS: scaleTimeMS(raw.firstIntervalMS),
  intervalReductionMS: scaleTimeMS(raw.intervalReductionMS),
  lastIntervalMS: scaleTimeMS(raw.lastIntervalMS),
  textTriggerMS: scaleTimeMS(raw.textTriggerMS),
  maxDurationMS: scaleTimeMS(raw.maxDurationMS),
  // 禁止再传 t4/t5；禁止 scale s/t/r
}
// 逐张 await PlayPileFx.animateCardSettle(..., () => TextFx...)
// 间隔逻辑保持现有 first/reduction/last 代码不变
```

小丑分支：对 `CONFIG.jokerSettleEffect` 做 **相同** scaleTimeMS 字段列表。

### 5.4 `CardView.ts`

- 保留 `scoringScaleMul` / `scoringRotOffset` 合成逻辑不变。
- 仅增加 `settleSpringTick` 钩子（方式 B）或确认方式 A 不需改 CardView。

### 5.5 禁止改动

- `ElasticRopeMotion` 公式与 settle 阈值语义  
- 三个间隔的业务公式（`first - i*reduction`，末张 `last`）

---

## 6. 分步实现清单（AI 按序执行）

### 步骤 S1 — SpringDamper1D

| 项 | 内容 |
|----|------|
| 理论 | §2.2–2.4 |
| 实现 | 新建 `src/motion/SpringDamper1D.ts` 全文按 §5.1 |
| 参考 | ElasticRopeMotion 子步；Gaffer；绳 damping-plan §2.4 |

### 步骤 S2 — Config schema + DEFAULT + merge

| 项 | 内容 |
|----|------|
| 理论 | 删除关键帧；ωn/ζ 对外 |
| 实现 | 改 `src/game/config.ts` 类型、DEFAULT、clone/merge 中 `playPileSettleEffect`/`jokerSettleEffect`；`shipping.json` 同步 |
| 参考 | 本文件 §3 |

### 步骤 S3 — PlayPileFx.animateCardSettle

| 项 | 内容 |
|----|------|
| 理论 | 双通道 + 激励 + settle + textTrigger |
| 实现 | §5.2 方式 B（若 Tween 无 onUpdate）或 A |
| 参考 | 旧 animateCardSettle 清理语义；Reanimated rest thresholds |

### 步骤 S4 — CardView tick 钩子（若 B）

| 项 | 内容 |
|----|------|
| 实现 | `settleSpringTick` + `update` 调用 |
| 参考 | 现有 `update` 中 `stepElasticRope` 顺序：绳先、结算弹簧后 |

### 步骤 S5 — PlayPipeline

| 项 | 内容 |
|----|------|
| 实现 | 去掉 t4/t5 scale；改为 textTriggerMS/maxDurationMS scale |
| 参考 | §5.3；现有逐张循环 |

### 步骤 S6 — 面板 HTML + ControlPanel

| 项 | 内容 |
|----|------|
| 实现 | §4 全表 bind；删除旧 s/t/r DOM |
| 参考 | 现有 `bindNumber` 模式 |

### 步骤 S7 — 验收

| 项 | 内容 |
|----|------|
| 手测 | 出牌结算：牌先缩后过冲放大再回 1；有轻微角摆；数字约 120ms 逻辑时间出现 |
| 手测 | ζ=1 时几乎无过冲；ζ=0.3 更抖 |
| 手测 | gameSpeed=2 时间约为 1× 的一半 wall-clock |
| 手测 | 杀进程/重开不残留 scale≠1 |
| 手测 | 小丑结算同行为 |
| 回归 | 出牌位移/抬升仍走弹性绳，不被结算改 x/y |

---

## 7. 坑与技术陷阱（检索补充 · 实现必须规避）

| ID | 坑 | 证据 / 社群 | 本方案强制规避 |
|----|----|-------------|----------------|
| **P1** | ζ=0 永不停止 | Android Spring docs；Maxime Heckel 无 damping 曲线永不收敛 | `zeta=max(0,·)` 允许 0 但 **必须** `maxDurationMS` 硬帽 + 结束硬贴 |
| **P2** | 无位移/速度阈值导致「永远差一点」 | Reanimated #132 restSpeed/restDisplacement；precision 停机讨论 | 双通道 ε_pos ∧ ε_vel |
| **P3** | 大 dt 半隐式仍可能不稳 | Gaffer；Orange Duck bad damper；绳用 maxDt+substeps | 强制 maxDtSec + substeps≥1 |
| **P4** | 显式欧拉能量注入 | Orange Duck `spring_damper_bad` | 只用半隐式顺序 v→x |
| **P5** | 解析弹簧目标突变不连续 | Juckett 文动机；Orange Duck exact damper 目标跳变讨论 | 本方案结算目标恒定 1/0，**禁止**动画中改 target；激励只设初值 |
| **P6** | 独立 rAF 与游戏暂停/tab 节流脱节 | 通用游戏循环常识；本仓统一 App.onUpdate | 必须挂 CardView.update 或 TweenManager |
| **P7** | Tween 与弹簧抢写 scoring 字段 | 本仓 TweenManager 同字段互斥；旧 animateCardSettle 用 tween | 开始 `killOf(card)`；弹簧期间勿再 tween 同字段 |
| **P8** | gameSpeed 双重缩放或漏缩放 | 旧 t1–t3 不缩放造成语义分裂 | 间隔 + textTrigger + maxDuration 用 scaleTimeMS；积分用 dt×gameSpeed；**禁止**再缩放 ωn |
| **P9** | 结束未复位 mul/rot | 旧 onStop 曾硬置 1/0 | finish 路径必须硬置 |
| **P10** | NaN 污染 | 绳 T1 安全网 | step 内 non-finite → 贴目标清零速度 |
| **P11** | 子步数=0 或 maxDt=0 | 除零 | `substeps=max(1,floor)`，`maxDtSec=max(1e-6,·)` |
| **P12** | 与绳角弹簧参数混淆 | 两套 ωn 同名 | 面板文案写「结算弹簧」；配置挂在 playPileSettleEffect 下 |
| **P13** | shipping 预设残留 s/t/r | JSON merge | 更新 shipping；merge 忽略未知旧键 |
| **P14** | 文字触发重复 fire | 逻辑错误 | `textFired` 门闩仅一次 |
| **P15** | 中断后 tick 泄漏 | 异步 await 取消 | settleSpringTick=null 在 finish/kill |

**补充检索来源清单（执行时无需再搜，已纳入上表）：**

- https://www.ryanjuckett.com/damped-springs/
- https://theorangeduck.com/page/spring-roll-call
- https://github.com/orangeduck/Spring-It-On
- https://gafferongames.com/post/integration_basics/
- https://github.com/software-mansion/react-native-reanimated/issues/132
- https://developer.android.com/develop/ui/views/animations/spring-animation
- https://blog.maximeheckel.com/posts/the-physics-behind-spring-animations/
- https://toqoz.fyi/springs.html
- https://github.com/charmbracelet/harmonica
- https://github.com/skevy/wobble
- 本仓库 `docs/elastic-rope-rotation-damping-plan.md`、`src/motion/ElasticRopeMotion.ts`

---

## 8. 开源对照：允许抄什么 / 禁止抄什么

| 来源 | 允许 | 禁止 |
|------|------|------|
| 本仓 ElasticRopeMotion | 半隐式子步结构、wn clamp、settle 合取、NaN 安全网 | 把 Fsx 力矩逻辑拷进结算 |
| orangeduck/Spring-It-On | 阅读 spring damper 正确形式 | 整文件粘贴 C++；采用 bad 变体 |
| Juckett / harmonica | 理解 ζ/ωn、结束语义 | 本方案 **不** 实现解析系数矩阵（定稿为数值 MSMD）；禁止 npm |
| wobble | mass/stiffness/damping 语义对照；可用 \(k=m\omega_n^2\) 换算理解 | `import from 'wobble'` |
| Toqoz SpringTransform | 双通道独立弹簧思想 | Unity C# 依赖 |
| react-spring / Motion | 文档参数心智 | 运行时依赖 |

---

## 9. 与旧系统行为对照（验收用，非实现）

| 旧 | 新 |
|----|----|
| 5 段 scale 关键帧 | 1 次激励 + 衰减至 1 |
| 4 段 rot 关键帧 | 初角 + 初角速度衰减至 0 |
| t1 结束弹字 | `textTriggerMS` |
| t4/t5 受倍速 | 整段逻辑时间受倍速（dt 与 max/trigger） |
| 固定总时长 | settle 或 maxDuration |

---

## 10. 完成定义（DoD）

1. 源码中 **无** `playPileSettleEffect.s1` 等字段引用。  
2. `SpringDamper1D` 存在且仅被结算路径使用（可被单测引用）。  
3. 面板仅 §4 参数，无 s/t/r。  
4. 出牌与小丑结算均走新动画。  
5. 不修改弹性绳位移语义。  
6. 无新增 npm 依赖。  
7. 本文 §7 陷阱均有对应代码防护（硬帽、ε、kill、finite、门闩）。

---

## 11. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-07-15 | 初版定稿：组合 R1；检索补充 P1–P15 |
