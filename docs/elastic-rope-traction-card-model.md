# 弹性绳子牵引卡牌模型 — AI 可执行完整方案（推荐栈定稿）

> **状态：** 审核后定稿，供实现执行  
> **时间节点：** 2026-07-14  
> **范围：** 隔离沙盒 + 运动核 + 参数面板；**不**接入手牌主路径  

> **执行约束（给 AI）**  
> 1. **只实现本文写明的选型与公式**，禁止改用 Verlet 多段绳、p2/Matter、Tween 驱动位置、或继续用 `updateDragging` 的 lerp 作为本沙盒移动后端。  
> 2. **不得改动手牌主路径行为**：`GameController` 默认启动逻辑、`CardView.updateDragging` 的 lerp/急停过冲、现有 `dragHandCard`/`cardOvershoot`/`cardMoveRotation` 在主游戏中的语义保持不变。  
> 3. 每个实现步骤下方均有：**理论依据 → 具体实现 → 参考依据**。  
> 4. 参数面板字段以 §7 清单为**必须公开**集合；未列入者本阶段禁止加「发挥型」参数。

---

## 0. 定稿技术选型一览（禁止替换）

| 模块 | 定稿方案 | 禁止方案 |
|------|----------|----------|
| 运动核 | 独立 TS 类 `ElasticRopeMotion`（无 PIXI） | 嵌满 `CardView`；TweenManager 驱动 |
| 弹力 | \(F_s = k \cdot L_e\)，\(L_e=\min(D,L_{\max})\) | 无 cap 的无限 Hooke；仅 lerp |
| 阻力 | 默认线性 \(F_d=-c\mathbf{v}\)；可选二次 | 仅 maxSpeed 硬切 |
| 力作用点 | 平移力作用在**质心** \(C\) | 默认用连接点积分平移 |
| 绳几何 | 解析共线两段：弹性 + 刚性延伸 | 多段 Verlet 绳 / Box2D rope |
| 积分 | 半隐式欧拉 + `dt` clamp + 可选 substeps | 无 cap 的可变超大 dt；RK4 |
| 吸附 | \(D<d_s\) **且** \(\|v\|<v_s\) | 仅距离；永不吸附 |
| 目标 | `setTarget`；按下跟指针；松手**冻结指针世界坐标** | 松手回开局位；松手后仍跟鼠标 |
| 锚点 | 固定本地 Y；X 映射到 \([x_{min},x_{max}]\) | 完整 2D 按压点作锚 |
| 旋转 | \(\theta=\mathrm{clamp}(\alpha\cdot\|F_{s,x}\|\cdot\mathrm{sign},\,\pm\theta_{max})\)（仅水平弹力） | 速度倾斜 `cardMoveRotation` 叠用；用完整 \(\|F_s\|\) |
| 视图 | `positionDriver: "external"` 写 x/y/rotation | 双写 lerp+rope |
| 入口 | `?scene=elastic-rope` 与 `GameController` 互斥 | 叠在主局内 |
| 面板 | 顶级分类「弹性绳子牵引卡牌模型」 | 塞进 dragHandCard 同组混调 |

---

## 1. 物理与算法规范（实现必须逐字遵守）

### 1.1 符号

| 符号 | 含义 | 单位 |
|------|------|------|
| \(C=(x,y)\) | 卡牌容器位姿原点（与现 `CardView.x/y` 一致，牌心） | px |
| \(v=(v_x,v_y)\) | 速度 | px/s |
| \(T=(t_x,t_y)\) | 目标点（静态体，不被绳拉动） | px |
| \(m\) | 质量 | 无量纲质量（与 k、c 配套） |
| \(k\) | 弹簧刚度 | 力/长度 |
| \(c\) | 线性阻力系数 | 力/(px/s) |
| \(c_2\) | 二次阻力系数 | 力/(px/s)² |
| \(L_{\max}\) | 弹性绳最大长度 | px |
| \(D=\|T-C\|\) | 中心到目标距离 | px |

### 1.2 绳段几何（共线、不弯曲）

**理论：** 单轴拉伸弹簧 + 超长时用「饱和弹力 + 几何延伸段」描述，而非软体多段约束（多段 Verlet 会产生弯曲，与需求冲突）。

\[
\begin{aligned}
L_e &= \min(D,\, L_{\max}) \\
L_r &= \max(0,\, D - L_{\max}) \\
\hat u &= \begin{cases} (T-C)/D & D > \varepsilon_D \\ 0 & \text{otherwise} \end{cases}
\end{aligned}
\]

- 弹性段：从 \(C\) 沿 \(\hat u\) 长度 \(L_e\)
- 刚性段：从弹性远端到 \(T\)，长度 \(L_r\)（**不产生额外力**）

**参考：**

- 需求规格：弹性上限 + 延伸刚性无限长 + 永远直线
- 多段绳反例（实现时**不要**采用其弯曲模型）：https://github.com/code4fukui/physics-rope
- 溢出/橡皮筋非线性仅作边界灵感，**不作主平移模型**：https://gist.github.com/originell/6961057

### 1.3 力

\[
\begin{aligned}
\mathbf F_s &= k \cdot L_e \cdot \hat u \\
\mathbf F_d &= \begin{cases}
-c\,\mathbf v & \text{mode=linear} \\
-c_2 \|\mathbf v\|\,\mathbf v & \text{mode=quadratic}
\end{cases} \\
\mathbf a &= (\mathbf F_s + \mathbf F_d)/m
\end{aligned}
\]

**终端速度（线性模式、力饱和时，只读估算用）：**

当阻力为 \(-c v\) 且力平衡 \(k L_{\max} = c V\) 时：

\[
V_{\mathrm{term}} \approx \frac{k \cdot L_{\max}}{c}
\]

（与质量 \(m\) 无关；面板只读字段按此显示。）

**参考：**

- Hooke 定律 + 粘滞阻尼二阶系统：经典质点弹簧（过冲来自惯性）
- 参数心智（tension≈刚度、friction≈阻尼、mass）：https://www.react-spring.dev/docs/advanced/config
- 配置讨论：https://github.com/pmndrs/react-spring/issues/799

**禁止**把 react-spring 的 duration 模式混进本积分器。

### 1.4 半隐式欧拉积分

每个子步（`dt` 秒）：

```
a = F(x, v) / m
v = v + a * dt
x = x + v * dt
```

**理论依据：** 半隐式（symplectic）欧拉先更新速度再更新位置，比显式欧拉更稳，是实时弹簧/UI 物理常用选择。

**参考：**

- https://www.npmjs.com/package/@zakkster/lite-spring（标注 Semi-implicit Euler）
- https://www.npmjs.com/package/@downpourdigital/physics（EulerSpring = semi-implicit）

### 1.5 时间步保护

```
dtSec = clamp(dtMS / 1000, 0, maxDtSec)   // 默认 maxDtSec = 1/30
for i in 1..substeps:
  step(dtSec / substeps)
```

**理论依据：** 切后台/卡顿导致超大 `dt` 会使弹簧爆炸；Gaffer「Fix Your Timestep」指出过大帧时间需 **clamp**，否则可能 spiral of death。本项目用 **clamp 单帧物理时间** + 有限 substeps，不采用无限追帧。

**参考：**

- https://gafferongames.com/post/fix_your_timestep/
- 可见性恢复：现有 `App.handleVisibility` 会 `forceSceneRebuild`（`src/core/App.ts`），物理侧仍必须 cap `dt`。

### 1.6 Settle 吸附

当 `D < settleDistancePx` **且** `hypot(vx,vy) < settleSpeedPxPerSec`：

```
x,y = tx,ty
vx,vy = 0
θ = 0（或目标角 0）
```

**理论依据：** 二阶欠阻尼系统在平衡点附近会长时间微振；工程上用误差带 + 速度阈值结束仿真。**仅距离**会在高速掠过时误吸附。

**参考：**

- 二阶系统 settling / overshoot 工程实践
- react-spring `precision`/`clamp` 同类语义：https://www.react-spring.dev/docs/advanced/config

### 1.7 旋转（准静态目标角 + 可选二阶阻尼；与速度无关；仅水平弹力）

锚点本地：`p_local = (anchorLocalX, anchorY)`（锚点映射见 §1.8）。  
力仅用弹力的**水平分量** \(F_{s,x}\)（**不含** \(F_{s,y}\)、**不含** \(\mathbf F_d\)）。  
意图：左右拖动产生倾角；纯上下拖动不扭转卡牌。

```
// 仅水平力：等价 cross = p × (Fs.x, 0) = -p_local.y * Fs.x
// 用未旋转本地锚点算力矩符号（默认 rotationAffectsAnchor=false）
signTorque = sign(-p_local.y * Fs.x)
// |cross| < 1e-6 或 |Fs.x|≈0 时：thetaTarget = 0
mag = |Fs.x|
// mapMode=linear：
thetaTarget = clamp(forceToAngle * mag * signTorque, -maxAngleRad, maxAngleRad)
// mapMode=power：u = mag/(k*Lmax)；thetaTarget = sign * maxRad * u^gamma
```

动力学模式 `dynamics`（见 **`docs/elastic-rope-rotation-damping-plan.md`** 定稿）：

| 模式 | 行为 |
|------|------|
| `instant` | \(\theta=\theta^*\)，\(\omega=0\) |
| `follow` | 一阶 `angleFollow`（帧末一次） |
| `springDamper`（默认） | 子步内 \(I\dot\omega=k_\theta(\theta^*-\theta)-c_\theta\omega\)，\(k_\theta=I\omega_n^2\)，\(c_\theta=2\zeta I\omega_n\) |

一阶跟随（仅 `follow`，`angleFollow` ∈ (0,1]，按 16.67ms 帧校正）：

```
alpha = 1 - Math.pow(1 - angleFollow, dtMS/16.667)
theta += (thetaTarget - theta) * alpha
```

`angleFollow=1` 或 `0` 表示立即贴目标角。  
**禁止** `follow` 与 `springDamper` 串联。settle 时 \(\theta=\omega=0\)。

**禁止**在本沙盒启用 `CONFIG.cardMoveRotation` 对该牌写 velocityRotation（与需求「旋转与速度无关」冲突）。现有速度旋转说明见 `src/game/config.ts` 中 `cardMoveRotation` 注释与 `CardView` 内 `updateMoveRotation`。

### 1.8 锚点映射

卡牌逻辑尺寸以 `CardSkin` 为准：`width: 100`, `height: 140`（`src/render/CardSkin.ts`）。  
`CardView` 坐标系：与现实现一致——实现前必须 read `CardView` 构造里的 pivot/position 约定，与 `getLocalPosition` 一致（`onPointerDown` 用法见 `src/render/CardView.ts`）。

**按下时采样一次并锁定到 pointerup：**

```
local = event.getLocalPosition(cardView)
// 本地坐标：若 CardView 以中心为 pivot，local.x∈[-W/2,W/2]；若以左上为原点则先减 W/2,H/2。

anchorLocalY = CONFIG.elasticRopeCard.anchor.anchorY   // 固定，忽略按压 Y
// continuous 模式：
t = clamp( (localX - (-W/2)) / W , 0, 1 )
anchorLocalX = lerp(anchorXMin, anchorXMax, t)
// leftRightHalf 模式：
anchorLocalX = localX < 0 ? anchorXMin : anchorXMax   // 若中心为 0；否则以 W/2 分界
```

默认 `anchorMapMode: "continuous"`。

---

## 2. 仓库落点与文件清单（AI 必须创建/修改的路径）

### 2.1 新建

| 路径 | 职责 |
|------|------|
| `src/motion/ElasticRopeTypes.ts` | 类型、`ElasticRopeParams` 从 CONFIG 读取的形状 |
| `src/motion/ElasticRopeMotion.ts` | 状态 + `reset/setTarget/setAnchorLocal/step/isSettled/getDebug` |
| `src/motion/ElasticRopeDebugDraw.ts` | PIXI `Graphics` 画弹性段/刚性段/锚点（可依赖 PIXI） |
| `src/scenes/ElasticRopeSandboxScene.ts` | 单卡场景、输入、与 App ticker 连接、销毁 |

### 2.2 修改（最小面）

| 路径 | 改动 |
|------|------|
| `src/main.ts` | 解析 `URLSearchParams`：`scene=elastic-rope` → 沙盒，否则 `GameController` |
| `src/render/CardView.ts` | 增加 `positionDriver: "internal" \| "external"`（默认 `"internal"`）；`external` 时 `updateDragging` **不写** `this.x/y`，仍更新 `dragTarget*`、缩放、`isDragging` |
| `src/game/config.ts` | `RuntimeConfig.elasticRopeCard` + DEFAULT + clone/merge |
| `src/debug/ControlPanel.ts` + 面板 HTML（与现面板同文件/同注入方式） | 新顶级分类绑定 |
| `public/presets/shipping.json` | 写入默认 `elasticRopeCard` 字段，避免 merge 空洞 |

### 2.3 禁止修改的行为

- `CardView.updateDragging` 的 lerp/`cardOvershoot` 急停逻辑在 `positionDriver==="internal"` 时**语义不变**
- 不删除、不改名现有 `dragHandCard` 配置
- 不把沙盒逻辑写进 `GameController.start()` 主路径

### 2.4 现有技术栈锚点（必须复用）

| 能力 | 现成位置 | 用法 |
|------|----------|------|
| App / ticker | `src/core/App.ts` | `app.onUpdate(dt)` 驱动 `motion.step` |
| 配置 | `src/game/config.ts` 的 `CONFIG` / `DEFAULT_CONFIG` | 每帧读 CONFIG，与项目原则一致 |
| 面板绑定 | `src/debug/ControlPanel.ts` 的 `bindNumber` / `bindToggle` / `bindSectionExpand` | 同 `dragHandCard` 绑定模式 |
| 卡牌视图 | `src/render/CardView.ts` | 构造一张牌；指针流程已有 stage `eventMode="static"` + pointerupoutside |
| 卡牌尺寸 | `src/render/CardSkin.ts` | W=100 H=140 |
| 资源 | `src/core/AssetManager.ts` `assets.loadAll()` | 沙盒同样预加载后建 `CardView` |
| 层级 | `src/core/Layers.ts` | 卡牌 zIndex 可用较高值 |

---

## 3. `ElasticRopeMotion` API（精确契约）

```ts
// 伪代码契约——AI 实现时方法名与语义必须一致

class ElasticRopeMotion {
  reset(pose: { x: number; y: number; rotation?: number }): void
  setTarget(x: number, y: number): void
  setAnchorLocal(x: number, y: number): void
  /** 每帧从 CONFIG.elasticRopeCard 拉取数值，或接受显式 params */
  step(dtMS: number, params: ElasticRopeParams): ElasticRopeStepResult
  isSettled(params: ElasticRopeParams): boolean
  getDebug(): {
    D: number; Le: number; Lr: number;
    FsMag: number; speed: number; terminalSpeedApprox: number;
    C: {x: number; y: number}; T: {x: number; y: number};
    elasticEnd: {x: number; y: number}; anchorWorld: {x: number; y: number}
  }
}

type ElasticRopeStepResult = {
  x: number; y: number; rotation: number // rotation 弧度
}
```

`step` 内顺序（强制）：

1. 读 params，clamp dt，substeps
2. 每子步：算 \(D,\hat u,L_e,L_r,\mathbf F_s,\mathbf F_d,\mathbf a\) → 半隐式欧拉
3. 全步结束后：settle 判定
4. 算 `rotation`（用 \(\mathbf F_s\)，非阻力）
5. 返回 pose；更新 debug 缓存

---

## 4. `CardView` external 驱动（精确行为）

### 4.1 新增字段

```ts
/** 默认 "internal"。沙盒设为 "external"。 */
positionDriver: "internal" | "external" = "internal"
```

### 4.2 `updateDragging` 分支

当 `positionDriver === "external"`：

- **仍允许在 pointer 路径：** 更新 `dragTargetX/Y`、`isDragging`、dragScale、阴影逻辑
- **禁止执行：** 朝 `dragTarget` 的 lerp 步进、`cardOvershoot` 急停 rise/spring 写 x/y

当 `positionDriver === "internal"`：保持现有 `updateDragging` 全文行为。

### 4.3 旋转冲突

沙盒在创建牌后：

- **实现规定：** `positionDriver === "external"` 时跳过 `updateMoveRotation` 中对 `velocityRotation` 的应用（或整段 early return）。

依据：现 `CardView` 已在拖拽路径注释位姿由外部/拖拽写；`ARCHITECTURE.md` 写 CardView 不持有 target 自驱——与 external 一致。

### 4.4 指针与坐标系

**复用**现有：

- `onPointerDown` 里 stage `eventMode = "static"`、监听 `pointermove/up/upoutside`（防松手丢失）
- 目标点：父容器本地坐标 = `event.getLocalPosition(parent)`（与现 `dragTarget` 一致）

**松手：**

```
motion.setTarget(lastPointerParentX, lastPointerParentY) // 冻结
// 不要 setTarget(初始位)
// isDragging=false 走现有缩放 out；位置继续 step 直到 settle
```

**参考（PIXI 事件）：**

- https://pixijs.com/8.x/guides/components/events（`pointerupoutside`、`eventMode`）
- 项目内已解决拖出 hit 区：勿再发明全局 window 监听，优先复用 stage 方案

---

## 5. 沙盒场景装配（`ElasticRopeSandboxScene`）

### 5.1 启动条件

`main.ts`：

```
const scene = new URLSearchParams(location.search).get("scene")
if (scene === "elastic-rope") {
  // 仍 loadShipping + loadSavedConfig + App.init + assets.loadAll
  const sandbox = new ElasticRopeSandboxScene(app)
  sandbox.start()
} else {
  const game = new GameController(app)
  game.start()
}
// setupControlPanel 两者都装，便于调 elasticRopeCard
```

### 5.2 场景内容

1. 可选：不挂完整 HUD；背景**优先纯色** `CONFIG.world.backgroundColor`，减少依赖。
2. `new CardView(cardData, callbacks)`：`onDragStart/End` 可空或只打日志；**不要**绑 `GameController` 归位。
3. `card.positionDriver = "external"`
4. 居中：`x = worldWidth/2`, `y = worldHeight/2`（`CONFIG.world.width/height`）
5. `motion.reset({x,y,rotation:0})`
6. `app.onUpdate((dtMS) => { ... })`：
   - 若 dragging：`motion.setTarget(pointerParentX, pointerParentY)`
   - `const r = motion.step(dtMS, readParamsFromCONFIG())`
   - `card.x=r.x; card.y=r.y; card.rotation=r.rotation`
   - debug draw 更新
7. `destroy()`：取消 onUpdate、销毁 card/graphics

### 5.3 验收用例（自测清单）

| # | 操作 | 期望 |
|---|------|------|
| 1 | 打开 `?scene=elastic-rope` | 单卡居中，无手牌/HUD 按钮依赖 |
| 2 | 慢拖 | 牌滞后，绳主要为弹性段 |
| 3 | 极快甩远 | \(L_r>0\)，速度接近只读 \(V_{term}\) 量级，不无限加速 |
| 4 | 松手 | T 冻结；牌继续运动后 settle；**不回**开局坐标 |
| 5 | 抓左 vs 抓右 | 旋转符号或幅度可区分 |
| 6 | 无 query 启动 | 原 `GameController` 手感不变 |

---

## 6. CONFIG 结构（必须写入 `RuntimeConfig`）

```ts
elasticRopeCard: {
  // 总控
  enabled: boolean              // 沙盒 motion 是否 step；默认 true
  // 弹簧
  spring: {
    maxElasticLength: number    // L_max px
    stiffness: number           // k
  }
  // 阻力
  airDrag: {
    mode: "linear" | "quadratic"
    linearCoeff: number         // c
    quadraticCoeff: number      // c2
  }
  // 质量与积分
  integration: {
    mass: number
    maxDtSec: number            // 默认 1/30
    substeps: number            // 整数 ≥1，默认 1 或 2
  }
  // 吸附
  settle: {
    distancePx: number
    speedPxPerSec: number
  }
  // 旋转
  rotation: {
    enabled: boolean
    forceToAngle: number        // rad per force unit
    maxAngleDeg: number
    angleFollow: number         // 0..1，1=立即
    rotationAffectsAnchor: boolean // 默认 false
  }
  // 锚点
  anchor: {
    anchorY: number             // 本地 px，相对中心
    anchorXMin: number
    anchorXMax: number
    mapMode: "continuous" | "leftRightHalf"
  }
  // 调试与沙盒
  debug: {
    drawRope: boolean
    drawAnchor: boolean
    showHudReadouts: boolean    // D,Le,Lr,speed,Vterm 文本可选
    elasticColor: number        // 0xRRGGBB
    rigidColor: number
  }
  sandbox: {
    followPointerWhileDown: boolean  // 默认 true
    freezeTargetOnRelease: boolean   // 默认 true
  }
  // 面板折叠
  expandedSections: {
    spring: boolean
    airDrag: boolean
    integration: boolean
    settle: boolean
    rotation: boolean
    anchor: boolean
    debug: boolean
  }
}
```

### 6.1 推荐默认初值

| 字段 | 建议初值 | 依据 |
|------|----------|------|
| `maxElasticLength` | `120` | 约 1 张牌宽量级（CardSkin 100） |
| `stiffness` | `80`～`120` | 需实机拧；从偏软起 |
| `airDrag.mode` | `"linear"` | 终端速度可解释 |
| `linearCoeff` | `8`～`15` | 使 \(V_{term}=k L_{max}/c\) 约 800～1500 px/s 量级 |
| `mass` | `1` | 与 k、c 标定简单 |
| `maxDtSec` | `1/30` | Gaffer 式保护，常用 30Hz 下限 |
| `substeps` | `2` | 硬弹簧时更稳 |
| `settle.distancePx` | `2`～`4` | 亚像素可见噪声带 |
| `settle.speedPxPerSec` | `20`～`40` | 防抖 |
| `forceToAngle` | 按标定公式 | 见下 |
| `maxAngleDeg` | `18`～`25` | 卡牌不翻面 |
| `angleFollow` | `0.35` | 略平滑 |
| `anchorY` | `-40`～`-50` | 中上部 |
| `anchorXMin/Max` | `-25` / `25` | 半宽内小区间 |
| `mapMode` | `"continuous"` | — |

**`forceToAngle` 标定（最大弹力时角接近 maxAngle）：**

\[
\text{forceToAngle} \approx \frac{\theta_{max}}{k \cdot L_{max}}
\]

---

## 7. 调试面板：必须公开的参数（完整清单）

**顶级分类标题（中文）：** `弹性绳子牵引卡牌模型`  
**实现方式：** 与现面板一致——`bindSectionExpand` + `bindNumber`/`bindToggle`/`bindCycleButton`（mode），路径字符串 `elasticRopeCard.*`。

### 专区 A — 弹簧

| UI | CONFIG 路径 | 控件 |
|----|-------------|------|
| 弹性绳最大长度 | `elasticRopeCard.spring.maxElasticLength` | number |
| 刚度 k | `elasticRopeCard.spring.stiffness` | number |

### 专区 B — 空气阻力

| UI | 路径 | 控件 |
|----|------|------|
| 阻力模式 | `elasticRopeCard.airDrag.mode` | cycle linear/quadratic |
| 线性系数 c | `elasticRopeCard.airDrag.linearCoeff` | number |
| 二次系数 c2 | `elasticRopeCard.airDrag.quadraticCoeff` | number |
| 终端速度估算（只读） | 计算 `k*Lmax/c`（linear） | 文本 val，**非**写入 CONFIG |

### 专区 C — 质量与积分

| UI | 路径 |
|----|------|
| 质量 m | `elasticRopeCard.integration.mass` |
| 最大 dt（秒） | `elasticRopeCard.integration.maxDtSec` |
| 子步数 | `elasticRopeCard.integration.substeps` integer |

### 专区 D — 吸附

| UI | 路径 |
|----|------|
| 吸附距离 | `elasticRopeCard.settle.distancePx` |
| 吸附速度 | `elasticRopeCard.settle.speedPxPerSec` |

### 专区 E — 旋转

| UI | 路径 |
|----|------|
| 启用旋转 | `elasticRopeCard.rotation.enabled` |
| 力到角系数 | `elasticRopeCard.rotation.forceToAngle` |
| 最大角（度） | `elasticRopeCard.rotation.maxAngleDeg` |
| 角跟随 | `elasticRopeCard.rotation.angleFollow` |
| 旋转影响锚点 | `elasticRopeCard.rotation.rotationAffectsAnchor` |

### 专区 F — 连接点

| UI | 路径 |
|----|------|
| 锚点 Y | `elasticRopeCard.anchor.anchorY` |
| 锚点 X 最小 | `elasticRopeCard.anchor.anchorXMin` |
| 锚点 X 最大 | `elasticRopeCard.anchor.anchorXMax` |
| 映射模式 | `elasticRopeCard.anchor.mapMode` |

### 专区 G — 调试与沙盒

| UI | 路径 |
|----|------|
| 绘制绳 | `elasticRopeCard.debug.drawRope` |
| 绘制锚点 | `elasticRopeCard.debug.drawAnchor` |
| 显示读数 | `elasticRopeCard.debug.showHudReadouts` |
| 按下跟手 | `elasticRopeCard.sandbox.followPointerWhileDown` |
| 松手冻结目标 | `elasticRopeCard.sandbox.freezeTargetOnRelease` |
| 总开关 enabled | `elasticRopeCard.enabled` |

**明确不要放进本分类（仍用旧分类）：**  
`dragHandCard.dragScale*`、`dragShadow.*`、`cardShadow.*`、hover/3D tilt——抓起视效继续读旧配置。

**merge/clone：** 按 `config.ts` 现有对嵌套对象的 deep merge 模式为 `elasticRopeCard` 增加分支。

---

## 8. 分步执行计划（按序实现）

### Step 1 — CONFIG + 面板骨架

1. 在 `RuntimeConfig` 增加 `elasticRopeCard` 全字段与 `DEFAULT_CONFIG` 初值。
2. `cloneConfig` / `merge` / `loadSavedConfig` 路径完整。
3. ControlPanel 顶级分类 + §7 全部 bind。
4. 更新 `shipping.json`。

**完成标准：** typecheck 通过；面板改值写入 `CONFIG`；主游戏无功能变化。

### Step 2 — `ElasticRopeMotion` 纯逻辑

1. 实现 §1 公式与 §3 API。
2. **建议**最小断言（若项目无测试框架，可用 dev 自检函数）：
   - \(D=0\) → Fs=0
   - \(D>L_{max}\) → Fs 模长 = \(k L_{max}\)
   - 线性饱和平衡：给 \(v = (k L_{max}/c) \hat u\) 时 \(|F_s+F_d|\) 接近 0
   - settle 条件触发后速度为 0

**参考实现风格：** lite-spring 的 Euler 步进；**不要**复制其 React API。

### Step 3 — CardView `positionDriver`

1. 默认 `internal`。
2. `external` 跳过位置 lerp/急停写坐标与 velocity 旋转应用。
3. 主场景不设置 external → 回归手牌拖拽。

### Step 4 — Sandbox 场景 + main 分支

1. `ElasticRopeSandboxScene`
2. `?scene=elastic-rope`
3. 指针 → setTarget；松手冻结

### Step 5 — DebugDraw + 读数

1. 弹性/刚性双色线段
2. 锚点标记
3. 可选 HTML 或 PIXI Text 显示 D/Le/Lr/speed/Vterm

### Step 6 — 标定与文档

1. 按 \(V_{term}\) 与 maxAngle 公式拧默认值
2. 在 `ARCHITECTURE.md` 增加一小节「elastic rope motion（沙盒）」入口说明

---

## 9. 坑与技术陷阱（检索结论 + 方案内对策）

| # | 陷阱 | 现象 | 依据/讨论 | 本方案强制对策 |
|---|------|------|-----------|----------------|
| 1 | **超大 dt** | 弹簧爆炸、飞出屏幕 | Gaffer Fix Your Timestep；spiral of death | `maxDtSec` clamp；有限 substeps；**禁止**无限追帧 |
| 2 | **刚度过大 + 单步** | 数值爆炸 | 半隐式欧拉对硬弹簧仍要足够小 h | 默认 substeps≥2；面板可增；文档提示降 k |
| 3 | **settle 只用距离** | 高速掠过被粘住或中心抖动 | 二阶系统过冲；settling 需误差带 | **距离∧速度**双阈值 |
| 4 | **欠阻尼长期微振** | 永不静止 | 弹簧-阻尼系统 | settle 硬吸附；可略增 c |
| 5 | **forceToAngle 与 k 不同步** | 角永远顶满或几乎不转 | \(F_{max}=k L_{max}\) | 面板同时暴露；初值用 \(\theta_{max}/(k L_{max})\) |
| 6 | **双旋转通道** | 牌疯转 | 本仓 `cardMoveRotation` + 新角 | external 禁用 velocity 旋转 |
| 7 | **双位置写入** | 抖、抢写 | 本仓 tween 互斥；drag 与 layout | external 唯一写 x/y；沙盒不调 `CardFx.moveTo` |
| 8 | **松手丢 pointer** | 卡拖拽态 | 本仓已用 stage static + upoutside | 复用 CardView 现有指针安装；勿删 |
| 9 | **PIXI 拖出对象丢事件** | 官方/社区 dragging 问题 | pixi events 文档 | stage 级 move/up；hitArea=screen（现码已有模式） |
| 10 | **坐标系混用** | 目标飞到错误位置 | global vs parent local | 全程 **parent 本地** 与现 dragTarget 一致 |
| 11 | **锚点随 θ 耦合** | 旋转正反馈抖动 | 偏心受力几何 | 默认 `rotationAffectsAnchor=false` |
| 12 | **二次阻力低速发粘/高速过钝** | 手感两极 | 空气阻力模型差异 | 默认 linear；quadratic 可选 |
| 13 | **localStorage 旧 preset 缺字段** | undefined 读崩溃 | 本仓 CONFIG merge 默认 | merge 时用 DEFAULT 填 `elasticRopeCard` |
| 14 | **Verlet/软绳误用** | 绳弯曲、性能差 | physics-rope 等多段实现 | **禁止**；仅解析直线 |
| 15 | **把 duration 弹簧当力积分** | 无终端速度语义 | react-spring duration 模式 | 只用 mass/k/c 积分；不用 duration |
| 16 | **可见性切回一帧大 dt** | 闪现 | App visibility rebuild + 物理 | clamp dt |
| 17 | **调试绳画在旋转后错误点** | 线不贴牌 | 变换顺序 | debug 用 step 输出的 C 与 T 画父空间线段 |
| 18 | **shipping 未含新字段** | 团队环境不一致 | 项目 shipping 预设流程 | 同步 `public/presets/shipping.json` |

### 9.1 补充检索资料

| 主题 | URL |
|------|-----|
| 固定时间步 / clamp | https://gafferongames.com/post/fix_your_timestep/ |
| react-spring config | https://www.react-spring.dev/docs/advanced/config |
| react-spring 物理时长误解 | https://github.com/pmndrs/react-spring/issues/799 |
| semi-implicit 微库 | https://www.npmjs.com/package/@zakkster/lite-spring |
| EulerSpring/RK4 | https://www.npmjs.com/package/@downpourdigital/physics |
| Apple 橡皮筋公式（仅边界灵感） | https://gist.github.com/originell/6961057 |
| 多段绳反例 | https://github.com/code4fukui/physics-rope |
| Motion dragElastic（边界弹性 API 对照） | https://motion.dev/docs/react-drag |
| PIXI 事件 | https://pixijs.com/8.x/guides/components/events |
| 本仓拖拽实现 | `src/render/CardView.ts` `updateDragging` / pointer stage |
| 本仓配置模式 | `src/game/config.ts`、`src/debug/ControlPanel.ts` |
| 本仓架构约束 | `ARCHITECTURE.md` |

---

## 10. 明确不在本期范围（禁止顺手做）

- 手牌 / 发牌 / 弃牌 / 出牌接入新模型
- 替换全局 `dragHandCard` lerp
- 路径点队列 `route[]`（可在类型里留 TODO 注释，不实现）
- 多卡、换位、阴影/缩放参数迁移
- 引入 npm 物理引擎依赖

---

## 11. 完成定义（DoD）

1. `npm run typecheck`（或项目 `tsc --noEmit`）通过。
2. `/?scene=elastic-rope`：单卡可拖、松手不归开局位、绳 debug 可选。
3. 无 query 启动：主游戏拖拽/归位与改前一致。
4. 面板「弹性绳子牵引卡牌模型」下 §7 全部参数可调且立即影响沙盒。
5. `ElasticRopeMotion` 无 `import` 自 `pixi.js`。
6. 代码注释中公式与本文 §1 一致，并引用 Gaffer / Hooke 饱和 / settle 双阈值之一句说明。

---

## 12. 给执行 AI 的最短指令摘要

```
实现「弹性绳子牵引」沙盒，严格按推荐栈：
- src/motion/ElasticRopeMotion.ts：Fs=k*min(D,Lmax)*û，Fd=-c*v（可二次），
  半隐式欧拉，dt clamp，D∧|v| settle，旋转=clamp(α*|Fs|*sign)。
- 绳几何共线两段；禁止 Verlet 多段绳。
- CardView.positionDriver='external' 时不跑 lerp/急停写坐标、不跑 velocity 旋转。
- main：?scene=elastic-rope → ElasticRopeSandboxScene，否则 GameController。
- CONFIG.elasticRopeCard + 面板顶级分类全字段（见方案 §6–§7）。
- 视效（dragScale/shadow）继续旧 CONFIG；松手冻结指针目标。
- 参考：Gaffer timestep、react-spring mass/tension/friction 心智、
  lite-spring Euler、本仓 CardView stage 拖拽与 CONFIG 面板模式。
```

---

## 13. 相关讨论沉淀（检索摘要）

### 13.1 效果语义（产品层）

卡牌像挂在「可拉长的橡皮筋 + 必要时无限延伸的直硬绳」上被目标拖着走：近有弹性与惯性过冲，远有匀速极限，抓点决定歪斜，到位后稳稳吸住。与现手牌 `lerp + maxSpeed + 速度旋转` 隔离。

### 13.2 开源对照（借鉴边界）

| 开源/文档 | 可借鉴 | 勿整包照搬 |
|-----------|--------|------------|
| react-spring mass/tension/friction | 参数心智 | 无 \(L_{\max}\) 刚性延伸 |
| lite-spring / semi-implicit Euler | `step(dt)` 积分 | 仅 1D spring |
| Motion `dragElastic` | 边界阻力语义 | 约束拖拽，非自由目标绳 |
| Apple rubber-band 公式 / PullUpView | 溢出曲线灵感 | 滚动轴 |
| physics-rope Verlet | 积分稳定参考 | **弯曲绳**违背共线需求 |
| 现项目 `updateDragging` | 隔离对象 / 指针模式 | lerp 模型 |

---

**本文为唯一执行规格；与本文冲突的「更优发挥」一律不采纳。**
