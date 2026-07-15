# 弹性绳卡牌旋转阻尼 — AI 可执行完整方案（定稿）

> **状态：** 定稿，供实现执行（禁止自我发挥）  
> **时间节点：** 2026-07-15  
> **选型代号：** 路线 β（准静态 θ_target + 二阶角弹簧阻尼 + 可选幂映射）  
> **前置文档：** `docs/elastic-rope-traction-card-model.md`（平移与旋转驱动源仍以该文为准）

---

## 0. 执行约束（给 AI，必须逐条遵守）

1. **只实现本文写明的选型与公式**，禁止改用：
   - Verlet / 四元数 / 完整 3D 刚体
   - 平移速度倾斜 `CONFIG.cardMoveRotation` 叠到本沙盒
   - 外部 npm 动画库（react-spring / framer-motion / wobble）**运行时依赖**（允许对照其公式与参数心智，但代码自写）
   - 用平移 `airDrag.linearCoeff` 直接当角阻尼系数
   - 完整 `p × F`（含 \(F_y\)）作为默认驱动（会破坏「纯上下不拧」）
2. **不得改动手牌主路径**：`GameController`、`CardView.updateDragging`、主局 `dragHandCard` 行为不变。
3. **默认行为兼容**：shipping / DEFAULT 中 `dynamics` 默认 **`springDamper`**（本方案目标即上阻尼）；若需 A/B，允许面板切回 `follow` / `instant`。旧 JSON 缺字段时由 `mergeConfig` 用 DEFAULT 补齐。
4. **每个实现步骤**必须同时满足：理论依据 → 具体实现 → 参考依据；禁止未引用的「经验改法」。
5. **禁止**把 react-spring 的 `duration` 模式混进积分器（与绳文档同一禁令）。

---

## 1. 定稿技术选型一览（禁止替换）

| 模块 | 定稿方案 | 禁止方案 |
|------|----------|----------|
| 驱动源 | 仅 \(F_{s,x}\) + 锚点 \(p_y\) 符号（现有） | \(v\) 倾斜；默认含 \(F_y\) 的完整力矩 |
| 力→目标角映射 | `mapMode: linear \| power`；power 用 \(u^\gamma\) | 任意贝塞尔编辑器；查表 |
| 旋转动力学 | `dynamics: instant \| follow \| springDamper` | 仅 follow；真 \(r\times F\) 刚体默认 |
| 角阻尼 | 线性 \(-c_\theta\omega\)；对外用 \(\zeta\) 标定 | 复用 airDrag \(c\)；干摩擦默认 |
| 参数暴露 | 对外 `inertia, angularFreq, dampingRatio`；对内 \(k_\theta,c_\theta\) | 只暴露 raw \(k,c\) 无 \(\zeta\) |
| 积分 | 与平移 **同一 substep 循环内** 半隐式欧拉 | 帧末单独积分二阶弹簧；显式欧拉 |
| 限幅 | clamp \(\theta_{\mathrm{target}}\) + 硬夹 \(\theta\) 并清除外向 \(\omega\)（C3） | 只限 target 不限 \(\theta\)；软势能默认 |
| settle | 吸附时 \(\theta=0,\omega=0\)（S1） | 吸附后角继续长时间晃 |
| 锚点 | `rotationAffectsAnchor` 仅影响 debug 世界锚点（现有） | 默认用旋转后 \(p\) 反馈力矩 |
| 代码落点 | `ElasticRopeMotion` 纯 TS | 嵌 PIXI；TweenManager 驱动角 |

---

## 2. 符号与公式（实现必须逐字遵守）

### 2.1 符号

| 符号 | 含义 | 单位 |
|------|------|------|
| \(F_{s,x}\) | 弹力水平分量（平移积分已算） | 力 |
| \(\theta\) | 卡牌旋转角 | rad |
| \(\omega\) | 角速度 | rad/s |
| \(\theta^*\) | 目标角 | rad |
| \(\theta_{\max}\) | `maxAngleDeg` 转 rad | rad |
| \(I\) | `inertia` | 无量纲惯量 |
| \(\omega_n\) | `angularFreq` | rad/s（自然频率） |
| \(\zeta\) | `dampingRatio` | 无量纲 |
| \(k_\theta\) | 角刚度 | \(k_\theta = I\omega_n^2\) |
| \(c_\theta\) | 角阻尼 | \(c_\theta = 2\zeta I\omega_n\) |
| \(\gamma\) | `responseGamma` | 无量纲，power 映射用 |
| \(h\) | 子步长 = `dtSec / substeps` | s |

### 2.2 驱动与符号（不变）

**理论：** 力矩符号等价于水平力对锚点 \(p=(p_x,p_y)\) 的 \(p\times(F_{s,x},0)=-p_y F_{s,x}\)（未旋转本地锚点）。

```
FsHoriz = Fsx                    // 本帧/本子步最后一次平移力中的 x
FsHorizMag = abs(FsHoriz)
py = anchorLocalY
cross = -py * FsHoriz
signTorque = (|cross| >= 1e-6 && FsHorizMag > 1e-6) ? sign(cross) : 0
```

**参考依据：**

- 本仓库现实现：`src/motion/ElasticRopeMotion.ts` 旋转块（约 L158–179）
- 定稿绳文档：`docs/elastic-rope-traction-card-model.md` §1.7

### 2.3 力→目标角映射

\[
F_{\mathrm{ref}} = \max(k\cdot L_{\max},\, \varepsilon_F),\quad
u = \mathrm{clamp}\bigl(|F_{s,x}| / F_{\mathrm{ref}},\, 0,\, 1\bigr)
\]

| `mapMode` | \(g(u)\) |
|-----------|----------|
| `linear` | \(g(u)=u\)（再经 `forceToAngle` 路径，见下） |
| `power` | \(g(u)=u^\gamma\)，\(\gamma=\max(0.05,\texttt{responseGamma})\) |

**定稿标定规则（禁止另造）：**

- **`mapMode === "linear"`（兼容现状）：**

```
if (signTorque == 0) thetaTarget = 0
else thetaTarget = clamp(forceToAngle * FsHorizMag * signTorque, -maxRad, maxRad)
```

- **`mapMode === "power"`：**

```
// 最大弹力时 |θ*| 应对齐 maxAngle（与 forceToAngle 脱钩，避免双增益）
if (signTorque == 0) thetaTarget = 0
else {
  u = clamp(FsHorizMag / max(k*Lmax, 1e-9), 0, 1)
  g = pow(u, max(0.05, responseGamma))
  thetaTarget = clamp(signTorque * maxRad * g, -maxRad, maxRad)
}
```

**理论依据：** 幂映射 \(u^\gamma\)（\(\gamma>1\)）降低小力区灵敏度、大力区趋近饱和，是响应曲线压缩的标准手段；稳态角由 \(g(u)\) 决定，**不**替代动力学阻尼。

**参考依据：**

- 二阶系统 / 非线性响应工程常用幂与 soft-knee（概念对照）：控制与 UI 弹簧文献中的「gain shaping」
- 卡牌倾角行业参考（跟随轴，非本积分）：[Hearthstone-like card drag / DragRotator](https://gamedev.stackexchange.com/questions/137265/how-to-make-card-movement-behave-like-those-in-hearthstone-and-eternal-ccg)
- 本方案 **不** fork DragRotator 源码，仅作手感对照

### 2.4 角刚度 / 阻尼标定（对外 ζ，对内 k、c）

\[
k_\theta = I \omega_n^2,\qquad
c_\theta = 2\zeta I \omega_n
\]

**理论依据：** 标准二阶系统 \(\ddot\theta + 2\zeta\omega_n\dot\theta + \omega_n^2\theta = \omega_n^2\theta^*\) 在 \(I\ddot\theta = k_\theta(\theta^*-\theta)-c_\theta\omega\) 下的等价改写；\(\zeta=1\) 临界阻尼（无过冲最快回目标）。

**参考依据：**

- [Theory of Second-Order Systems (UML PDF)](https://faculty.uml.edu/pavitabile/dynsys.uml.edu/tutorials/2nd_Order_Systems/second_order_theory_011805.pdf)
- [Alexis Bacot — The Art of Damping](https://www.alexisbacot.com/blog/the-art-of-damping) + 仓库 [AlexisBacot/ArtOfDamping](https://github.com/AlexisBacot/ArtOfDamping)（critical spring damper / SmoothDamp 族）
- [react-spring config：mass / tension / friction 心智](https://www.react-spring.dev/docs/advanced/config)（**对照参数语义，禁止引入包**）
- [Game Math — PD ≈ spring–damper](https://gamemath.com/book/dynamics.html)
- 社区：阻尼比 \(\zeta\approx 1\) = 专业冷静；降低 damping 更 jumpy（X/设计讨论共识，2026 检索）

**实现必须：**

```
I = max(1e-6, inertia)
wn = max(1e-6, angularFreq)
zeta = max(0, dampingRatio)
kTheta = I * wn * wn
cTheta = 2 * zeta * I * wn
```

### 2.5 动力学三种模式

#### `instant`

```
theta = thetaTarget
omega = 0
```

#### `follow`（保留现逻辑，帧率校正）

```
// 使用整帧 dtMS（与现码一致），不在子步内重复 follow 多次导致过冲滤波
follow = angleFollow
if (follow <= 0 || follow >= 1) { theta = thetaTarget; omega = 0 }
else {
  alpha = 1 - Math.pow(1 - follow, dtMS / 16.667)
  theta += (thetaTarget - theta) * alpha
  omega = 0   // follow 模式不维持角速度状态
}
```

**参考：** 现 `ElasticRopeMotion.ts` L180–186；绳文档 §1.7。

#### `springDamper`（定稿主路径）

每个 **平移子步** 结束后（该子步已更新 `x,y,vx,vy` 与当步 \(F_{s,x}\)），用 **同一 \(h\)**：

```
// 1) 用当子步的 Fsx 重算 thetaTarget（§2.2–2.3）
// 2) 二阶：
torque = kTheta * (thetaTarget - theta) - cTheta * omega
alphaAng = torque / I
omega += alphaAng * h          // 半隐式：先 ω
theta += omega * h
// 3) 限幅 C3：
if (theta > maxRad)  { theta = maxRad;  if (omega > 0) omega = 0 }
if (theta < -maxRad) { theta = -maxRad; if (omega < 0) omega = 0 }
```

**理论依据：** 半隐式（symplectic）欧拉先速度后位置，与平移核一致；子步缩小 \(h\) 提高硬弹簧稳定域。

**参考依据：**

- 本仓库平移注释：`ElasticRopeMotion.ts` 头注释「半隐式欧拉 + dt clamp + substeps」
- 绳文档 §1.4–1.5；[Gaffer on Games — Fix Your Timestep](https://gafferongames.com/post/fix_your_timestep/)（大 dt clamp，避免 spiral of death）
- Unity `angularDrag` 语义对照（减速旋转，非本实现拷贝）：[Rigidbody.angularDrag](https://docs.unity3d.com/2021.3/Documentation/ScriptReference/Rigidbody-angularDrag.html)
- 无物理引擎旋转弹簧示例（对照，不拷依赖）：[gist SpawnCampGames 旋转 spring](https://gist.github.com/SpawnCampGames/c069cb7bb3954b36f559bc1a9fec880d)
- 拖拽物 + angularDrag 示例：[gist bf63404…](https://gist.github.com/bf63404dbaf8e8c5ae19822ab6a862ec)
- 桌面模拟物属性分栏 drag / angular_drag：[Tabletop-Simulator-API object.md](https://github.com/Berserk-Games/Tabletop-Simulator-API/blob/master/docs/object.md)

**禁止：** 在 `springDamper` 下再叠加 `angleFollow`。

### 2.6 Settle（吸附）

当平移满足现有：

```
D < settle.distancePx AND speed < settle.speedPxPerSec
```

则：

```
x,y = tx,ty; vx,vy = 0
theta = 0; omega = 0     // S1 强制
```

**参考：** 绳文档 §1.6；现 L139–149 与 L187–189。

---

## 3. CONFIG / 类型结构（必须写入）

### 3.1 `rotation` 扩展字段

路径：`RuntimeConfig.elasticRopeCard.rotation` 与 `ElasticRopeParams.rotation` **同构**。

```ts
rotation: {
  enabled: boolean
  /** 驱动增益：仅 mapMode=linear 时参与 θ* */
  forceToAngle: number
  maxAngleDeg: number
  /** 仅 dynamics=follow */
  angleFollow: number
  rotationAffectsAnchor: boolean

  /** 新增：动力学模式 */
  dynamics: "instant" | "follow" | "springDamper"
  /** 新增：力→角映射 */
  mapMode: "linear" | "power"
  /** 新增：power 指数，建议默认 1.5；linear 时忽略 */
  responseGamma: number
  /** 新增：角惯量 I，默认 1 */
  inertia: number
  /** 新增：自然频率 ωn (rad/s)，默认 12 */
  angularFreq: number
  /** 新增：阻尼比 ζ，默认 1.0（临界） */
  dampingRatio: number
}
```

### 3.2 推荐默认初值（必须写入 DEFAULT + shipping.json）

| 字段 | 默认值 | 依据 |
|------|--------|------|
| `enabled` | `true` | 现有 |
| `forceToAngle` | `0.000029` | 现有；约 \(\theta_{max}/(k L_{max})\) 量级 |
| `maxAngleDeg` | `20` | 现有 |
| `angleFollow` | `0.35` | 现有；仅 follow 模式 |
| `rotationAffectsAnchor` | `false` | 现有 |
| `dynamics` | `"springDamper"` | 本方案目标 |
| `mapMode` | `"linear"` | 兼容；需要钝感再改 power |
| `responseGamma` | `1.5` | \(\gamma>1\) 小力区更钝 |
| `inertia` | `1` | 与质量 m 类似标定 |
| `angularFreq` | `12` | ~2Hz 量级回正，卡牌手感；可拧 |
| `dampingRatio` | `1.0` | 临界，稳重无弹 |

**标定提示（写进文档注释即可，非运行时）：**

- \(\zeta<1\) 欠阻尼会晃 → 卡牌默认禁止用过低 ζ 作为 shipping
- \(\omega_n\) 过大 + `substeps=1` 易数值炸 → 见 §7 陷阱

### 3.3 文件修改清单（AI 必须改）

| 文件 | 动作 |
|------|------|
| `src/motion/ElasticRopeTypes.ts` | 扩展 `rotation` 类型 |
| `src/motion/ElasticRopeMotion.ts` | 状态 `omega`；子步内 springDamper；reset/settle 清 ω；selfCheck 增测 |
| `src/game/config.ts` | `RuntimeConfig` 类型、DEFAULT、`cloneConfig` 已浅拷 rotation 对象字段（展开新字段即可）、`mergeConfig` 已 `...er.rotation` |
| `public/presets/shipping.json` | 写入完整 `elasticRopeCard.rotation` 新字段 |
| `index.html` | 旋转专区新增控件 DOM（id 见 §5） |
| `src/debug/ControlPanel.ts` | `bindCycleButton` / `bindNumber` 绑定新路径 |
| `docs/elastic-rope-traction-card-model.md` | §1.7 增补 springDamper 与映射（或交叉引用本文） |
| `src/scenes/ElasticRopeSandboxScene.ts` | `readRopeParams` 已 `rotation: { ...c.rotation }`，**确认**扩展字段随展开传入，无需逻辑大改 |
| `ARCHITECTURE.md` | 若有 elastic 描述，一行指向本文 |

**禁止修改：** `CardView` 主拖拽、`GameController` 默认入口逻辑。

---

## 4. 运动核实现规格（逐步）

### 步骤 A — 状态

**理论：** 二阶系统需要 \((\theta,\omega)\) 状态；仅 \(\theta\) 无法表达阻尼耗散。

**实现：**

```ts
// ElasticRopeMotion 私有字段
private rotation = 0
private omega = 0   // 新增 rad/s
```

`reset(pose)`：

```
this.rotation = pose.rotation ?? 0
this.omega = 0
```

**参考：** ArtOfDamping / 标准弹簧状态；本仓库 `reset` 已清 `vx,vy`。

### 步骤 B — 重构 `step` 中旋转时机

**理论：** 弹簧力在子步内随位置变；角目标应跟当步 \(F_{s,x}\)，否则滞后一帧。

**实现（伪代码，替换现「帧末整块旋转」）：**

```
// 已有：
dtSec = min(dtMS/1000, maxDtSec)
h = dtSec / substeps
// 循环前：若 !rotation.enabled → rotation=0; omega=0; 跳过角

for i in 0..substeps-1:
  // ... 现有平移力与半隐式积分，得到 lastFsx ...

  if rotation.enabled && dynamics == "springDamper":
    thetaTarget = computeThetaTarget(lastFsx, params)  // §2.2–2.3
    integrateSpringDamper(h, thetaTarget, params)      // §2.5
  // follow/instant：不要在子步内重复；见步骤 C

// 循环后：
if rotation.enabled && dynamics == "follow":
  thetaTarget = computeThetaTarget(lastFsx, params)
  applyFollow(dtMS, thetaTarget, params)
else if rotation.enabled && dynamics == "instant":
  thetaTarget = computeThetaTarget(lastFsx, params)
  rotation = thetaTarget; omega = 0
else if !rotation.enabled:
  rotation = 0; omega = 0

// settle（现有条件）后强制：
if settled:
  rotation = 0; omega = 0
```

**参考：** 绳文档 substeps 结构 L79–137；Gaffer timestep。

### 步骤 C — `computeThetaTarget` 纯函数

**实现位置：** `ElasticRopeMotion.ts` 内 private 方法或文件级函数。

**输入：** `Fsx, sign 用 anchorLocalY, params.spring, params.rotation`  
**输出：** `thetaTarget` rad  

必须覆盖 linear / power 两分支（§2.3）。  
**禁止**使用 `vy`、`Fd`、完整 `Fs` 模长（除非仅 debug）。

### 步骤 D — `integrateSpringDamper`

严格 §2.5 半隐式 + C3。  
\(I,k_\theta,c_\theta\) 每子步从 params 现算（允许面板热改）。

### 步骤 E — debug 快照（可选但推荐）

在 `ElasticRopeDebugSnapshot` **可选新增**（若加必须面板/HUD 可关）：

```ts
thetaTarget?: number
omega?: number
```

HUD 仅在 `debug.showHudReadouts` 时显示。  
**参考：** 现 debug 字段 D/Le/Lr/speed/Vterm。

### 步骤 F — selfCheck 扩展

在 `selfCheckElasticRopeMotion` **追加**（失败则 push 字符串）：

1. **springDamper + 水平力：** `dynamics=springDamper`, `angleFollow` 任意，小 dt 多步后 `|rotation|` 应 **趋向** 非零（不能永远 0）。  
2. **临界无爆炸：** `angularFreq=20`, `dampingRatio=1`, `substeps=2`, 水平目标，120 帧后 `|rotation| <= maxRad + 1e-3`，`Number.isFinite(omega)`。  
3. **垂直仍为 0：** 与现测相同，`dynamics=springDamper` 下纯垂直 `|rotation|<1e-3`（允许瞬态后回 0）。  
4. **settle 清 ω：** settle 后若可访问 omega（或通过再 step 不甩飞）— 通过 `getDebug` 扩展或内部测试后 `rotation===0`。  
5. **follow 回归：** `dynamics=follow`, `angleFollow=1` 保持现有水平/垂直断言。

**禁止**删除现有自检。

---

## 5. 调试面板：必须公开的参数

**专区：** 现有「弹性绳子牵引卡牌模型 → 旋转」`#sect-elasticRope-rotation`  
**绑定方式：** 与现面板一致 — `bindNumber` / `bindToggle` / `bindCycleButton`（见 `ControlPanel.ts` 头注释与 L1514+）。

### 5.1 必须公开（完整清单）

| UI 中文标签 | CONFIG 路径 | 控件 | 约束 |
|-------------|-------------|------|------|
| 启用旋转 | `elasticRopeCard.rotation.enabled` | toggle | 现有 |
| 动力学模式 | `elasticRopeCard.rotation.dynamics` | cycle: `instant` / `follow` / `springDamper` | **新增** |
| 力到角映射 | `elasticRopeCard.rotation.mapMode` | cycle: `linear` / `power` | **新增** |
| 力到角系数 | `elasticRopeCard.rotation.forceToAngle` | number digits≥6 | 现有；linear 用 |
| 响应指数 γ | `elasticRopeCard.rotation.responseGamma` | number digits=2 | **新增**；power 用 |
| 最大角（度） | `elasticRopeCard.rotation.maxAngleDeg` | number | 现有 |
| 角跟随 (0–1) | `elasticRopeCard.rotation.angleFollow` | number | 现有；**仅 follow** |
| 角惯量 I | `elasticRopeCard.rotation.inertia` | number digits=2 | **新增** |
| 角频率 ωn | `elasticRopeCard.rotation.angularFreq` | number digits=2 | **新增** rad/s |
| 阻尼比 ζ | `elasticRopeCard.rotation.dampingRatio` | number digits=2 | **新增** |
| 旋转影响锚点 | `elasticRopeCard.rotation.rotationAffectsAnchor` | toggle | 现有 |

### 5.2 DOM id（必须使用，禁止自造冲突 id）

| 控件 | input/button id | value span id |
|------|-----------------|---------------|
| dynamics | `btn-elasticRotDynamics` | `val-elasticRotDynamics` |
| mapMode | `btn-elasticRotMapMode` | `val-elasticRotMapMode` |
| responseGamma | `inp-elasticResponseGamma` | `val-elasticResponseGamma` |
| inertia | `inp-elasticInertia` | `val-elasticInertia` |
| angularFreq | `inp-elasticAngularFreq` | `val-elasticAngularFreq` |
| dampingRatio | `inp-elasticDampingRatio` | `val-elasticDampingRatio` |

现有 id 保持：`inp-elasticRotEnabled`、`inp-elasticForceToAngle`、`inp-elasticMaxAngleDeg`、`inp-elasticAngleFollow`、`inp-elasticRotAffectsAnchor`。

### 5.3 面板文案建议（写死中文标签）

- 动力学模式：`动力学模式`
- 力到角映射：`力到角映射`
- 响应指数 γ：`响应指数 γ`
- 角惯量 I：`角惯量 I`
- 角频率 ωn：`角频率 ωn (rad/s)`
- 阻尼比 ζ：`阻尼比 ζ (1=临界)`

### 5.4 禁止公开（本阶段）

| 禁止项 | 原因 |
|--------|------|
| raw `kTheta` / `cTheta` | 由 \(I,\omega_n,\zeta\) 派生，双源冲突 |
| 角二次阻尼 \(c_2\) | 未选 A2 |
| 角 settle 独立阈值 | 未选 S3 |
| 软限幅刚度 | 未选 C4 |
| 把 airDrag 系数绑到旋转 | 量纲错误 |

### 5.5 只读（可选）

若实现 HUD：显示 `θ°`, `ω`, `θ*°` — 仅 `showHudReadouts`，**不**写入 CONFIG。

---

## 6. 与现有技术栈的对接方式（禁止另起炉灶）

| 能力 | 本仓库既有做法 | 本方案用法 |
|------|----------------|------------|
| 配置 | `CONFIG` + `mergeConfig` + `shipping.json` | 同路径扩展 rotation |
| 面板 | `bindNumber` / `bindCycleButton` / `bindSectionExpand` | 同模式 |
| 运动核 | 无 PIXI 的 `ElasticRopeMotion` | 只扩该类 |
| 沙盒 | `?scene=elastic-rope` + `ElasticRopeSandboxScene` | `readRopeParams` 展开 rotation |
| 积分风格 | 半隐式 + maxDt + substeps | 角共享 substeps |
| 自检 | `selfCheckElasticRopeMotion` | 扩展断言 |

**开源仓库用法边界：**

| 仓库/文 | 用法 |
|---------|------|
| [AlexisBacot/ArtOfDamping](https://github.com/AlexisBacot/ArtOfDamping) | **对照** critically damped / spring-damper 步进思想；**禁止**整包 Unity C# 搬进 TS |
| [pmndrs/react-spring](https://github.com/pmndrs/react-spring) + [config 文档](https://www.react-spring.dev/docs/advanced/config) | **对照** mass/tension/friction 与 \(I/\omega_n/\zeta\) 心智；**禁止** npm 依赖与 duration 模式 |
| [Berserk-Games/Tabletop-Simulator-API](https://github.com/Berserk-Games/Tabletop-Simulator-API/blob/master/docs/object.md) | **对照** angular_drag 与 linear drag 分栏 |
| 本仓库 `docs/elastic-rope-traction-card-model.md` | 平移与 \(F_{s,x}\) 驱动权威 |

---

## 7. 执行陷阱与缓解（检索补充后强制遵守）

### 陷阱 T1 — 硬弹簧 + 大步长爆炸

**现象：** \(\omega_n\) 很大、`substeps=1`、后台恢复大 `dt` → \(\theta,\omega\) 非有限。  
**社区/文献：** Gaffer「spiral of death」；半隐式欧拉对高刚度仍需足够小 \(h\)。  
**强制缓解：**

- 继续使用 `integration.maxDtSec` clamp（已有）
- `springDamper` 下若 `|omega| > 1000` 或 `!Number.isFinite`，该帧 `omega=0` 并将 `theta clamp`（安全网，打 debug 可选）
- 默认 `substeps >= 2`（已有默认 2，禁止把 shipping 改为 0）
- 面板 `angularFreq` 建议 UI `max=60`（硬限制可在 bind 或 clamp 输入）

### 陷阱 T2 — follow 与 springDamper 双重滤波

**现象：** 先 damper 再 follow → 无法标定。  
**缓解：** mode **互斥**（§2.5）；禁止串联。

### 陷阱 T3 — linear 映射 + forceToAngle 与 power 双增益

**现象：** power 仍乘 forceToAngle 导致顶不满或过顶。  
**缓解：** §2.3 定稿 — power **只用** \(g(u)\cdot\theta_{max}\)；linear **只用** forceToAngle。

### 陷阱 T4 — 限幅只夹 θ* 不夹 θ

**现象：** 惯性冲过 maxAngle。  
**缓解：** C3（§2.5）：夹 \(\theta\) 并去掉外向 \(\omega\)。  
**参考：** 碰撞响应中「位置投影 + 法向速度消除」同类；Unity 角限制常见做法。

### 陷阱 T5 — settle 未清 ω

**现象：** 吸附后下一帧角甩出。  
**缓解：** S1 同时 `omega=0`；`reset` 清 ω。

### 陷阱 T6 — 子步内 follow 重复 N 次

**现象：** `angleFollow` 被 apply substeps 次，等效过猛。  
**缓解：** follow/instant **仅帧末一次**；仅 springDamper 进子步。

### 陷阱 T7 — 把平移 c 当 c_θ

**现象：** 量纲与量级错（px/s vs rad/s）。  
**社群对照：** TTS/Unity 均 **分栏** linear drag 与 angular drag。  
**缓解：** 独立 `dampingRatio`/`angularFreq`；禁止代码读 `airDrag` 进角积分。

### 陷阱 T8 — 垂直拖仍微拧

**现象：** 数值噪声 \(F_{s,x}\) 非零。  
**缓解：** 保持 `EPS_D` / `EPS_CROSS`；可选 \(|F_{s,x}| < \varepsilon\) 则 sign=0（与现 EPS 一致即可，**禁止**另发明大死区 unless map 增加，本阶段不加 F 死区参数）。

### 陷阱 T9 — mergeConfig 丢嵌套

**现象：** shipping 半包字段冲掉默认。  
**缓解：** 现有 `rotation: { ...merged, ...er.rotation }` 已浅合并单层字段，**足够**；勿把 rotation 改成深层嵌套对象。  
**参考：** 本仓库 `config.ts` merge 段 L2498。

### 陷阱 T10 — 默认 ζ 过低导致「果冻牌」

**现象：** shipping \(\zeta=0.3\) 甩尾过度。  
**设计讨论：** dampingFraction≈1 更冷静。  
**缓解：** DEFAULT `dampingRatio=1.0`；文档标明欠阻尼仅调试用。

### 陷阱 T11 — `rotationAffectsAnchor=true` 与力矩反馈

**现象：** 若误用旋转后锚点算 sign，可能符号翻转抖动。  
**缓解：** **力矩/符号始终用未旋转 `anchorLocalY`**（现规格）；`rotationAffectsAnchor` 只影响 `refreshDebug` 世界锚点绘制。

### 陷阱 T12 — selfCheck 用 springDamper + 单步期望瞬时满角

**现象：** 二阶不能一步到 \(\theta^*\)。  
**缓解：** 水平非零测改为「多帧后非零」或 `|theta|` 朝 target 符号一致；满角测仅 `instant`/`follow=1`。

---

## 8. 验收清单（AI 完成后必须自测）

| # | 操作 | 期望 |
|---|------|------|
| 1 | `?scene=elastic-rope`，dynamics=`springDamper`，ζ=1 | 左右拖倾角有滞后、无剧烈振荡 |
| 2 | 纯上下拖 | 倾角≈0 |
| 3 | 松手冻结目标，牌 settle | 位姿贴合且角→0，不再甩 |
| 4 | 切 `follow` + angleFollow=1 | 行为接近改前线性灵敏 |
| 5 | 切 `power`，γ=2 | 小力更钝，大力接近 maxAngle |
| 6 | ζ=0.4 | 可见轻微过冲（调试用） |
| 7 | ζ=1.2，ωn=12 | 更肉、不弹 |
| 8 | 运行 `selfCheckElasticRopeMotion()` | 返回 `[]` |
| 9 | 面板改参数热更新 | 下一帧生效（每帧 readRopeParams） |
| 10 | 主游戏无 `scene=` | 手牌拖拽与改前一致 |

---

## 9. 实现顺序（严格按序，便于 review）

1. **类型与 DEFAULT / shipping** — 新字段默认值  
2. **Motion：omega + computeThetaTarget + springDamper 子步 + settle/reset**  
3. **selfCheck 扩展**  
4. **index.html DOM + ControlPanel 绑定**  
5. **文档交叉引用**（绳文档 §1.7 → 本文）  
6. **手动沙盒验收表 §8**  

每步禁止夹带无关重构。

---

## 10. 核心算法粘贴板（实现时唯一权威伪代码）

```
// 每帧 step(dtMS, params):
if !params.enabled: refreshDebug; return pose

maxDt = max(1e-4, params.integration.maxDtSec)
dtSec = clamp(dtMS/1000, 0, maxDt)
substeps = max(1, floor(params.integration.substeps))
h = dtSec / substeps
m = max(1e-6, params.integration.mass)
// k, Lmax, c, c2 ... 同现平移

I = max(1e-6, params.rotation.inertia)
wn = max(1e-6, params.rotation.angularFreq)
zeta = max(0, params.rotation.dampingRatio)
kTheta = I * wn * wn
cTheta = 2 * zeta * I * wn
maxRad = max(0, params.rotation.maxAngleDeg) * PI/180

for i in 1..substeps:
  // --- 平移：完全保持现有 Fs, Fd, 半隐式 ---
  // 得到 Fsx, Fsy, Le, Lr, D

  if params.rotation.enabled and params.rotation.dynamics == "springDamper":
    thetaTarget = computeThetaTarget(Fsx, params)  // §2.2-2.3
    torque = kTheta * (thetaTarget - rotation) - cTheta * omega
    omega += (torque / I) * h
    rotation += omega * h
    if rotation > maxRad:  rotation = maxRad;  if omega > 0: omega = 0
    if rotation < -maxRad: rotation = -maxRad; if omega < 0: omega = 0

// 平移 settle 判定（现有）
if settled:
  x,y = tx,ty; vx,vy = 0
  // 角在下方统一处理

if !params.rotation.enabled:
  rotation = 0; omega = 0
else if params.rotation.dynamics == "follow":
  thetaTarget = computeThetaTarget(lastFsx, params)
  // 现有 alpha follow；omega = 0
else if params.rotation.dynamics == "instant":
  rotation = computeThetaTarget(lastFsx, params); omega = 0
// springDamper：子步已更新 rotation/omega

if settled and params.rotation.enabled:
  rotation = 0; omega = 0

refreshDebug(...); return {x,y,rotation}
```

```
function computeThetaTarget(Fsx, params):
  maxRad = ...
  mag = abs(Fsx)
  py = anchorLocalY
  cross = -py * Fsx
  if mag <= EPS or abs(cross) < EPS: return 0
  sign = sign(cross)
  if params.rotation.mapMode == "power":
    Fref = max(params.spring.stiffness * params.spring.maxElasticLength, 1e-9)
    u = clamp(mag / Fref, 0, 1)
    g = pow(u, max(0.05, params.rotation.responseGamma))
    return clamp(sign * maxRad * g, -maxRad, maxRad)
  else:
    return clamp(params.rotation.forceToAngle * mag * sign, -maxRad, maxRad)
```

---

## 11. 参考链接汇总（实现与 review 用）

| 类型 | URL |
|------|-----|
| 本仓库绳模型 | `docs/elastic-rope-traction-card-model.md` |
| 本仓库运动核 | `src/motion/ElasticRopeMotion.ts` |
| Art of Damping 文 | https://www.alexisbacot.com/blog/the-art-of-damping |
| Art of Damping 代码 | https://github.com/AlexisBacot/ArtOfDamping |
| react-spring config | https://www.react-spring.dev/docs/advanced/config |
| react-spring 参数讨论 | https://github.com/pmndrs/react-spring/issues/799 |
| Fix Your Timestep | https://gafferongames.com/post/fix_your_timestep/ |
| Game Math dynamics | https://gamemath.com/book/dynamics.html |
| Unity angularDrag | https://docs.unity3d.com/2021.3/Documentation/ScriptReference/Rigidbody-angularDrag.html |
| TTS angular_drag | https://github.com/Berserk-Games/Tabletop-Simulator-API/blob/master/docs/object.md |
| 旋转 spring gist | https://gist.github.com/SpawnCampGames/c069cb7bb3954b36f559bc1a9fec880d |
| 拖拽+angularDrag gist | https://gist.github.com/bf63404dbaf8e8c5ae19822ab6a862ec |
| 二阶系统 PDF | https://faculty.uml.edu/pavitabile/dynsys.uml.edu/tutorials/2nd_Order_Systems/second_order_theory_011805.pdf |
| 卡牌拖拽倾角讨论 | https://gamedev.stackexchange.com/questions/137265/how-to-make-card-movement-behave-like-those-in-hearthstone-and-eternal-ccg |

---

## 12. 明确不在范围内（禁止顺手做）

- 接入主手牌拖拽  
- 角二次阻力、干摩擦  
- soft-knee 以外的曲线编辑器  
- 完整 3D 牌面倾斜（mouse3DTilt）混入绳旋转  
- 引入 npm 物理/动画库  
- 修改平移弹簧/空气阻力公式  

---

**定稿声明：** 执行 AI 若遇本文未覆盖的分支，应 **停下来询问**，不得自行发明第四种 dynamics 或改用 \(F_y\) 力矩。
