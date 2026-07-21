# CMOS 屏幕震动统一管线 — AI 可执行完整方案（定稿）

> **状态：** 定稿，供实现执行（禁止自我发挥）  
> **时间节点：** 2026-07-21  
> **选型代号：** 组合 **α-CMOS**（`shakeRoot` + 三轴 MSMD + 速度冲量 + 命名预设 + ControlPanel 试射）  
> **命名：** CMOS 相机传感器悬挂摇晃模型（平移 Δx/Δy + 旋转 θ，弹簧阻尼回正）  
> **前置：**  
> - 本仓库 `src/motion/SpringDamper1D.ts`  
> - 本仓库 `docs/play-pile-settle-spring-damper-plan.md` §2（MSMD 公式与积分）  
> - 本仓库 `docs/elastic-rope-rotation-damping-plan.md` §2.4（ωn/ζ 标定）  
> - 本仓库 `ARCHITECTURE.md`（`fx/` / `motion/` / `App.onUpdate` 分层）

---

## 0. 执行约束（给 AI，必须逐条遵守）

1. **只实现本文写明的选型与公式**，禁止改用：
   - 主路径 Trauma + Perlin/Simplex 噪声驱动位移（Eiserloh 范式仅作对照，**不得**作默认动力学）
   - 缓动曲线 `Tween` / Easing 驱动 `x/y/rotation` 作主震动
   - 外部 npm 动画/震动库运行时依赖：`screen-shake`、`wobble`、`framer-motion`、`gsap`、`pixi-game-camera` 等
   - 每帧 `Math.random()` 写位置
   - 直接改写 `App.worldRoot.position` / `worldRoot.rotation`（与 `Scaler.apply` 抢 transform）
   - Verlet / RK4 / 完整 2D 刚体 / 四元数
   - 把震动逻辑塞进 `ElasticRopeMotion` 或 `TweenManager`
2. **允许对照、禁止复制依赖的开源：** 下列仓库/文章仅作公式、API 形状、参数心智对照；实现必须自写 TypeScript，可抄公式与函数结构，**不得** `npm install` 这些包作为震动依赖。
3. **每个实现步骤**必须同时满足：理论依据 → 具体实现 → 参考依据；禁止未引用的「经验改法」。
4. **通道：** 三轴独立 `SpringDamper1D`：`offsetX`、`offsetY`、`rotation`（弧度）；目标恒为 `0`。
5. **激励：** 仅通过 **速度冲量** `v += impulse`（位置不瞬时跳变，除 `hardReset`）。
6. **输出：** 只写 `shakeRoot.x / shakeRoot.y / shakeRoot.rotation`；禁止写业务卡牌布局坐标。
7. **倍速：** 积分使用与 `TweenManager` 同源的 `App.onUpdate(dtMS)`；`dtSec = min(dtMS/1000, maxDtSec)` 再分子步。是否乘 `gameSpeed`：默认 **不乘**（震动用墙钟感帧时间，与「hitstop 仍可感到冲击」的常见 juice 一致）；若未来统一缩时，仅允许通过 CONFIG 开关 `cmosShake.useGameSpeed`（默认 `false`）。
8. **配置：** 全部挂在 `CONFIG.cmosShake`（见 §6）；调试面板只绑定这些字段 + 动作型 key。

---

## 1. 定稿技术选型一览（禁止替换）

| 模块 | 定稿方案 | 禁止方案 |
|------|----------|----------|
| 场景挂载 | `worldRoot` 下新增 `shakeRoot`（label=`ShakeRoot`）；玩法内容挂 `shakeRoot` | 抖 `worldRoot`；抖 `stage`；后处理 UV 主路径 |
| 动力学 | 三轴 MSMD，`SpringDamper1D` | Trauma 衰减作唯一状态；一阶 lerp 作默认 |
| 标定 | `mass, angularFreq(ωn), dampingRatio(ζ)`；\(k=m\omega_n^2,\;c=2\zeta m \omega_n\) | 只暴露 raw k,c；tension/friction 唯一 API |
| 积分 | 半隐式欧拉 + `maxDtSec` + `substeps`（调用现有 `SpringDamper1D.step`） | 无 cap 单步大 dt；自写另一套积分 |
| 激励 | `impulse` 加在 `v` 上；可叠加 | 位置 teleport；互斥重置状态（默认） |
| 自由度 | x,y,θ；轴独立 | 默认 scale 震动；旋转无夹持 |
| 夹持 | 积分后 `clamp` 位置与角 | 无上限 |
| API | `CmosScreenShake` 纯核 + `ScreenShakeFx` PIXI 适配 | 业务直接 `container.x = …` |
| 预设 | 命名 preset + 可选覆盖字段 | 业务每次填全套物理量 |
| 无障碍 | `intensity ∈ [0,1]` 乘在冲量与输出上 | 无全局关闭 |
| 噪声层 | **本阶段不做** | 并行上线 Perlin 层 |

---

## 2. 理论依据与符号（实现必须逐字遵守）

### 2.1 物理叙事（CMOS / IBIS 类比）

机身受冲击时，**图像传感器相对机身**出现小位移与微旋转，悬挂系统（弹簧+阻尼）将其拉回光学中心。游戏侧将「整桌画面」视作传感器平面：状态 \((\Delta x,\Delta y,\theta)\) 受冲量获得速度，再向 \((0,0,0)\) 回正。

这与「Trauma 标量 × 噪声采样」是不同模型：后者是 **有机连续抖动**（GDC Eiserloh）；本方案是 **冲量驱动的欠阻尼/近临界悬挂**。

### 2.2 运动方程（每轴独立）

对任一轴状态 \(x\)、速度 \(v\)、目标 \(x^*=0\)：

\[
m\ddot{x} = -k x - c v,\quad
k = m\omega_n^2,\quad
c = 2\zeta m \omega_n
\]

半隐式欧拉子步（与 `SpringDamper1D` 一致）：

\[
a = (-k(x-x^*)-c v)/m,\quad
v \leftarrow v + a\cdot h,\quad
x \leftarrow x + v\cdot h
\]

**理论依据：**

- 标准二阶有阻尼谐振子；\(\zeta<1\) 欠阻尼（过冲回正，CMOS「晃一下」）、\(\zeta=1\) 临界、\(\zeta>1\) 过阻尼。
- 冲量：瞬时 \(v \leftarrow v + J/m\)（本方案将「冲量强度」直接定义为加在 `v` 上的增量，取 \(m\) 已含在标定中，见 §2.4）。

**参考依据：**

| 来源 | 用途 |
|------|------|
| 本仓库 `SpringDamper1D.ts` + `docs/play-pile-settle-spring-damper-plan.md` §2 | **必须调用的积分器与公式** |
| [Ryan Juckett — Damped Springs](https://www.ryanjuckett.com/damped-springs/) | ωn/ζ 参数化、帧率无关动机 |
| [Daniel Holden — Spring-It-On](https://theorangeduck.com/page/spring-roll-call) | spring-damper 分类；禁止采用文中标记为 bad 的阻尼写法 |
| [Toqoz — Spring-based Animation](https://toqoz.fyi/springs.html) + [SpringTransform.cs](https://github.com/Toqozz/blog-code/blob/master/spring_transforms/Assets/SpringTransform.cs) | **各 transform 分量独立弹簧** 的工程先例 |
| gasgiant [Camera-Shake](https://github.com/gasgiant/Camera-Shake) 的 **Kick** 语义 | 冲击型震动对照（非 Perlin 主路径） |
| Eiserloh GDC [Juicing Your Cameras](https://www.youtube.com/watch?v=tu-Qe66AvtY) + [PDF](http://www.mathforgameprogrammers.com/gdc2016/GDC2016_Eiserloh_Squirrel_JuicingYourCameras.pdf) | **2D 旋转有效**、max roll 心智；**不采用** trauma×noise 主方程 |
| sajmoni [screen-shake](https://github.com/sajmoni/screen-shake) | **仅 API 形状对照**：`update → {angle, offsetX, offsetY}`；**禁止**其 Perlin+trauma 实现与 npm 依赖 |
| KidsCanCode [Screen Shake recipe](https://kidscancode.org/godot_recipes/4.x/2d/screen_shake/index.html) | `max_roll` 角夹持命名与量级心智 |
| Xbox Accessibility Guideline 117 | 必须提供关闭/减弱相机震动 |

### 2.3 输出合成（每帧）

```
outX = clamp(sx.x, -maxOffsetX, maxOffsetX) * intensity
outY = clamp(sy.x, -maxOffsetY, maxOffsetY) * intensity
outR = clamp(sr.x, -maxAngleRad, maxAngleRad) * intensity
```

其中 `sx/sy/sr` 为三轴 `SpringDamper1D` 的位置状态。  
`intensity` 来自 `CONFIG.cmosShake.intensity`（0=完全关闭输出与冲量）。

**注意：** 冲量入口也乘 `intensity`，保证 0 时状态不被累积（无障碍「关震动」语义）。

### 2.4 冲量定义（禁止歧义）

```ts
// 单位：世界像素/秒（平移），弧度/秒（旋转）
impulseX: number  // 加到 sx.v
impulseY: number  // 加到 sy.v
impulseRot: number // 加到 sr.v
```

公开方法：

```ts
impulse(args: {
  // 二选一：显式三分量，或 极坐标方向+强度+spin
  x?: number; y?: number; rot?: number;
  angleDeg?: number; // 0–360°：0=+X 右，90=+Y 下（PIXI y-down）
  radius?: number;   // 方向半径（绝对值 ≥0）；≈0 时回退默认向下
  strength?: number; // 映射到平移速度冲量模长
  spin?: number;     // 直接作为 impulseRot（再乘 intensity）
}): void
```

映射规则（定稿）：

1. 若提供 `x|y|rot` 任一：`vx += (x??0)*I`，`vy += (y??0)*I`，`ω += (rot??0)*I`，其中 `I = intensity`。
2. 否则用极坐标方向模式：  
   - `angleDeg` 默认 90（向下），`radius` 默认 1。  
   - 若 `radius > 1e-6`：`ux=cos(θ)`, `uy=sin(θ)`（θ 由 angleDeg 转弧度）；否则 `ux=0, uy=1`（默认「向下顿一下」）。  
   - `speed = (strength ?? 0) * strengthToVelocity`（`strengthToVelocity` 来自 CONFIG，单位 px/s per strength）。  
   - `vx += ux * speed * I`，`vy += uy * speed * I`，`ω += (spin ?? 0) * spinToVelocity * I`。
3. **禁止**在 impulse 时改写 `sx.x`（位置阶跃）；与 play-pile 文档中「可选速度冲量」一致，本方案速度冲量为默认且唯一激励。  
4. 预设字段：`dirAngleDeg` / `dirRadius`；`dirRandom` 时在 `[dirAngleMin, dirAngleMax]` 采样角度，半径固定。

### 2.5 叠加语义

多次 `impulse`：**速度累加**（弹簧自然响应）。  
**参考：** Godot 社区 [Additive 2D Camera Shake](https://forum.godotengine.org/t/additive-2d-camera-shake-for-overlapping-shakes-in-rapid-succession/108424)（连击叠加）；trauma 系用 `min(1, trauma+Δ)`（sajmoni `add`），本方案用速度域叠加替代。

**连击防护（定稿必做）：**

- CONFIG：`maxSpeedXY`、`maxSpeedRot`：冲量后若 `|v|` 超限则 clamp（防止 score tick 风暴数值爆炸）。  
- 可选：`minImpulseIntervalMS` 默认 `0`（关闭）；调试面板可调；`>0` 时距上次成功冲量不足则 **缩放** 本次 strength（乘 `0.35`），不丢弃（保留手感）。

---

## 3. 场景图与挂载（精确步骤）

### 3.1 目标结构

```
stage
└── worldRoot          ← Scaler 只写 scale + position（居中 letterbox）
    └── shakeRoot      ← 仅本系统写 x,y,rotation；pivot = 世界中心
        ├── Background? / 或保持现状分层
        ├── cardLayer
        ├── hud
        └── …
```

**定稿策略（整桌晃，实现简单且符合「CMOS 整幅画面」）：**

- `GameController`（及 elastic-rope 沙盒若需要一致）中，**原先 `app.worldRoot.addChild(...)` 的玩法节点，改为 `shakeRoot.addChild(...)`**。  
- `BackgroundView` 若挂在 stage 空间（CRT 注释称 stage-space），**保持不挂 shakeRoot**（避免与 CRT 双重策略冲突）；若当前 background 在 worldRoot，则随 shakeRoot 一起晃——**以代码现状为准**：  
  - 读取 `GameController` 构造：`cardLayer`、`hud` 在 `worldRoot` → 迁入 `shakeRoot`。  
  - `BackgroundView` / CRT：若文档/代码标明 stage 空间，**不要**塞进 shakeRoot。

**参考依据：**

- PixiJS Container 父子变换：[Scene Objects](https://pixijs.com/8.x/guides/components/scene-objects)  
- 父节点 rotation/position 影响子树：Pixi 场景图语义  
- **禁止**改 `worldRoot.position`：本仓库 `Scaler.apply` 每帧/resize 写 `root.position` 与 `root.scale`（`src/core/Scaler.ts`）

### 3.2 pivot（旋转中心）— 必须正确

虚拟分辨率中心：

```ts
const cx = CONFIG.world.width / 2;   // 默认 640
const cy = CONFIG.world.height / 2;  // 默认 360
shakeRoot.pivot.set(cx, cy);
shakeRoot.position.set(cx, cy); // 静止时：pivot 钉在父空间 (cx,cy)，子内容世界坐标不变
// 震动时：
shakeRoot.position.set(cx + outX, cy + outY);
shakeRoot.rotation = outR;
```

**理论 / 工程依据：**

- Pixi：`pivot` 是旋转中心；`position` 是 pivot 在父空间的投影（[Container 文档](https://pixijs.download/dev/docs/scene.Container.html)）。  
- 社区陷阱：只设 `rotation` 不设 pivot → 绕左上角转（[html5gamedevs pivot](https://www.html5gamedevs.com/topic/44639-making-a-container-rotate-around-its-center/)、[SO pivot affects position](https://stackoverflow.com/questions/17505169/pixi-js-pivot-affects-object-position)）。  
- **静止恒等条件：** `position === pivot`（在父=worldRoot 且 world 原点布局约定下）时，子节点本地坐标与直接挂 worldRoot 时一致。子内容仍使用 **左上角为原点的世界坐标**（现有 HandLayout 等不变）。

### 3.3 `ScreenShakeFx` 职责

| 方法 | 行为 |
|------|------|
| `constructor(app)` / `attach(app)` | 创建 `shakeRoot`，插入为 `worldRoot` 子节点；提供 `get root()` |
| `reparentExisting?` | 由 `GameController` 在创建层时直接 `shakeRoot.addChild`，避免运行中 reparent 坐标错误 |
| `update(dtMS)` | `model.step(dtSec)` → 写 position/rotation |
| `dispose` | 取消 `onUpdate`；不 destroy 业务子节点 |

`App.onUpdate` 注册与 `GameController` 的 tween 更新 **同级**；顺序建议：先业务/tween，再 shake 写 transform（或先 shake 再业务——**定稿：在 GameController 的 update 末尾调用 `screenShakeFx.update(dtMS)`**，与 tween 同一回调内，保证单帧一致）。

---

## 4. 代码落点与公开 API（禁止另起炉灶）

### 4.1 新建文件

| 路径 | 职责 | PIXI |
|------|------|------|
| `src/motion/CmosScreenShake.ts` | 三轴弹簧、impulse、play(preset)、intensity、clamp、selfTest | **禁止 import pixi** |
| `src/fx/ScreenShakeFx.ts` | shakeRoot、pivot、onUpdate 写回、持有 `CmosScreenShake` | 允许 pixi |
| `docs/cmos-screen-shake-plan.md` | 本文 | — |

### 4.2 修改文件（最小集）

| 路径 | 改动 |
|------|------|
| `src/game/config.ts` | 增加 `cmosShake` 默认值与类型 |
| `src/game/GameController.ts` | 创建 `ScreenShakeFx`；子节点挂 `shakeRoot`；update 步进；可选出牌触发 `play` |
| `src/debug/ControlPanel.ts` | §8 面板字段 + 试射按钮 |
| `src/debug/control-panel.css` | 若需按钮样式，对齐现有 |
| `ARCHITECTURE.md` | 一行表项：`motion/CmosScreenShake` + `fx/ScreenShakeFx` |
| `src/scenes/ElasticRopeSandboxScene.ts` | **可选**：同样挂 shakeRoot 以便沙盒试震动；若改动面大可仅主场景，但面板试射需 `main.ts` 持有 fx 引用 |

**main.ts：** `setupControlPanel` 需能触发试射 → 通过模块级/导出的 `getScreenShakeFx()` 或把 fx 挂在 `game` 上由 onChange 调用（与现有 `action:toggleMode` 模式一致）。

### 4.3 `CmosScreenShake` 必须公开的方法

```ts
export type CmosShakePresetId =
  | "tap" | "scoreTick" | "playHand" | "bigHand" | "error";

export class CmosScreenShake {
  readonly x: SpringDamper1D;
  readonly y: SpringDamper1D;
  readonly rot: SpringDamper1D;

  /** 从 CONFIG.cmosShake 读参积分；target 恒 0 */
  step(dtSec: number): void;

  /** §2.4 */
  impulse(args: ImpulseArgs): void;

  /** 查表 preset + 可选覆盖 strength/spin/dir */
  play(id: CmosShakePresetId, override?: Partial<PresetOverride>): void;

  /** 读 CONFIG 或内部缓存 */
  setIntensity(v: number): void;
  getIntensity(): number;

  /** 位置与速度清零 */
  hardReset(): void;

  /** 当前输出（未写 PIXI 前） */
  getOutput(): { x: number; y: number; rotation: number };

  isSettled(): boolean;
}

export function __cmosScreenShakeSelfTest(): string[];
```

`step` **必须**调用：

```ts
this.x.step(dtSec, 0, paramsXY, maxDtSec, substeps);
this.y.step(dtSec, 0, paramsXY, maxDtSec, substeps);
this.rot.step(dtSec, 0, paramsRot, maxDtSec, substeps);
// 然后对 this.x.x / this.y.x / this.rot.x 做 maxOffset / maxAngle 夹持
// 夹持策略定稿：若 |x| > max，则 x = sign*max 且 v *= 0.5（软墙，避免贴边震颤）
```

**参考：** 软墙速度衰减在物理引擎边界处理中常见；此处参数 `0.5` 固定写死在代码常量 `CLAMP_VEL_SCALE = 0.5`，不进面板（减少旋钮）。

### 4.4 `play` 预设表与扩展模式

全部在 `CONFIG.cmosShake.presets`；数值单位见 §6。

#### 预设字段（`CmosShakeEffectPreset`）

| 字段 | 用途 |
|------|------|
| `mode` | `impulse` 单次 · `pulse` 定时脉冲串 · `oscillate` 衰减正弦驱动弹簧目标 |
| `strength` / `spin` / `dirAngleDeg` / `dirRadius` | 速度冲量（impulse/pulse；oscillate 可选起振；方向用极坐标） |
| `posKick` / `angleKickDeg` | 位置/角位移踢（px / 度），瞬间加到弹簧状态 |
| `count` / `intervalMS` / `alternate` / `falloff` | **pulse**：次数、间隔、每拍翻转方向、每拍衰减 |
| `durationMS` / `freqHz` / `amp` / `ampRotDeg` / `decay` / `phaseDeg` | **oscillate**：时长、频率、平移/旋转振幅、指数包络、初相 |

**不得**在 play 里改全局 ωn/ζ（物理手感只通过全局 dynamics 或面板改）。  
新 play 会清空未完成的 pulse 排程与 oscillate 驱动；弹簧状态保留以便连打叠加。

#### 内置 id（节选）

| id | mode | 说明 |
|----|------|------|
| `tap` / `scoreTick` / `playHand` | impulse | 轻反馈 / 计分 / 出牌 |
| `bigHand` / `error` / `thud` | impulse | 大牌 / 横向错误 / 偏位置踢顿挫 |
| `swayLR` / `bounceUD` / `doubleKick` | pulse+alternate | 左右平移 / 上下来回 / 双重冲击 |
| `swayAngle` / `rumble` | oscillate | 左右摆角 / 持续微抖 |

旧档仅含 strength/spin/dir 时，`mergeCmosShakePresets` / `normalizeCmosShakeEffectPreset` 自动补全缺省字段。

### 4.5 业务接入（第一阶段最小）

| 时机 | 调用 | 依据 |
|------|------|------|
| 出牌成功进入得分演出 | `play('playHand')` | juice：冲击反馈 |
| 调试面板 | §8 按钮 | 必做 |
| 计分逐票 | **第一阶段不接** `scoreTick`（防连打马达）；面板可测 | 社区：高频 shake=振动（indie 开发者拆 shake/hitstop） |

后续迭代再接 `scoreTick` 时必须启用 `minImpulseIntervalMS ≥ 40` 或降 strength。

---

## 5. 与对照仓库的「用什么、不用什么」

| 仓库/资料 | 允许采用 | 禁止采用 |
|-----------|----------|----------|
| 本仓库 `SpringDamper1D` | **直接 import 与 step 签名** | 复制粘贴第二套积分 |
| [sajmoni/screen-shake](https://github.com/sajmoni/screen-shake) | 返回值形状 `{angle,offsetX,offsetY}`；`maxAngle/maxOffset` 命名 | `createNoise2D`、trauma\*\*2、差分返回 delta（其 update 返回的是相对上一帧的 delta，易与绝对写 position 混用——**本方案输出绝对偏移**） |
| [johanhelsing/bevy_trauma_shake](https://github.com/johanhelsing/bevy_trauma_shake) | `amplitude/decay/trauma_power` 仅作对照 | TraumaPlugin、噪声 octaves |
| [Andrewp2/bevy_camera_shake](https://github.com/Andrewp2/bevy_camera_shake) | trauma 系统对照 | 依赖 Bevy |
| [gasgiant/Camera-Shake](https://github.com/gasgiant/Camera-Shake) | **Kick** 理念；Presets 一键 | 默认 Perlin/Bounce 替换弹簧 |
| [filipbasara/trauma-gd](https://github.com/filipbasara/trauma-gd) | `shake(profile)` / 命名资源 | Godot 节点树 |
| KidsCanCode recipe | `max_roll` → 本方案 `maxAngleRad` | OpenSimplex 采样位移 |
| [andersonaddo/EZ-Camera-Shake-Unity](https://github.com/andersonaddo/EZ-Camera-Shake-Unity) | `ShakeOnce` 心智 → `play(id)` | fadeIn/fadeOut 包络主路径 |
| [Sleitnick/RbxCameraShaker](https://github.com/Sleitnick/RbxCameraShaker) | 同上 | Roblox API |

**绝对写 position 依据：** Pixi 每帧设置 `container.x/y/rotation` 为世界层偏移是标准做法；sajmoni 返回 delta 是为了兼容「累加到相机」的写法，本项目 `shakeRoot` **每帧覆盖**为 `cx+outX`，必须用 **绝对** 输出，禁止套用其 delta 语义。

---

## 6. CONFIG 结构（必须原样增加）

在 `src/game/config.ts` 的 `GameConfig` / `DEFAULT` 中增加：

```ts
cmosShake: {
  enabled: boolean;           // false 时 step 仍可跑但 impulse 与输出强制 0
  intensity: number;          // 0..1
  useGameSpeed: boolean;      // 默认 false

  // 平移通道（x,y 共享）
  mass: number;               // 默认 1
  angularFreq: number;        // ωn rad/s，默认 18
  dampingRatio: number;       // ζ，默认 0.62

  // 旋转通道
  rotMass: number;            // 默认 1
  rotAngularFreq: number;     // 默认 22
  rotDampingRatio: number;    // 默认 0.72

  maxOffsetX: number;         // px，默认 14
  maxOffsetY: number;         // px，默认 14
  maxAngleDeg: number;        // 度，默认 1.2（内部转 rad）

  strengthToVelocity: number; // strength=1 → px/s，默认 900
  spinToVelocity: number;     // spin=1 → rad/s，默认 8

  maxSpeedXY: number;         // px/s，默认 2400
  maxSpeedRot: number;        // rad/s，默认 20
  minImpulseIntervalMS: number; // 默认 0

  maxDtSec: number;           // 默认 0.05（与绳/弹簧文档同量级）
  substeps: number;           // 默认 4

  settlePosPx: number;        // 默认 0.15
  settleVelPx: number;        // 默认 2
  settleAngleRad: number;     // 默认 0.0005
  settleAngVel: number;       // 默认 0.01

  presets: {
    tap: { strength: number; spin: number; dirAngleDeg: number; dirRadius: number };
    scoreTick: { ... };
    playHand: { ... };
    bigHand: { ... };
    error: { ... };
  };
}
```

默认 presets 数值见 §4.4。  
`loadSavedConfig` / shipping 合并逻辑与现有 CONFIG 一致（缺字段用 DEFAULT）。

---

## 7. 帧循环（精确）

```ts
// GameController 已有 onUpdate 路径内：
const dtMS = ...; // 与 tween.update 相同来源
if (CONFIG.cmosShake.enabled) {
  let dtSec = dtMS / 1000;
  if (CONFIG.cmosShake.useGameSpeed) {
    // 仅当开关 true：与 scaleTimeMS 对偶——此处时间缩放为 dtSec *= gameSpeed
    // 注意 scaleTimeMS 是 duration/gameSpeed；积分 dt 乘 gameSpeed 表示「逻辑加速时震更快完」
    dtSec *= CONFIG.gameSpeed; // 字段名以 config 现有 gameSpeed 为准
  }
  this.screenShake.model.step(dtSec);
  this.screenShake.applyToRoot(); // 写 pivot 系 position/rotation
} else {
  this.screenShake.model.hardReset();
  this.screenShake.applyToRoot(); // 回中
}
```

**参考：** 本仓库弹簧方案要求与 `App` ticker 同源；Gaffer on Games 固定步长思想通过 `maxDtSec+substeps` 近似（与 `SpringDamper1D` 注释一致）。

---

## 8. 调试面板（必须实现 · 含快捷试射）

### 8.1 分组 UI

在 `ControlPanel` 增加分组 **「CMOS 屏幕震动」**（折叠，默认展开一次便于验收），绑定方式对齐 `elasticRopeCard` 的 `bindNumber` / `bindToggle` / 动作 key。

### 8.2 必须暴露的参数（全部可实时生效）

| UI 控件 | CONFIG 路径 | 范围建议 |
|---------|-------------|----------|
| 启用 | `cmosShake.enabled` | bool |
| 全局强度 | `cmosShake.intensity` | 0–1 step 0.01 |
| 使用 gameSpeed | `cmosShake.useGameSpeed` | bool |
| 平移 ωn | `cmosShake.angularFreq` | 4–40 |
| 平移 ζ | `cmosShake.dampingRatio` | 0.2–1.5 |
| 旋转 ωn | `cmosShake.rotAngularFreq` | 4–40 |
| 旋转 ζ | `cmosShake.rotDampingRatio` | 0.2–1.5 |
| maxOffsetX/Y | `cmosShake.maxOffsetX/Y` | 0–40 |
| maxAngleDeg | `cmosShake.maxAngleDeg` | 0–5 |
| strength→速度 | `cmosShake.strengthToVelocity` | 100–3000 |
| spin→角速度 | `cmosShake.spinToVelocity` | 0–20 |
| maxSpeedXY / maxSpeedRot | 对应字段 | — |
| minImpulseIntervalMS | 对应字段 | 0–200 |
| maxDtSec / substeps | 对应字段 | 同弹性绳 |
| 质量 mass / rotMass | 对应字段 | 0.2–5（高级，可放折叠「高级」） |

**预设覆盖（可选折叠）：** 五个 preset 的 strength/spin 数字框（路径 `cmosShake.presets.playHand.strength` 等）。

### 8.3 快捷试射（必须 · 动作型 key）

与 `action:toggleMode` 相同模式：`onChange` 识别下列 key，**不写 CONFIG 持久化字段**，只触发运行时：

| 按钮文案 | action key | 调用 |
|----------|------------|------|
| 试射 tap | `action:cmosShake:tap` | `play('tap')` |
| 试射 scoreTick | `action:cmosShake:scoreTick` | `play('scoreTick')` |
| 试射 playHand | `action:cmosShake:playHand` | `play('playHand')` |
| 试射 bigHand | `action:cmosShake:bigHand` | `play('bigHand')` |
| 试射 error | `action:cmosShake:error` | `play('error')` |
| 连射×5 score | `action:cmosShake:burstScore` | 连续 5 次 `play('scoreTick')` 间隔 50ms（`setTimeout` 或累积） |
| 自定义冲量 | `action:cmosShake:custom` | 读面板临时字段 `debugCmosDirX/Y/Strength/Spin`（可挂 `CONFIG.cmosShake.debugImpulse` 不进 shipping） |
| 硬复位 | `action:cmosShake:reset` | `hardReset()` + apply |

**main.ts onChange：**

```ts
if (key.startsWith("action:cmosShake:")) {
  game?.handleCmosShakeAction(key); // 或 screenShakeFx 引用
  return;
}
```

沙盒无 game 时：`ScreenShakeFx` 应在 `main` 层对主场景与沙盒都可访问；**定稿：fx 挂在 GameController；弹性绳沙盒若无 fx，则试射按钮 no-op 并 `console.warn`**——主验收路径为默认主场景。

### 8.4 面板只读反馈（建议）

- 一行文本：`settled: yes/no`、当前 `|v_xy|`、当前 offset（从 `getOutput()` 读）——可用 10Hz 定时刷新或 onUpdate 节流，避免每帧打 DOM；若实现成本高可第二阶段再做。  
- **第一阶段最小：试射按钮 + 全部动力学滑条 + reset。**

---

## 9. 实现任务分解（AI 执行顺序）

### Step 1 — 纯核 `CmosScreenShake.ts`

1. Import `SpringDamper1D`、`SpringDamper1DParams`。  
2. 实现 §2–§4 API。  
3. `__cmosScreenShakeSelfTest`：  
   - 给定冲量后 `ζ=1` 若干秒应接近 0；  
   - `ζ=0.4` 应出现符号变化的过冲（位置曾背离再回）；  
   - `intensity=0` 时 impulse 后状态保持 0。  
4. DEV 下可在 `main` 或模块底调用 selfTest（对齐 elastic-rope）。

**验收：** 无 PIXI；selfTest 无 error。

### Step 2 — CONFIG

写入默认值 §6；确保 `loadSavedConfig` 深合并不抹掉 presets。

### Step 3 — `ScreenShakeFx.ts`

1. 创建 `shakeRoot`，`label = "ShakeRoot"`。  
2. `worldRoot.addChild(shakeRoot)`（注意：先加 shakeRoot，再把业务层加到 shakeRoot）。  
3. pivot/position 初始化 §3.2。  
4. `applyToRoot()` 写 transform。

### Step 4 — GameController 接线

1. 构造 fx；`cardLayer`/`hud` 等改为 `shakeRoot.addChild`。  
2. update 调 step+apply。  
3. 出牌路径一处 `play('playHand')`（找到现有 play 成功点，**仅一处**，禁止散落）。  
4. `handleCmosShakeAction`。

### Step 5 — ControlPanel

§8 全部绑定 + 试射按钮。

### Step 6 — 文档

`ARCHITECTURE.md` 表增加两行。

### Step 7 — 手动验收清单

- [ ] 静止时布局与改前一致（牌位置、HUD）  
- [ ] resize 后仍居中，震动中心仍在屏中  
- [ ] 试射 bigHand 有位移+微旋并回正  
- [ ] intensity=0 试射无可见震动  
- [ ] 连射×5 不 NaN、不飞出  
- [ ] Hierarchy 可见 `ShakeRoot`  
- [ ] 不改 `worldRoot` 的 x/y/rotation（Scaler 后仍正确）

---

## 10. 技术陷阱与社群/检索补强（执行时必须规避）

| # | 陷阱 | 现象 | 定稿规避 | 依据 |
|---|------|------|----------|------|
| T1 | Scaler 与 shake 抢 `worldRoot` | resize 后偏移错乱、震动被覆盖 | 只抖 `shakeRoot` | `Scaler.ts` 写 `root.position/scale` |
| T2 | 绕左上角旋转 | 整桌划大弧 | pivot=世界中心 + position=中心+offset | Pixi pivot 文档；html5gamedevs 讨论 |
| T3 | 误用 sajmoni **delta** 输出 | 偏移积分漂移 | **绝对** out 每帧覆盖 position | sajmoni 源码 `angle - previous` |
| T4 | 大 dt 弹簧爆炸 | 掉帧后飞出 | `maxDtSec`+`substeps` 走 SpringDamper1D | 本仓库弹簧文档；Juckett |
| T5 | 连击马达 | 计分震动变噪声 | 首阶段不接每票 score；`maxSpeed*`；可选 interval | MindGate 类「高频 shake」讨论；Godot additive 帖 |
| T6 | 无障碍缺失 | 晕动投诉 | `intensity`+`enabled` | [Xbox AAG 117](https://learn.microsoft.com/en-us/xbox/accessibility/xbox-accessibility-guidelines/117)；多家游戏设置项实践 |
| T7 | 角过大 | 文字难读 | `maxAngleDeg` 默认 1.2° | KidsCanCode `max_roll` 小量级；Eiserloh 旋转要克制 |
| T8 | 夹持硬贴边震颤 | 边缘嗡嗡 | 夹持时 `v *= 0.5` | 边界软约束常见做法 |
| T9 | Hierarchy reparent | 拖拽节点破坏 shake 树 | 文档注明 ShakeRoot 勿拆；调试 reparent 需保持子树 | 本仓库 HierarchyView reparent |
| T10 | CRT/stage 背景不同步 | 背景不晃或双重 | 背景是否进 shakeRoot 按 §3.1 现状分支 | `CrtFilter` 注释 stage-space |
| T11 | 输入坐标 | 若未来用全局坐标点选 | 震动中 pointer 与视觉偏差；本项目卡牌用本地交互，**第一阶段接受**与视觉一致的偏差 | Pixi 变换链 |
| T12 | NaN 污染 | 坏参数后永久坏 | SpringDamper1D 已有 non-finite 复位；impulse 前 `Number.isFinite` 检查 | SpringDamper1D.ts |
| T13 | 双 rAF | 与暂停/倍速脱节 | 只用 App.onUpdate | play-pile 方案 §0/§8 |
| T14 | npm 塞噪声库 | 与仓库纪律冲突 | 禁止 | ARCHITECTURE 自研 motion |

### 10.1 检索补充资料（优化用，非第二实现）

| 主题 | URL |
|------|-----|
| 弹簧参数化 | https://www.ryanjuckett.com/damped-springs/ |
| Spring 工程综述 | https://theorangeduck.com/page/spring-roll-call |
| 分量独立弹簧 | https://toqoz.fyi/springs.html |
| Eiserloh 相机 | https://www.youtube.com/watch?v=tu-Qe66AvtY |
| TS API 形状 | https://github.com/sajmoni/screen-shake |
| Kick 多算法 | https://github.com/gasgiant/Camera-Shake |
| Bevy trauma | https://github.com/johanhelsing/bevy_trauma_shake |
| Bevy 上游 | https://github.com/Andrewp2/bevy_camera_shake |
| Godot 配方 | https://kidscancode.org/godot_recipes/4.x/2d/screen_shake/ |
| 叠加 shake | https://forum.godotengine.org/t/additive-2d-camera-shake-for-overlapping-shakes-in-rapid-succession/108424 |
| 无障碍 | https://learn.microsoft.com/en-us/xbox/accessibility/xbox-accessibility-guidelines/117 |
| Pixi pivot | https://pixijs.com/8.x/guides/components/scene-objects |
| EZ Camera API | https://github.com/andersonaddo/EZ-Camera-Shake-Unity |
| 爆炸向现实感讨论 | https://gamedev.stackexchange.com/questions/1828/realistic-camera-screen-shake-from-explosion |

---

## 11. 明确不在本方案范围

- Perlin/OpenSimplex 噪声层（可另开「γ 混合」文档）  
- 只抖牌桌不抖 HUD 的分层 shakeRoot（可后续 `shakeContentRoot` vs `hudRoot`）  
- 基于爆炸点的空间衰减场（可用 `impulse` 方向模拟，不单独立项）  
- 与音效/粒子绑定的自动 juice 总线  
- npm 安装任何 shake 库  

---

## 12. 验收定义（Done）

1. 代码符合 §0 禁止项检查清单（PR/自检打勾）。  
2. selfTest 通过。  
3. 面板五项试射 + reset 可用。  
4. `playHand` 在真实出牌中触发一次可感微震。  
5. `intensity=0` 完全静止。  
6. resize 后布局正确。  
7. 无新增运行时 npm 依赖。  

---

## 13. 给执行 AI 的最小伪代码（禁止偏离）

```ts
// CmosScreenShake.step
const pXY = { mass: cfg.mass, angularFreq: cfg.angularFreq, dampingRatio: cfg.dampingRatio };
const pR  = { mass: cfg.rotMass, angularFreq: cfg.rotAngularFreq, dampingRatio: cfg.rotDampingRatio };
this.x.step(dtSec, 0, pXY, cfg.maxDtSec, cfg.substeps);
this.y.step(dtSec, 0, pXY, cfg.maxDtSec, cfg.substeps);
this.rot.step(dtSec, 0, pR, cfg.maxDtSec, cfg.substeps);
softClamp(this.x, cfg.maxOffsetX);
softClamp(this.y, cfg.maxOffsetY);
softClamp(this.rot, degToRad(cfg.maxAngleDeg));

// ScreenShakeFx.applyToRoot
const { x, y, rotation } = this.model.getOutput(); // 已含 intensity
const cx = worldW/2, cy = worldH/2;
this.shakeRoot.pivot.set(cx, cy);
this.shakeRoot.position.set(cx + x, cy + y);
this.shakeRoot.rotation = rotation;
```

---

**文档结束。实现时以本文为唯一规格；若与口头讨论冲突，以本文为准。**
