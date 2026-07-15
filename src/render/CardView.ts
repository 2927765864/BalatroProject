import {
  Container,
  Graphics,
  Sprite,
  Text,
  Texture,
  FederatedPointerEvent,
  PerspectiveMesh,
  Rectangle,
  type ContainerChild,
} from "pixi.js";
import type { CardData } from "@domain/types";
import { assets } from "@core/AssetManager";
import { deferDestroyTexture } from "@core/DeferredTextureDestroy";
import { CONFIG, isDrawingCards, scaleTimeMS } from "@game/config";
import { sampleCurve } from "@/debug/BezierCurveEditor";
import { uiHierarchy } from "@ui/hierarchy";
import { ElasticRopeMotion } from "@/motion/ElasticRopeMotion";
import {
  defaultElasticRopeAnchorLocal,
  mapElasticRopeAnchorLocal,
  readElasticRopeParams,
} from "@/motion/elasticRopeUtils";
import { CardSkin } from "./CardSkin";
import { getPixelOutlineTexture } from "./PixelOutlineTexture";

/**
 * 计算卡牌移动旋转的派生上限（弧度，无符号）。
 *   maxRot = (REF_SPEED / 1000) × cardMoveRotation.rotationPerSpeed
 *
 * 主场景位移已由弹性绳驱动；此处参考速度为常量（旧 dragHandCard.maxSpeed 默认 3000），
 * 仅供 legacy velocity-rotation（positionDriver=internal）派生 maxRot。
 */
export function computeMaxRot(card?: CardView): number {
  void card;
  const refSpeedPxPerSec = 3000;
  const speedPerMs = refSpeedPxPerSec / 1000;
  const cfg = CONFIG.cardMoveRotation;
  const k = (isDrawingCards && cfg?.drawRotationPerSpeed !== undefined) ? cfg.drawRotationPerSpeed : (cfg?.rotationPerSpeed ?? 0);
  return Math.abs(speedPerMs * k);
}

/**
 * 手牌的四种核心状态
 */
export enum CardState {
  Normal = "normal",       // 常态：没有任何特殊情况的状态
  Hovered = "hovered",     // 被触碰态：鼠标在卡牌上游走，无点击/拖拽
  Dragging = "dragging",   // 拖拽态：只要鼠标处于按下状态，即进入拖拽态
  Selected = "selected",   // 点击选中态：在时间阈值内快速抬起鼠标左键进入
}

/**
 * 卡牌角色：
 *   - hand  ：普通手牌（可选中、拖拽、出牌/弃牌/理牌）
 *   - joker ：小丑牌（复用手牌视效 + 拖拽排序/选中弹起；禁用出牌/弃牌/点数花色理牌）
 */
export type CardRole = "hand" | "joker";

/**
 * 小丑牌可复用的手牌视效专区 key。
 * 与 CONFIG.joker.effects 字段一一对应。
 */
export type JokerReusableFx =
  | "shadow"
  | "breathing"
  | "idleTilt"
  | "hoverHit"
  | "hoverScale"
  | "hoverBreathing"
  | "mouse3DTilt";

export interface CardViewOptions {
  /** 默认 "hand"。 */
  role?: CardRole;
  /**
   * 小丑图集 row-major 索引（仅 role="joker" 时有效）。
   * 0 = 左上角第一张。
   */
  jokerIndex?: number;
}

/**
 * 卡牌视图
 *
 * 一个 CardView 持有一份 CardData（只读），负责把它画出来并响应交互。
 * 视图的可变状态只剩"是否选中"和"目标位姿"，由外部 controller 设置。
 *
 * 渲染策略（优先级从高到低）：
 *   1. CONFIG.cardArt.useSprites && AssetManager 已就绪 → 直接用 8BitDeck 切出来的 Sprite。
 *   2. 否则回退到 Graphics + Text 程序化绘制（与原型一致），便于素材未加载时也能看到牌。
 *
 * 设计要点：
 *   - 位移由内嵌 ElasticRopeMotion 驱动：流程层 setMoveTarget，本类 update 中 step。
 *   - 拖拽只更新 dragTarget；缩放/阴影/hover 等视效仍在本类内部。
 *   - hover / click 通过回调向上抛出，不与 GameState 直接耦合。
 */
export interface CardViewCallbacks {
  onClick: (view: CardView) => void;
  onHoverIn: (view: CardView) => void;
  onHoverOut: (view: CardView) => void;
  onDragStart?: (view: CardView) => void;
  /**
   * 拖拽过程中、每次 pointermove 末尾触发一次。
   * 用途：手动理牌——GameController 据此判断拖拽牌的中心是否越过相邻牌中线、
   * 进而 splice hand 数组并触发 layoutHand 让相邻牌让位。
   *
   * 不在 update tick 里轮询而走事件驱动：
   *   - 节流粒度与浏览器 pointermove 一致（约 15~20ms 一次），足够顺滑；
   *   - 控制器代码无需每帧检查所有牌，开销低。
   *
   * 参数 (x, y) 是拖拽中卡牌在父容器坐标系下的"逻辑目标位置"（即 dragTargetX/Y，
   * 等价于鼠标当前位置 - 抓握偏移）。
   *
   * 实际用哪个值做换位判定由上层（GameController）决定：当前实现拖拽过程中用
   * `view.x`（lerp 平滑后的实际渲染中线），让"换位时机"严格对应卡片视觉中线穿过
   * 邻牌中线那一刻，手感清晰不模糊；而松手瞬间（onDragEnd）则改用 dragLogicalX/Y
   * （= 鼠标逻辑位置）做一次最终换位，避免"快速甩动后立刻松手时卡牌没追上鼠标
   * 导致落位偏差"。详见 GameController.reorderHandWhileDragging 的注释。
   */
  onDragging?: (view: CardView, x: number, y: number) => void;
  onDragEnd?: (view: CardView) => void;
}

export class CardView extends Container {
  selected = false;
  layoutX = 0;
  layoutY = 0;
  layoutRotation = 0;
  isDragging = false;
  /**
   * 位置驱动模式：
   *   - internal：旧版 updateDragging lerp/急停（遗留，主场景不再使用）
   *   - external：弹性绳积分写 x/y/rotation（主场景默认）
   */
  positionDriver: "internal" | "external" = "external";
  isReturning = false;

  /** 每张牌独立的弹性绳运动核（主场景 external 路径）。 */
  private readonly ropeMotion = new ElasticRopeMotion();
  /** 程序位移 / 归位的目标点（父容器本地坐标）。 */
  private moveTargetX = 0;
  private moveTargetY = 0;
  /** 程序目标基角（弧度）；绳积分角叠在其上。 */
  private moveTargetRotation = 0;
  private hasMoveTarget = false;
  /**
   * 当前是否正在播放"选中/取消选中位移过弹动画"。
   * 由 GameController.toggleSelection 设为 true，动画结束时清零。
   * layoutHand 看到 true 时跳过对该牌的 Tween，避免普通重排把过弹动画踢掉。
   */
  isSelectAnimating = false;
  /**
   * 当前是否正在播放"拖拽换位的弹性动画"（CardFx.swapMove）。
   * 由 CardFx.swapMove 入口设为 true，spring 阶段 onComplete 时清零。
   * layoutHand 看到 true 且本帧未再次出现在 swapFor 中时，会跳过对该牌的常规重排，
   * 避免后续 onDragging 帧用 moveToWithOvershoot 打断未完成的 rise，丢失 spring 弹性。
   * 当 layoutHand 的 opts.force = true 时（手牌数量变化等强制对齐场景）会无视此标志。
   */
  isSwapAnimating = false;
  /**
   * swap 动画代数。每次启动 / 强制清零 swap 动画时递增。
   * 用于区分「被新一次 swap 接管」与「真正被外部打断」：
   * 旧 tween 的 onStop 若发现代数已变，不再清 isSwapAnimating，
   * 避免新动画入口刚置 true、tm.add 互斥停掉旧 tween 时把新标志误清成 false。
   */
  swapAnimGen = 0;
  /**
   * 当前是否处于出牌堆上移（计分抬起）效果中。
   * 开启后阴影会切换成拖拽阴影效果。
   */
  isScoringLifted = false;
  /**
   * 当前是否正在从手牌堆移动到出牌堆。
   */
  isPlayCardMoving = false;
  /**
   * 结算筹码计算时的缩放乘数与旋转偏移（独立通道）
   */
  scoringScaleMul = 1.0;
  scoringRotOffset = 0.0;

  /**
   * 结算弹簧每帧回调（PlayPileFx.animateCardSettle 挂载）。
   * null 表示未在结算弹簧动画中。
   * 见 docs/play-pile-settle-spring-damper-plan.md §5.2 方式 B。
   */
  settleSpringTick: ((dtMS: number) => void) | null = null;

  // 当前卡牌在手牌数组中的索引（0 = 最左）。由 GameController.layoutHand() 每次重排时写入。
  // 用于"鼠标悬停伪3D倾斜"按位置插值卡牌强度（最左 vs 最右）。未参与布局时默认 0。
  handIndex = 0;
  // 当前手牌总数。同样由 layoutHand() 写入。用来计算 t = handIndex / (handCount - 1)。
  // n <= 1 时按 0.5 处理，避免除零。
  handCount = 1;

  // 状态机核心字段
  cardState: CardState = CardState.Normal;
  isMouseOver = false;
  private dragStartTime = 0;
  private dragMaxDistance = 0;

  // 视觉效果积累与辅助变量
  private breathingTime = Math.random() * 100;
  private wobbleTime = Math.random() * 100;
  // 常态伪3D倾斜呼吸晃动的时间累加器（随机初相，避免所有手牌同步）
  private idleTiltTime = Math.random() * Math.PI * 2;
  private currentScale = 1.0;
  private hoverScaleProgress = 0;
  // 拖拽缩放：以独立乘法通道作用到最终 displayWrapper.scale 上，
  // 不污染 hover 流程对 currentScale 的写入。
  // 0 = 进入态推进中；1 = 退出态推进中；null = 静止。
  private dragScaleAnim: "in" | "out" | null = null;
  private dragScaleProgress = 0;          // 0 → 1，按当前阶段时长推进
  private dragScaleFromMul = 1.0;         // 当前阶段起点（用于打断时无缝衔接）
  private dragScaleToMul = 1.0;           // 当前阶段终点
  private dragScaleMul = 1.0;             // 当前帧实际应用的乘数
  // 入场弹性动画是否已正常播放完毕（progress 达到 1）。
  // 用显式 boolean 标志，避免依赖浮点比较判断"动画完结"。
  private hoverScaleSettled = false;
  // 入场动画被打断后，回缩过弹状态
  // 仅当鼠标在入场动画未播完（hoverScaleSettled=false）就离开时启动。
  private outOvershootActive = false;
  private outOvershootProgress = 0;     // 0 → 1
  private outOvershootStartScale = 1.0; // 离开瞬间的 currentScale

  // 松手后若 dragScaleMul 仍偏高：先压下 hoverScale 再放大，避免与 drag 缩放回落叠加顿挫。
  // 由 restartHoverScaleEntrance() 在 dragScaleMul > 1.02 时置 true；同时会把 progress 打回 0。
  // 解除时机：
  //   (a) dragScale "out" 动画结束 → 以 progress=0 重新入场弹性；
  //   (b) 新的 pointerover；
  //   (c) pointerout。
  // 注意：只设本标志而不重置 progress 时，短按几乎看不出重播（progress 仍≈1）。
  private suppressHoverScaleUntilReenter = false;

  // 鼠标触碰呼吸晃动（独立通道）：
  // 一次性脱手脉冲，鼠标进入卡牌时触发：progress 0→1 按 hoverBreathingDurationMS 线性推进，
  // 同时内部独立的相位累加器 hoverBreathTime / hoverWobbleTime 推进 sin/cos，
  // 幅度由指数衰减包络 exp(-decay * progress) 控制（开头满幅、随时间衰减到接近 0）。
  // 输出值 hoverBreathingY / hoverWobbleRot 会与常态 breathingY / wobbleRot 相加叠加，
  // 与常态呼吸晃动相互独立、互不干扰。
  // active=false 时该通道完全归零（卡牌仅保留常态呼吸晃动）。
  private hoverBreathingActive = false;
  private hoverBreathingProgress = 0; // 0 → 1
  private hoverBreathTime = 0;        // 独立的 Y 位移呼吸相位
  private hoverWobbleTime = 0;        // 独立的 Z 旋转晃动相位
  private hoverBreathingY = 0;        // 当前帧 hover 通道 Y 位移输出
  private hoverWobbleRot = 0;         // 当前帧 hover 通道 Z 旋转输出

  // 鼠标在卡牌本地坐标系下的位置（以左上角为 0,0；如果鼠标不在卡上则为 null）。
  // 由 pointer 事件 / 每帧 global→local 刷新写入，updateMouse3DTilt 消费。
  public mouseLocalX: number | null = null;
  public mouseLocalY: number | null = null;

  // 最近一次指针的全局坐标（event.global）。用于选中上移/下移等「卡在动、鼠标不动」的帧：
  // 没有新的 pointermove 时，仍能每帧把全局点投影到卡牌本地，保持伪 3D 倾斜连续。
  private lastPointerGlobalX = 0;
  private lastPointerGlobalY = 0;
  private hasLastPointerGlobal = false;

  private breathingY = 0;
  private wobbleRot = 0;

  // ── 抓牌翻面动画（绕竖中轴线翻面：背面朝上 → 一条线 → 正面朝上）──
  // 翻面分两段：
  //   第一段（rise）：在飞向目标位置的过程中，翻约 90°（卡面压成"一条线"），到末尾切背面→正面贴图；
  //   第二段（settle）：到位后继续翻约 90°，最终正面水平朝上。
  // 用一个累加的有效角 flipAngle（0 → π）驱动，水平缩放 = |cos(flipAngle)|。
  // active=false 时该通道完全静默（flipScaleX 恒为 1，不影响任何其它效果）。
  private flipActive = false;
  private flipElapsedMS = 0;       // 自翻面开始累计的时长
  private flipFirstHalfMS = 0;     // 第一段（飞行中翻面）时长——通常等于飞行时长 × firstHalfRatio(±jitter)
  private flipSecondHalfMS = 0;    // 第二段（到位后翻面）时长——第一段时长 × secondHalfRatio(±jitter)
  private flipShowingBack = false; // 当前 mesh 是否正贴着背面纹理
  private flipScaleX = 1.0;        // 当前帧翻面通道输出的水平缩放（|cos(angle)|），作用到 displayWrapper.scale.x

  // ── 弃牌/出牌结束翻面动画（正面朝上 → 飞行途中翻约 90° → 压成一条线）──
  // 与抓牌翻面共用 flipScaleX 输出通道（同一时刻不会同时存在），但角度只从 0 单向翻到
  // 目标角（约 90°，带随机抖动），全程正面朝上、不切贴图。active=false 时完全静默。
  private discardFlipActive = false;
  private discardFlipElapsedMS = 0;  // 自弃牌翻面开始累计的时长
  private discardFlipDurationMS = 0; // 翻面总时长（= 飞行时长）
  private discardFlipTargetAngle = Math.PI / 2; // 目标累计角（弧度，约 π/2 带抖动）

  // 弃牌飞行期标志：飞向弃牌堆的整个过程为 true。期间禁用「速度→旋转」联动
  // （velocityRotation），让卡牌严格保持飞出瞬间设定的随机旋转角度直到弃牌结束。
  // 与翻面开关 discardFlip.enabled 解耦：无论翻面是否开启，弃牌飞行都禁用速度旋转。
  private discardFlying = false;

  // 4 个角的目标偏移量（相对于矩形几何角的位移，即"角点 = 几何角 + 偏移"）
  // TL=top-left, TR=top-right, BR=bottom-right, BL=bottom-left
  private targetCornerOffset = { tlX: 0, tlY: 0, trX: 0, trY: 0, brX: 0, brY: 0, blX: 0, blY: 0 };
  // 4 个角的当前偏移量（向 target 平滑插值）
  private currentCornerOffset = { tlX: 0, tlY: 0, trX: 0, trY: 0, brX: 0, brY: 0, blX: 0, blY: 0 };

  // 视觉子容器：承载所有卡面绘制（Graphics、Text、Sprite 等），
  // 但不直接显示在场景里——而是被 generateTexture 烤成 cardTexture 后由 tiltMesh 显示。
  private contentContainer: Container | null = null;
  // 离屏烘焙得到的卡面纹理（透视 mesh 的源贴图）
  private cardTexture: Texture | null = null;
  // 离屏烘焙得到的"背面"纹理（抓牌翻面动画前半段使用）。懒创建。
  private cardBackTexture: Texture | null = null;
  // 真正显示的透视 mesh（PerspectiveMesh）
  private tiltMesh: PerspectiveMesh | null = null;
  // 外层容器（承载 tiltMesh），用于施加 hover scale / wobble rotation / breathing y
  private displayWrapper: Container | null = null;

  private dragData: FederatedPointerEvent | null = null;
  private dragStartPointerX = 0;
  private dragStartPointerY = 0;
  private dragStartCardX = 0;
  private dragStartCardY = 0;
  private oldStageEventMode: any = null;
  private shadowGraphics: Graphics | null = null;
  private dragTargetX = 0;
  private dragTargetY = 0;

  /**
   * 拖拽中卡牌在父容器坐标系下的「逻辑目标位置」——等价于鼠标当前位置 - 抓握偏移。
   * 与 `view.x/y`（经 lerp 平滑后滞后于鼠标的实际渲染位置）相对。
   *
   * 暴露为只读 getter，主要供 GameController 在 `onDragEnd` 回调中读取：
   * 当玩家「快速甩动鼠标后立刻松手」时，由于 lerp/速度上限的存在，卡牌还没追上
   * 鼠标——此时基于 `view.x` 计算最终换位会让卡牌落在「鼠标已经到了，卡牌还没
   * 到」的中间位置，不符合玩家操作意图。松手瞬间用此值（= 鼠标逻辑位置）做
   * 一次最终换位计算，可让落位与玩家鼠标光标位置一致。
   *
   * 拖拽过程中的换位判定仍用 `view.x`（见 GameController.reorderHandWhileDragging
   * 的注释），保证视觉中线穿过邻牌中线的"严格手感"。
   */
  get dragLogicalX(): number {
    return this.dragTargetX;
  }
  get dragLogicalY(): number {
    return this.dragTargetY;
  }

  // 卡牌移动旋转（velocity-based tilt）的内部状态：
  //   prevX/prevY 在 updateMoveRotation 速度采样紧后保存"本帧入口位置"，
  //     下一帧入口用 (curX - prevX) / dtMS 计算这一整帧的瞬时平均速度（px/ms）。
  //   prevSampled 标志位用于规避第一次 update 时 prevX/prevY 还未初始化造成的伪速度突变。
  //   velocityRotation 是当前帧实际作用到 displayWrapper 上的旋转量（弧度），
  //   它以 followLerp 追逐 targetRot；摩擦仅在低速/停住时把旋转拉回 0。
  //   velSmoothX/Y 是对帧间差分速度的 EMA，抑制 rAF 抖动、指针节流与 lerp 台阶造成的角抖。
  private prevX = 0;
  private prevY = 0;
  private prevSampled = false;
  private velocityRotation = 0;
  private velSmoothX = 0;
  private velSmoothY = 0;
  /**
   * 最近一帧的卡牌位移速度（px/s）。由 updateMoveRotation 在差分后顺便写入。
   * 主路径位移过冲已由弹性绳接管；本字段保留给调试 / 未来视效。
   */
  private lastSpeedPxPerSec = 0;

  // 轴点可视化调试小点：直接挂在 CardView 自身（不进入 contentContainer / displayWrapper），
  // 因此它不参与卡牌内容的离屏烘焙，也不会跟着 velocityRotation 旋转，
  // 永远停在"轴点应该在的位置"——拖拽时若旋转补偿正确，卡牌上该点的图案会牢牢
  // 钉在这个标记下；若不正确，会看到二者相对滑动。
  // null 表示当前未启用（CONFIG.cardMoveRotation.showPivot = false）。
  private pivotMarker: Graphics | null = null;

  override addChild<U extends ContainerChild[]>(...children: U): U[0] {
    for (const child of children) {
      if (child && "roundPixels" in child) {
        (child as any).roundPixels = false;
      }
    }
    // 视觉元素重定向：除 shadowGraphics / contentContainer / displayWrapper / pivotMarker 本身，
    // 其余全部塞进 contentContainer（用于离屏烘焙）。
    const first = children[0];
    if (
      this.contentContainer &&
      first !== this.contentContainer &&
      first !== this.shadowGraphics &&
      first !== this.displayWrapper &&
      first !== this.pivotMarker
    ) {
      return this.contentContainer.addChild(...children);
    }
    return super.addChild(...children);
  }

  /**
   * 卡牌角色。joker 与 hand 共享同一套 CardView 视效管线与拖拽/选中交互，
   * 仅在效果门控（isVisualEnabled）与业务语义（不出牌/不弃牌）上区分。
   */
  readonly role: CardRole;
  /** 小丑图集索引；hand 角色下为 -1。图集贴图按此索引固定，与槽位顺序无关。 */
  readonly jokerIndex: number;

  constructor(
    readonly data: CardData,
    private readonly callbacks: CardViewCallbacks,
    private readonly shadowContainer?: Container,
    options?: CardViewOptions,
  ) {
    super();
    this.role = options?.role ?? "hand";
    this.jokerIndex = options?.jokerIndex ?? -1;
    this.draw();
    this.bindEvents();
    this.ropeMotion.reset({ x: 0, y: 0, rotation: 0 });
    // 程序位移默认锚点（非 0 的 py 才能产生绳倾角）；拖拽按下时会覆盖。
    this.applyProgramRopeAnchor();
    this.moveTargetX = 0;
    this.moveTargetY = 0;
    this.moveTargetRotation = 0;
    this.hasMoveTarget = true;
  }

  /** 是否由本类内部弹性绳驱动位姿（主场景默认 external）。 */
  private usesRopeDriver(): boolean {
    return this.positionDriver === "external";
  }

  /**
   * 程序位移用默认绳锚（牌心 X + CONFIG.elasticRopeCard.anchor.anchorY）。
   * 必须在抓牌/弃牌/layout 的 setMoveTarget 路径调用：锚点 Y=0 时 θ* 恒为 0。
   */
  private applyProgramRopeAnchor(): void {
    const a = defaultElasticRopeAnchorLocal();
    this.ropeMotion.setAnchorLocal(a.x, a.y);
  }

  /**
   * 将绳状态与当前视觉位姿对齐（瞬移 / 生成 / 打断后调用）。
   * rotation 作为基角写入；绳相对角清零。
   */
  syncRopePose(opts?: { x?: number; y?: number; rotation?: number }): void {
    const x = opts?.x ?? this.x;
    const y = opts?.y ?? this.y;
    const rot = opts?.rotation ?? this.rotation;
    this.x = x;
    this.y = y;
    this.rotation = rot;
    this.moveTargetX = x;
    this.moveTargetY = y;
    this.moveTargetRotation = rot;
    this.hasMoveTarget = true;
    this.ropeMotion.reset({ x, y, rotation: 0 });
    this.ropeMotion.setTarget(x, y);
    this.applyProgramRopeAnchor();
  }

  /**
   * 设置程序位移目标。只改目标点，路径/速度/过冲由弹性绳处理。
   * @param rotation 可选目标基角（扇形 layoutRotation 等）
   */
  setMoveTarget(x: number, y: number, rotation?: number): void {
    this.moveTargetX = x;
    this.moveTargetY = y;
    this.hasMoveTarget = true;
    if (rotation !== undefined) {
      this.moveTargetRotation = rotation;
    }
    // 非拖拽位移统一用默认锚点，保证抓牌等路径有力矩臂产生倾角。
    // 拖拽中的牌不会走 setMoveTarget（layoutHand 会 skip isDragging）。
    if (!this.isDragging) {
      this.applyProgramRopeAnchor();
    }
    this.ropeMotion.setTarget(x, y);
  }

  isRopeSettled(): boolean {
    if (!this.usesRopeDriver()) {
      return (
        Math.hypot(this.x - this.moveTargetX, this.y - this.moveTargetY) < 2
      );
    }
    return this.ropeMotion.isSettled(readElasticRopeParams());
  }

  /**
   * 等待绳吸附完成（或超时硬贴目标）。依赖 App ticker 里的 card.update 步进。
   */
  waitSettled(timeoutMS = 8000): Promise<void> {
    if (!this.isDragging && this.isRopeSettled()) {
      return Promise.resolve();
    }
    const start = performance.now();
    return new Promise((resolve) => {
      const tick = (): void => {
        const timedOut = performance.now() - start > timeoutMS;
        if ((!this.isDragging && this.isRopeSettled()) || timedOut) {
          if (timedOut && this.hasMoveTarget && !this.isDragging) {
            this.syncRopePose({
              x: this.moveTargetX,
              y: this.moveTargetY,
              rotation: this.moveTargetRotation,
            });
          }
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  /** 调试 / 沙盒：暴露运动核只读访问。 */
  getRopeMotion(): ElasticRopeMotion {
    return this.ropeMotion;
  }

  private stepElasticRope(dtMS: number): void {
    if (this.isDragging) {
      this.ropeMotion.setTarget(this.dragTargetX, this.dragTargetY);
    } else if (this.hasMoveTarget) {
      this.ropeMotion.setTarget(this.moveTargetX, this.moveTargetY);
    }

    const params = readElasticRopeParams();

    // 总开关关闭：硬贴目标（仍走 external，避免卡死在半空）
    if (!params.enabled) {
      if (this.isDragging) {
        this.x = this.dragTargetX;
        this.y = this.dragTargetY;
      } else if (this.hasMoveTarget) {
        this.x = this.moveTargetX;
        this.y = this.moveTargetY;
        this.rotation = this.moveTargetRotation;
        this.ropeMotion.reset({
          x: this.x,
          y: this.y,
          rotation: 0,
        });
        this.ropeMotion.setTarget(this.x, this.y);
      }
      if (this.isReturning && !this.isDragging) this.isReturning = false;
      if (this.isSwapAnimating && !this.isDragging) this.isSwapAnimating = false;
      return;
    }

    const pose = this.ropeMotion.step(dtMS, params);
    this.x = pose.x;
    this.y = pose.y;
    // 基角（layout / 弃牌随机角）+ 绳相对倾角。弃牌飞行不再冻结 rotation——
    // 旧 discardFlying 是为 velocityRotation 设计的；冻结会让 setMoveTarget 的
    // 目标角与绳倾角全部失效，弃牌看起来像「纯平移」。
    this.rotation = this.moveTargetRotation + pose.rotation;

    if (this.isReturning && !this.isDragging && this.isRopeSettled()) {
      this.isReturning = false;
    }
    // swap 动画：已 settle 时清旗（代数由 swapMove 入口维护）
    if (this.isSwapAnimating && !this.isDragging && this.isRopeSettled()) {
      this.isSwapAnimating = false;
    }
  }

  /** 是否为小丑牌（可拖拽排序/选中弹起，但不参与出牌/弃牌/点数花色理牌）。 */
  get isJoker(): boolean {
    return this.role === "joker";
  }

  /**
   * 视效是否启用。
   *   - hand：只看手牌专区自身开关；
   *   - joker：手牌开关 AND CONFIG.joker.effects[key]（参数值仍读手牌配置）。
   */
  private isVisualEnabled(key: JokerReusableFx): boolean {
    const cv = CONFIG.cardVisuals;
    let handOn = true;
    switch (key) {
      case "shadow":
        // 常态阴影目前没有独立 enabled 字段，始终视为开启。
        handOn = true;
        break;
      case "breathing":
        handOn = !!cv?.breathingEnabled;
        break;
      case "idleTilt":
        handOn = !!cv?.idleTiltEnabled;
        break;
      case "hoverHit":
        handOn = !!cv?.hoverHitEnabled;
        break;
      case "hoverScale":
        handOn = !!cv?.hoverScaleEnabled;
        break;
      case "hoverBreathing":
        handOn = !!cv?.hoverBreathingEnabled;
        break;
      case "mouse3DTilt":
        handOn = !!cv?.mouse3DTiltEnabled;
        break;
      default:
        handOn = true;
    }
    if (this.role !== "joker") return handOn;
    const jokerFx = CONFIG.joker?.effects;
    const jokerOn = jokerFx ? (jokerFx[key] ?? true) : true;
    return handOn && jokerOn;
  }

  /** 运行时美术参数变化后，保留位置/交互状态，只重建内部绘制节点。 */
  refreshArt(): void {
    if (this.shadowGraphics && this.shadowGraphics.parent) {
      this.shadowGraphics.parent.removeChild(this.shadowGraphics);
      this.shadowGraphics.destroy();
      this.shadowGraphics = null;
    }
    // 清理 displayWrapper（自身在 CardView children 内，由 removeChildren 处理）和它内部的 mesh。
    if (this.tiltMesh) {
      this.tiltMesh.destroy();
      this.tiltMesh = null;
    }
    this.displayWrapper = null; // 由 removeChildren 自动 destroy
    // pivotMarker 也挂在 CardView 直接 children 内，会被 removeChildren 一并 destroy；
    // 这里仅需把引用清掉，下一次 update() 看到 showPivot=true 时会重新创建。
    this.pivotMarker = null;
    // 离屏 contentContainer 不在 CardView children 里，要单独 destroy。
    if (this.contentContainer) {
      this.contentContainer.destroy({ children: true });
      this.contentContainer = null;
    }
    if (this.cardTexture) {
      deferDestroyTexture(this.cardTexture);
      this.cardTexture = null;
    }
    if (this.cardBackTexture) {
      deferDestroyTexture(this.cardBackTexture);
      this.cardBackTexture = null;
    }
    // 美术参数变化会重建 mesh：翻面通道里指向旧贴图的状态必须清掉，避免引用已销毁纹理。
    this.flipActive = false;
    this.flipShowingBack = false;
    this.flipScaleX = 1.0;
    this.removeChildren().forEach((child) => {
      child.destroy({ children: true });
    });
    this.draw();
  }

  override destroy(options?: any): void {
    if (this.shadowGraphics) {
      if (this.shadowGraphics.parent) {
        this.shadowGraphics.parent.removeChild(this.shadowGraphics);
      }
      this.shadowGraphics.destroy();
      this.shadowGraphics = null;
    }
    if (this.tiltMesh) {
      this.tiltMesh.destroy();
      this.tiltMesh = null;
    }
    if (this.contentContainer) {
      // contentContainer 不挂在场景树里，单独 destroy。
      this.contentContainer.destroy({ children: true });
      this.contentContainer = null;
    }
    if (this.cardTexture) {
      deferDestroyTexture(this.cardTexture);
      this.cardTexture = null;
    }
    if (this.cardBackTexture) {
      deferDestroyTexture(this.cardBackTexture);
      this.cardBackTexture = null;
    }
    if (this.pivotMarker) {
      if (this.pivotMarker.parent) {
        this.pivotMarker.parent.removeChild(this.pivotMarker);
      }
      this.pivotMarker.destroy();
      this.pivotMarker = null;
    }
    super.destroy(options);
  }

  private draw(): void {
    const W = CardSkin.width;
    const H = CardSkin.height;

    // 1. contentContainer：承载所有卡面绘制内容，但 **不直接挂在 CardView 上**——
    //    它只用作离屏烘焙的源场景。pivot/position 都置零，整个卡面正好覆盖 (0,0)~(W,H)。
    this.contentContainer = new Container();
    this.contentContainer.pivot.set(0, 0);
    this.contentContainer.position.set(0, 0);

    // 2. shadowGraphics：阴影逻辑保持不变
    this.shadowGraphics = new Graphics();
    this.shadowGraphics.pivot.set(W / 2, H / 2);
    if (!this.isDragging && this.shadowContainer) {
      this.shadowContainer.addChild(this.shadowGraphics);
    } else {
      super.addChild(this.shadowGraphics);
    }

    // 3. 绘制卡面元素。drawSprite/drawProcedural 内部用 this.addChild，
    //    会被重定向到 contentContainer。
    // 小丑：始终用 Jokers 图集（与 cardArt.useSprites 解耦——小丑没有程序化美术）。
    // 手牌：useSprites 时用 8BitDeck 正面 (rank, suit)。
    let tex: Texture | undefined;
    if (this.role === "joker" && this.jokerIndex >= 0 && assets.isReady) {
      tex = assets.getJoker(this.jokerIndex);
    } else if (CONFIG.cardArt.useSprites && assets.isReady) {
      tex = assets.getFront(this.data.rank, this.data.suit);
    }

    if (tex) {
      this.drawSprite(tex);
    } else {
      this.drawProcedural();
    }

    // 4. 圆角遮罩（保持与原逻辑一致），作用在 contentContainer 上。
    const pad = tex ? 2 : 0;
    const maskW = tex ? W - pad * 2 : W;
    const maskH = tex ? H - pad * 2 : H;
    const maskR = tex ? Math.max(0, CONFIG.cardArt.cornerRadius) : CONFIG.cardArt.cornerRadius;

    const cardMask = new Graphics();
    cardMask.roundRect(pad, pad, maskW, maskH, maskR);
    cardMask.fill({ color: 0xffffff });
    cardMask.roundPixels = false;
    // 直接放进 contentContainer（绕开 addChild 重定向，避免无谓判断）
    this.contentContainer.addChild(cardMask);
    this.contentContainer.mask = cardMask;

    // 5. 创建 RenderTexture 并烘焙 contentContainer。
    this.bakeCardTexture();

    // 6. 创建 PerspectiveMesh + displayWrapper（承载所有外部 transform：scale/rotation/breathingY）。
    this.tiltMesh = new PerspectiveMesh({
      texture: this.cardTexture ?? Texture.WHITE,
      // 顶点密度：越高越平滑，但开销越大。卡牌尺寸小，10x14 已足够丝滑且仍是高效区间。
      verticesX: 10,
      verticesY: 14,
      x0: 0, y0: 0,
      x1: W, y1: 0,
      x2: W, y2: H,
      x3: 0, y3: H,
    });
    (this.tiltMesh as any).roundPixels = false;

    this.displayWrapper = new Container();
    this.displayWrapper.pivot.set(W / 2, H / 2);
    this.displayWrapper.position.set(W / 2, H / 2);
    this.displayWrapper.addChild(this.tiltMesh);
    super.addChild(this.displayWrapper);

    // 7. CardView 自身的 pivot/几何中心（保持与原逻辑一致，使外部 rotation/scale 围绕中心）。
    this.pivot.set(W / 2, H / 2);

    this.updateShadow();
  }

  /**
   * 把 contentContainer 离屏烤成 cardTexture，供 PerspectiveMesh 当作贴图。
   * 调用时机：首次 draw() / refreshArt() / 选中态变化等需要刷新卡面静态外观时。
   *
   * 注意：mesh 上的纹理只反映 contentContainer 的"静态"内容（卡面 art + 圆角）。
   * 呼吸晃动、hover 缩放、3D 倾斜等动效不进入纹理，而是作用在 displayWrapper / mesh corners 上。
   */
  private bakeCardTexture(): void {
    if (!this.contentContainer) return;
    const renderer = uiHierarchy.getRenderer();
    if (!renderer) {
      // 没有 renderer（很早期阶段或测试环境）：暂时不烤，等下一次再尝试。
      return;
    }

    const W = CardSkin.width;
    const H = CardSkin.height;

    try {
      const tex = renderer.generateTexture({
        target: this.contentContainer,
        frame: new Rectangle(0, 0, W, H),
        resolution: renderer.resolution,
        antialias: true,
        textureSourceOptions: { autoGarbageCollect: false },
      });
      tex.source.autoGarbageCollect = false;
      const old = this.cardTexture;
      this.cardTexture = tex;
      if (this.tiltMesh) {
        this.tiltMesh.texture = tex;
      }
      // 延迟销毁旧烤纹理，避免 WebGPU batch BindGroup 仍引用 source 时崩溃。
      if (old && old !== tex) deferDestroyTexture(old);
    } catch (err) {
      console.warn(`[CardView] bakeCardTexture 失败：`, err);
    }
  }

  /**
   * 懒烘焙"背面"纹理，供抓牌翻面动画前半段使用。
   *
   * 背面外观与 DeckView 顶面、CardView 正面分支保持一致（白底 + 背面贴图 + 1px 像素描边 + 圆角遮罩），
   * 只是贴图换成 assets.getBack(CONFIG.cardArt.back)。烤出来的纹理尺寸与正面一致（W×H），
   * 这样翻面切换贴图时不会有任何尺寸跳变。
   *
   * 没有 renderer / 背面贴图缺失时返回 null（翻面会自动退化为不显示背面）。
   */
  private getCardBackTexture(): Texture | null {
    if (this.cardBackTexture) return this.cardBackTexture;

    const renderer = uiHierarchy.getRenderer();
    if (!renderer) return null;

    const W = CardSkin.width;
    const H = CardSkin.height;
    const { row, col } = CONFIG.cardArt.back;
    const backTex = assets.getBack(row, col);
    if (!backTex) return null;

    const pad = 2;
    const innerW = W - pad * 2;
    const innerH = H - pad * 2;
    const innerRadius = Math.max(0, CONFIG.cardArt.cornerRadius);

    const src = new Container();

    const bg = new Graphics();
    bg.roundRect(pad, pad, innerW, innerH, innerRadius);
    bg.fill({ color: CONFIG.cardArt.faceColor });
    src.addChild(bg);

    const sprite = new Sprite(backTex);
    sprite.position.set(pad, pad);
    sprite.width = innerW;
    sprite.height = innerH;
    src.addChild(sprite);

    // 像素描边纹理在贴图原生分辨率下生成，再缩放到 innerW×innerH，
    // 故圆角半径需从显示空间换算回贴图像素空间（与 DeckView / drawPixelOutline 一致）。
    const sxRatio = innerW / backTex.width;
    const syRatio = innerH / backTex.height;
    const sourceRadius = innerRadius / ((sxRatio + syRatio) / 2);
    const outline = new Sprite(
      getPixelOutlineTexture(backTex.width, backTex.height, sourceRadius, CONFIG.cardArt.outlineColor)
    );
    outline.position.set(pad, pad);
    outline.width = innerW;
    outline.height = innerH;
    src.addChild(outline);

    const mask = new Graphics();
    mask.roundRect(pad, pad, innerW, innerH, innerRadius);
    mask.fill({ color: 0xffffff });
    mask.roundPixels = false;
    src.addChild(mask);
    src.mask = mask;

    try {
      const tex = renderer.generateTexture({
        target: src,
        frame: new Rectangle(0, 0, W, H),
        resolution: renderer.resolution,
        antialias: true,
        textureSourceOptions: { autoGarbageCollect: false },
      });
      tex.source.autoGarbageCollect = false;
      this.cardBackTexture = tex;
      return tex;
    } catch (err) {
      console.warn(`[CardView] bakeCardBackTexture 失败：`, err);
      return null;
    } finally {
      src.destroy({ children: true });
    }
  }

  /**
   * 启动"抓牌翻面"动画。由 GameController.drawToFull 在发牌瞬间调用。
   *
   * @param flightDurationMS 该牌从发牌堆飞到目标位置的时长（用于把翻面节奏与飞行同步）。
   *
   * 翻面节奏（两段，各带一个随机抖动量——即用户要的两个"大概"）：
   *   第一段时长 = flightDurationMS × clamp(firstHalfRatio ± rand(firstHalfJitter), 0~1)
   *               这一段内 flipAngle 0 → π/2（卡面压成一条线），末尾把贴图从背面切到正面。
   *   第二段时长 = 第一段时长 × max(0, secondHalfRatio ± rand(secondHalfJitter))
   *               这一段内 flipAngle π/2 → π，最终正面水平朝上。
   *
   * 开关关闭、或缺少 renderer/背面贴图时直接放弃翻面（卡牌正面朝上，无动画），不影响发牌。
   */
  public startDrawFlip(flightDurationMS: number): void {
    const cfg = CONFIG.drawFlip;
    if (!cfg?.enabled) {
      this.cancelDrawFlip();
      return;
    }

    const backTex = this.getCardBackTexture();
    if (!backTex || !this.tiltMesh) {
      // 拿不到背面纹理：无法翻面，保持正面朝上。
      this.cancelDrawFlip();
      return;
    }

    const rand = (jitter: number) => (Math.random() * 2 - 1) * Math.max(0, jitter);

    const firstRatio = Math.min(
      1,
      Math.max(0, (cfg.firstHalfRatio ?? 1.0) + rand(cfg.firstHalfJitter ?? 0))
    );
    const secondRatio = Math.max(0, (cfg.secondHalfRatio ?? 0.5) + rand(cfg.secondHalfJitter ?? 0));

    const flight = Math.max(1, flightDurationMS);
    this.flipFirstHalfMS = Math.max(1, flight * firstRatio);
    this.flipSecondHalfMS = Math.max(0, this.flipFirstHalfMS * secondRatio);

    this.flipActive = true;
    this.flipElapsedMS = 0;
    this.flipScaleX = 1.0;

    // 立刻切到背面贴图（发牌瞬间背面朝上）。
    this.flipShowingBack = true;
    this.tiltMesh.texture = backTex;
  }

  /** 中止翻面动画并恢复正面显示（防御/退化路径）。 */
  private cancelDrawFlip(): void {
    this.flipActive = false;
    this.flipScaleX = 1.0;
    if (this.flipShowingBack && this.tiltMesh && this.cardTexture) {
      this.tiltMesh.texture = this.cardTexture;
    }
    this.flipShowingBack = false;
  }

  /**
   * 推进翻面动画。每帧在 applyVisuals 之前调用。
   *
   * flipAngle 由分段线性时间映射得到：
   *   t ∈ [0, firstHalfMS]            → angle 0 → π/2，到 firstHalfMS 时切背面→正面贴图；
   *   t ∈ [firstHalfMS, +secondHalfMS] → angle π/2 → π；
   *   t ≥ 全程                         → angle = π，结束，flipScaleX 收敛回 1。
   * 水平缩放 flipScaleX = |cos(angle)|，在 π/2 处恰好为 0（"一条线"），在 0 / π 处为 1（满幅正/背面）。
   */
  private updateDrawFlip(dtMS: number): void {
    if (!this.flipActive) return;

    this.flipElapsedMS += dtMS;

    const firstMS = this.flipFirstHalfMS;
    const secondMS = this.flipSecondHalfMS;
    const totalMS = firstMS + secondMS;

    let angle: number;
    if (this.flipElapsedMS <= firstMS) {
      // 第一段：0 → π/2
      angle = (this.flipElapsedMS / firstMS) * (Math.PI / 2);
    } else if (this.flipElapsedMS < totalMS && secondMS > 0) {
      // 第二段：π/2 → π
      const t2 = (this.flipElapsedMS - firstMS) / secondMS;
      angle = Math.PI / 2 + t2 * (Math.PI / 2);
    } else {
      angle = Math.PI;
    }

    // 越过 90° 临界点（卡面压成一条线）时，把贴图从背面切到正面。
    if (this.flipShowingBack && angle >= Math.PI / 2) {
      if (this.tiltMesh && this.cardTexture) {
        this.tiltMesh.texture = this.cardTexture;
      }
      this.flipShowingBack = false;
    }

    this.flipScaleX = Math.abs(Math.cos(angle));

    // 全程结束：收尾归一，关闭通道。
    if (this.flipElapsedMS >= totalMS) {
      this.flipActive = false;
      this.flipScaleX = 1.0;
      if (this.flipShowingBack && this.tiltMesh && this.cardTexture) {
        this.tiltMesh.texture = this.cardTexture;
        this.flipShowingBack = false;
      }
    }
  }

  /**
   * 启动「弃牌/出牌结束」翻面：牌正面朝上，飞出后沿竖中轴线翻面，
   * 在飞行时长内累计翻到约 90°（flipAngleDeg ± flipAngleJitterDeg），最终大概压成一条线。
   *
   * 全程不切贴图（角度 ≤ 90°，背面不会露出）。开关关闭时直接放弃（保持满幅正面），不影响飞出。
   *
   * @param flightDurationMS 卡牌飞向弃牌堆的飞行时长（翻面与之同步）。
   */
  public startDiscardFlip(flightDurationMS: number): void {
    const cfg = CONFIG.discardFlip;
    if (!cfg?.enabled) {
      this.cancelDiscardFlip();
      return;
    }

    const rand = (jitter: number) => (Math.random() * 2 - 1) * Math.max(0, jitter);
    const angleDeg = Math.max(
      0,
      Math.min(90, (cfg.flipAngleDeg ?? 90) + rand(cfg.flipAngleJitterDeg ?? 0))
    );

    this.discardFlipActive = true;
    this.discardFlipElapsedMS = 0;
    this.discardFlipDurationMS = Math.max(1, flightDurationMS);
    this.discardFlipTargetAngle = (angleDeg * Math.PI) / 180;
    this.flipScaleX = 1.0;
  }

  /** 中止弃牌翻面并恢复满幅显示（防御/退化路径）。 */
  private cancelDiscardFlip(): void {
    this.discardFlipActive = false;
    if (!this.flipActive) this.flipScaleX = 1.0;
  }

  /**
   * 标记进入「弃牌飞行期」。
   * 主场景 positionDriver=external 时，位姿由弹性绳写；本标志仅作遗留/internal
   * 路径上禁用 velocityRotation 的哨兵。随机基角请通过 setMoveTarget(..., rot) 设定，
   * 绳倾角会叠在基角上，不再冻结 this.rotation。
   */
  public beginDiscardFly(): void {
    this.discardFlying = true;
    this.velocityRotation = 0;
  }

  /** 结束「弃牌飞行期」（牌随即被数据层回收；清标志避免复用残留）。 */
  public endDiscardFly(): void {
    this.discardFlying = false;
  }

  /**
   * 推进弃牌翻面动画。每帧在 applyVisuals 之前调用。
   * angle 从 0 线性翻到 targetAngle（约 π/2），水平缩放 flipScaleX = |cos(angle)|，
   * 到目标角时大概压成一条线后保持（牌此时已飞出屏外，被回收）。
   */
  private updateDiscardFlip(dtMS: number): void {
    if (!this.discardFlipActive) return;

    this.discardFlipElapsedMS += dtMS;
    const t = Math.min(1, this.discardFlipElapsedMS / this.discardFlipDurationMS);
    const angle = t * this.discardFlipTargetAngle;
    this.flipScaleX = Math.abs(Math.cos(angle));

    if (t >= 1) {
      // 到达目标角后保持压线状态（不归一），牌已飞出屏外随即被数据层回收。
      this.discardFlipActive = false;
    }
  }

  updateShadow(): void {
    if (!this.shadowGraphics) return;

    // 小丑牌可关闭阴影；手牌始终绘制（cardShadow 无独立 enabled）。
    if (!this.isVisualEnabled("shadow")) {
      this.shadowGraphics.visible = false;
      return;
    }

    const width = CardSkin.width;
    const height = CardSkin.height;
    const cornerRadius = CONFIG.cardArt.cornerRadius;

    let shadowConf: {
      color: number;
      alpha: number;
      lightX: number;
      lightY: number;
      distanceRatio: number;
      scaleRatio: number;
      /** 有值时：卡牌 Y 高于（小于）该值则阴影纵向偏移按该 Y 封顶 */
      stretchLimitY?: number;
    };

    if (this.isDragging) {
      shadowConf = CONFIG.dragShadow;
    } else if (this.isScoringLifted) {
      const effect = CONFIG.playPileLiftEffect;
      shadowConf = {
        color: effect.shadowColor,
        alpha: effect.shadowAlpha,
        lightX: effect.shadowLightX,
        lightY: effect.shadowLightY,
        distanceRatio: effect.shadowDistanceRatio,
        scaleRatio: effect.shadowScaleRatio,
      };
    } else {
      shadowConf = CONFIG.cardShadow;
    }

    this.shadowGraphics.clear();
    this.shadowGraphics.roundRect(0, 0, width, height, cornerRadius);
    this.shadowGraphics.fill({ color: shadowConf.color });

    // ─────────────────────────────────────────────────────────────────────
    // 取卡牌"真实视觉位姿"（外层 CardView + 内层 displayWrapper 的叠加）。
    //
    // 单纯使用 this.rotation / this.x / this.y 只能反映外层位姿，
    // 而 wobble / hoverWobble / velocityRotation / 呼吸晃动等所有实时动效
    // 都叠加在 displayWrapper 上（见 applyVisuals 末尾），不同步会导致：
    //   - 卡牌"运动拖尾旋转"时阴影还在按 layoutRotation 渲染；
    //   - 呼吸/hover 抖动时阴影完全不动。
    //
    // 调用时机：GameController 每帧先调 child.update(dtMS)（其末尾会写好
    // displayWrapper.rotation/position），再调 child.updateShadow()——所以
    // 这里读 displayWrapper 是"最新一帧"的。
    // ─────────────────────────────────────────────────────────────────────
    const wrapper = this.displayWrapper;
    // displayWrapper 的内层旋转（wobble + hoverWobble + velocityRotation）
    const innerRot = wrapper ? wrapper.rotation : 0;
    // displayWrapper 在 CardView 本地坐标里相对"默认中心 (W/2, H/2)"的位移
    // （包含 breathingY + hoverBreathingY + pivotComp）
    const innerLocalOffsetX = wrapper ? wrapper.position.x - width / 2 : 0;
    const innerLocalOffsetY = wrapper ? wrapper.position.y - height / 2 : 0;

    // 卡牌真实视觉旋转角（用于阴影自身姿态）
    const visualRot = this.rotation + innerRot;

    // 将 displayWrapper 的"本地位移"经外层 CardView 的 rotation/scale 变换到世界系
    // 得到"卡牌视觉中心相对 layout 位姿的世界系偏移"
    const cosOuter = Math.cos(this.rotation);
    const sinOuter = Math.sin(this.rotation);
    const innerWorldOffsetX = (innerLocalOffsetX * cosOuter - innerLocalOffsetY * sinOuter) * this.scale.x;
    const innerWorldOffsetY = (innerLocalOffsetX * sinOuter + innerLocalOffsetY * cosOuter) * this.scale.y;

    // 卡牌"视觉中心"在世界坐标系中的位置
    const cx = this.x + innerWorldOffsetX;
    const cy = this.y + innerWorldOffsetY;

    // 计算阴影位置（从虚拟光源到卡牌中心，按 ratio 反向投影）
    const lx = shadowConf.lightX;
    const ly = shadowConf.lightY;
    const ratio = shadowConf.distanceRatio;

    // 阴影 Y 向拉长上限：卡牌视觉中心高于 stretchLimitY（屏幕坐标 Y 更小）时，
    // 纵向投影仍按 limitY 计算，避免牌抬得越高阴影越无限往下拉长。
    // X 向仍用真实 cx，只钳制 Y。
    const cyForStretch =
      shadowConf.stretchLimitY !== undefined
        ? Math.max(cy, shadowConf.stretchLimitY)
        : cy;

    // 世界坐标系中的相对偏移
    const worldDx = (lx - cx) * ratio;
    const worldDy = (ly - cyForStretch) * ratio;

    // 同步可见性
    this.shadowGraphics.visible = this.visible;

    if (this.isDragging || this.isScoringLifted || !this.shadowContainer) {
      // 确保它挂在当前 CardView 下
      if (this.shadowGraphics.parent !== this) {
        if (this.shadowGraphics.parent) {
          this.shadowGraphics.parent.removeChild(this.shadowGraphics);
        }
        this.addChildAt(this.shadowGraphics, 0);
      }

      // 拖拽态阴影挂在 CardView 自身下：父级 CardView 已自动带它经过 this.rotation
      // 与 this.scale 的变换，但 displayWrapper 的内层 rotation 不会自动传给它。
      // 思路：让阴影自己再补一份 innerRot 的旋转，并把世界偏移逆变换到 CardView 局部。

      // 1) 把世界偏移逆向旋转/缩放到 CardView 局部坐标
      //    注意：外层 scale 可能不是 1（hover/drag 缩放），需要除掉避免阴影过大或过小
      const sx = this.scale.x || 1;
      const sy = this.scale.y || 1;
      const invCos = Math.cos(-this.rotation);
      const invSin = Math.sin(-this.rotation);
      const localDx = (worldDx * invCos - worldDy * invSin) / sx;
      const localDy = (worldDx * invSin + worldDy * invCos) / sy;

      // 2) 同样把 displayWrapper 的本地偏移也加上——它已经在 CardView 本地坐标里了
      //    （wrapper.position 就是相对 CardView 的 local position），直接累加即可
      this.shadowGraphics.position.set(
        width / 2 + innerLocalOffsetX + localDx,
        height / 2 + innerLocalOffsetY + localDy,
      );
      // 3) 阴影自身只需补 innerRot：外层 this.rotation 由父级带，外层 scale 同理
      this.shadowGraphics.rotation = innerRot;
      // 抓牌翻面：卡面沿竖中轴线被压缩（flipScaleX），阴影也要同步在 X 轴压缩，
      // 否则会出现"卡牌翻成一条线、阴影仍是满幅矩形"的脱节。
      this.shadowGraphics.scale.set(shadowConf.scaleRatio * this.flipScaleX, shadowConf.scaleRatio);
      this.shadowGraphics.alpha = shadowConf.alpha;
    } else {
      // 确保它挂在独立的 shadowContainer 下
      if (this.shadowGraphics.parent !== this.shadowContainer) {
        if (this.shadowGraphics.parent) {
          this.shadowGraphics.parent.removeChild(this.shadowGraphics);
        }
        this.shadowContainer.addChild(this.shadowGraphics);
      }

      // 常态阴影在独立层级中，需要直接把"卡牌视觉位姿"写到阴影自己身上
      this.shadowGraphics.position.set(cx + worldDx, cy + worldDy);
      this.shadowGraphics.rotation = visualRot;
      // 抓牌翻面：阴影 X 轴跟随卡面的 flipScaleX 压缩（阴影旋转 visualRot 与卡面内层旋转一致，
      // 故局部 X 轴方向一致，可直接相乘），避免翻面时阴影与卡面脱节。
      this.shadowGraphics.scale.set(
        this.scale.x * shadowConf.scaleRatio * this.flipScaleX,
        this.scale.y * shadowConf.scaleRatio,
      );
      this.shadowGraphics.alpha = shadowConf.alpha;
      this.shadowGraphics.pivot.set(width / 2, height / 2);
    }
  }

  /**
   * 精灵图分支：背景+正面贴图+1像素外描边，整体保持与程序化绘制相同的外尺寸。
   *
   * 卡面底色（CONFIG.cardArt.faceColor）手牌 / 小丑共用：
   *   - 手牌 8BitDeck 本身透明底，底色直接透出；
   *   - 小丑 Jokers 图集在 AssetManager 加载时已把纯白底打成透明，语义与手牌一致。
   */
  private drawSprite(tex: Texture): void {
    const { width, height } = CardSkin;
    const cornerRadius = CONFIG.cardArt.cornerRadius;
    const faceColor = CONFIG.cardArt.faceColor;

    // 让 sprite 在卡牌内框留一点 padding，避免圆角被切硬边。
    const pad = 2;
    const innerW = width - pad * 2;
    const innerH = height - pad * 2;
    const innerRadius = Math.max(0, cornerRadius);

    // 卡面底色：尺寸与 sprite 完全一致，不再外扩到 100×140。
    const bg = new Graphics();
    bg.roundRect(pad, pad, innerW, innerH, innerRadius);
    bg.fill({ color: faceColor });
    this.addChild(bg);

    const sprite = new Sprite(tex);
    sprite.position.set(pad, pad);
    sprite.width = innerW;
    sprite.height = innerH;
    this.addChild(sprite);

    this.drawPixelOutline(pad, pad, innerW, innerH, innerRadius, tex.width, tex.height);
  }

  /** 程序化绘制分支：与原型一致，作为贴图未加载时的兜底。 */
  private drawProcedural(): void {
    const { width, height } = CardSkin;
    const cornerRadius = CONFIG.cardArt.cornerRadius;
    const faceColor = CONFIG.cardArt.faceColor;

    const bg = new Graphics();
    bg.roundRect(0, 0, width, height, cornerRadius);
    bg.fill({ color: faceColor });
    this.addChild(bg);

    let color: number = CardSkin.spadesColor;
    if (this.data.suit === "♥") color = CardSkin.heartsColor;
    else if (this.data.suit === "♦") color = CardSkin.diamondsColor;
    else if (this.data.suit === "♣") color = CardSkin.clubsColor;

    const textStyle = {
      fontFamily: CardSkin.fontFamily,
      fontSize: CardSkin.cornerFontSize,
      fill: color,
      fontWeight: "900",
      align: "center",
      dropShadow: true,
      dropShadowColor: 0xffffff,
      dropShadowDistance: 1,
    } as const;

    const topLeftRank = new Text({
      text: this.data.rank,
      style: { ...textStyle, fontSize: CardSkin.cornerFontSize + 4 },
    });
    topLeftRank.anchor.set(0.5, 0);
    topLeftRank.position.set(12, 4);
    this.addChild(topLeftRank);

    const topLeftSuit = new Text({
      text: this.data.suit,
      style: { ...textStyle, fontSize: CardSkin.cornerFontSize },
    });
    topLeftSuit.anchor.set(0.5, 0);
    topLeftSuit.position.set(12, 24);
    this.addChild(topLeftSuit);

    const bottomRightRank = new Text({
      text: this.data.rank,
      style: { ...textStyle, fontSize: CardSkin.cornerFontSize + 4 },
    });
    bottomRightRank.anchor.set(0.5, 0);
    bottomRightRank.position.set(width - 12, height - 4);
    bottomRightRank.rotation = Math.PI;
    this.addChild(bottomRightRank);

    const bottomRightSuit = new Text({
      text: this.data.suit,
      style: { ...textStyle, fontSize: CardSkin.cornerFontSize },
    });
    bottomRightSuit.anchor.set(0.5, 0);
    bottomRightSuit.position.set(width - 12, height - 24);
    bottomRightSuit.rotation = Math.PI;
    this.addChild(bottomRightSuit);

    // 中心区域
    if (["J", "Q", "K"].includes(this.data.rank)) {
      const faceBg = new Graphics();
      faceBg.rect(width * 0.2, height * 0.2, width * 0.6, height * 0.6);
      faceBg.fill({ color: 0xe8e8e8 });
      faceBg.stroke({ width: 2, color: color });
      this.addChild(faceBg);

      const faceText = new Text({
        text: this.data.rank,
        style: {
          fontFamily: CardSkin.fontFamily,
          fontSize: CardSkin.centerFontSize,
          fill: color,
          fontWeight: "900",
        },
      });
      faceText.anchor.set(0.5);
      faceText.position.set(width / 2, height / 2);
      this.addChild(faceText);
    } else {
      this.drawPips(width, height, color);
    }

    this.drawPixelOutline(0, 0, width, height, cornerRadius, 71, 95);
  }

  /**
   * 沿指定矩形外缘画一圈"素材 1 像素"等粗的描边。
   *
   * 这里不用 Graphics.stroke，而是在素材像素尺寸上生成透明描边纹理，
   * 再用 nearest 放大到显示尺寸。这样全局 antialias 可以平滑几何边，
   * 但描边本身仍保持与卡牌素材一致的像素颗粒感。
   */
  private drawPixelOutline(
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number,
    sourceW: number,
    sourceH: number,
  ): void {
    const outlineColor = CONFIG.cardArt.outlineColor;
    const scaleX = w / sourceW;
    const scaleY = h / sourceH;
    const sourceRadius = radius / ((scaleX + scaleY) / 2);
    const outline = new Sprite(getPixelOutlineTexture(sourceW, sourceH, sourceRadius, outlineColor));
    outline.position.set(x, y);
    outline.width = w;
    outline.height = h;
    this.addChild(outline);
  }

  private drawPips(width: number, height: number, color: number): void {
    const rank = this.data.rank;
    const suit = this.data.suit;
    const fontSize = rank === "A" ? CardSkin.centerFontSize * 1.5 : CardSkin.centerFontSize * 0.6;

    const style = {
      fontFamily: CardSkin.fontFamily,
      fontSize: fontSize,
      fill: color,
      align: "center" as const,
    };

    const addPip = (x: number, y: number, flipY = false) => {
      const pip = new Text({ text: suit, style });
      pip.anchor.set(0.5);
      pip.position.set(width * x, height * y);
      if (flipY) pip.rotation = Math.PI;
      this.addChild(pip);
    };

    if (rank === "A") {
      addPip(0.5, 0.5);
    } else if (rank === "2") {
      addPip(0.5, 0.2); addPip(0.5, 0.8, true);
    } else if (rank === "3") {
      addPip(0.5, 0.2); addPip(0.5, 0.5); addPip(0.5, 0.8, true);
    } else if (rank === "4") {
      addPip(0.3, 0.2); addPip(0.7, 0.2);
      addPip(0.3, 0.8, true); addPip(0.7, 0.8, true);
    } else if (rank === "5") {
      addPip(0.3, 0.2); addPip(0.7, 0.2);
      addPip(0.5, 0.5);
      addPip(0.3, 0.8, true); addPip(0.7, 0.8, true);
    } else if (rank === "6") {
      addPip(0.3, 0.2); addPip(0.7, 0.2);
      addPip(0.3, 0.5); addPip(0.7, 0.5);
      addPip(0.3, 0.8, true); addPip(0.7, 0.8, true);
    } else if (rank === "7") {
      addPip(0.3, 0.2); addPip(0.7, 0.2);
      addPip(0.5, 0.35);
      addPip(0.3, 0.5); addPip(0.7, 0.5);
      addPip(0.3, 0.8, true); addPip(0.7, 0.8, true);
    } else if (rank === "8") {
      addPip(0.3, 0.2); addPip(0.7, 0.2);
      addPip(0.5, 0.35);
      addPip(0.3, 0.5); addPip(0.7, 0.5);
      addPip(0.5, 0.65, true);
      addPip(0.3, 0.8, true); addPip(0.7, 0.8, true);
    } else if (rank === "9") {
      addPip(0.3, 0.2); addPip(0.7, 0.2);
      addPip(0.3, 0.4); addPip(0.7, 0.4);
      addPip(0.5, 0.5);
      addPip(0.3, 0.6, true); addPip(0.7, 0.6, true);
      addPip(0.3, 0.8, true); addPip(0.7, 0.8, true);
    } else if (rank === "10") {
      addPip(0.3, 0.2); addPip(0.7, 0.2);
      addPip(0.5, 0.3);
      addPip(0.3, 0.4); addPip(0.7, 0.4);
      addPip(0.3, 0.6, true); addPip(0.7, 0.6, true);
      addPip(0.5, 0.7, true);
      addPip(0.3, 0.8, true); addPip(0.7, 0.8, true);
    }
  }

  /**
   * 读取最近一帧的卡牌位移速度模长（px/s）。
   *
   * 当前已无外部消费者：组 1 归位过冲改为距离驱动；组 2 急停信号
   * 直接读 pointerLastSampleSpeed。保留此函数与字段维护是为了未来的
   * 移动旋转 / 拖尾 / 调试可视化等可能用到 "卡牌每帧速度模长" 的场景。
   */
  public getLastSpeed(): number {
    return this.lastSpeedPxPerSec;
  }

  private getRootStage(): any {
    let root: any = this.parent;
    if (!root) return null;
    while (root.parent) {
      root = root.parent;
    }
    return root;
  }

  private onPointerDown(event: FederatedPointerEvent): void {
    if (event.button !== 0) return;

    this.dragData = event;
    this.dragStartTime = Date.now();
    this.dragMaxDistance = 0;
    this.cachePointerGlobal(event);
    // 按下瞬间立刻刷新本地坐标：拖拽中倾斜关闭，但保留 mouseLocal，
    // 便于松手后悬停倾斜无需等下一次 pointermove 即可接上。
    {
      const localPos = event.getLocalPosition(this);
      this.mouseLocalX = localPos.x;
      this.mouseLocalY = localPos.y;
      // 弹性绳锚点：按下时采样一次并锁定到 pointerup
      if (this.usesRopeDriver()) {
        const anchor = mapElasticRopeAnchorLocal(localPos.x, localPos.y);
        this.ropeMotion.setAnchorLocal(anchor.x, anchor.y);
      }
    }

    // 按下鼠标左键即刻进入拖拽态（按照需求：只要鼠标处于按下状态，就会进入拖拽态）
    this.isDragging = true;
    this.cardState = CardState.Dragging;
    this.callbacks.onDragStart?.(this);

    // 启动"进入拖拽"缩放动画：从当前 dragScaleMul 平滑过渡到 dragScaleTarget。
    // 从当前 mul 起步，保证从 hover/未完成的 out 动画中打断也无缝。
    {
      const dragConf = CONFIG.dragHandCard;
      const target = dragConf?.dragScaleTarget ?? 1.15;
      this.dragScaleAnim = "in";
      this.dragScaleProgress = 0;
      this.dragScaleFromMul = this.dragScaleMul;
      this.dragScaleToMul = target;
    }

    const parent = this.parent;
    if (parent) {
      const parentPos = event.getLocalPosition(parent);
      this.dragStartPointerX = parentPos.x;
      this.dragStartPointerY = parentPos.y;
    } else {
      this.dragStartPointerX = event.global.x;
      this.dragStartPointerY = event.global.y;
    }
    this.dragStartCardX = this.x;
    this.dragStartCardY = this.y;
    this.dragTargetX = this.x;
    this.dragTargetY = this.y;
    // 拖拽开始：把当前视觉角吸收为基角，绳相对角从 0 起算，避免接续时角跳变
    if (this.usesRopeDriver()) {
      this.moveTargetRotation = this.rotation;
      this.moveTargetX = this.x;
      this.moveTargetY = this.y;
      this.hasMoveTarget = true;
      this.ropeMotion.reset({ x: this.x, y: this.y, rotation: 0 });
      this.ropeMotion.setTarget(this.x, this.y);
    }
    // 拖拽起点同步速度采样基线，避免从静止到首帧位移被当成瞬时高速旋转。
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevSampled = true;
    this.velSmoothX = 0;
    this.velSmoothY = 0;

    // 监听 root stage 的指针移动与释放，并且在按下时临时将 stage.eventMode 设为 "static"，
    // 从而保证即便划过非交互背景区域时，全局 move 和 up 事件也能 100% 触发，不会出现卡死 or 松开不回弹。
    const stage = this.getRootStage();
    if (stage) {
      this.oldStageEventMode = stage.eventMode;
      stage.eventMode = "static";
      if (!stage.hitArea && stage.renderer) {
        stage.hitArea = stage.renderer.screen;
      }
      stage.on("pointermove", this.onPointerMove, this);
      stage.on("pointerup", this.onPointerUp, this);
      stage.on("pointerupoutside", this.onPointerUp, this);
    }
  }

  private onPointerMove(event: FederatedPointerEvent): void {
    if (!this.dragData) return;

    this.cachePointerGlobal(event);
    // 拖拽中持续更新本地坐标：倾斜虽关闭，松手瞬间仍有有效 mouseLocal 可立刻恢复悬停倾斜。
    this.refreshMouseLocalFromGlobal();

    // 当前鼠标在父容器坐标中的位置。
    let curX = 0;
    let curY = 0;
    const parent = this.parent;
    if (parent) {
      const parentPos = event.getLocalPosition(parent);
      curX = parentPos.x;
      curY = parentPos.y;
    } else {
      curX = event.global.x;
      curY = event.global.y;
    }

    // 累计相对起点的偏移量（dragMaxDistance 仍按"距点击位置"算，沿用原语义）。
    const dx = curX - this.dragStartPointerX;
    const dy = curY - this.dragStartPointerY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > this.dragMaxDistance) {
      this.dragMaxDistance = dist;
    }

    if (this.isDragging) {
      const newTargetX = this.dragStartCardX + dx;
      const newTargetY = this.dragStartCardY + dy;
      this.dragTargetX = newTargetX;
      this.dragTargetY = newTargetY;
      // 通知上层（GameController）：逻辑目标已更新；位姿由弹性绳在 update 中写。
      this.callbacks.onDragging?.(this, newTargetX, newTargetY);
    }
  }

  private onPointerUp(): void {
    if (!this.dragData) return;

    const duration = Date.now() - this.dragStartTime;
    this.dragData = null;
    
    // 从 root stage 注销监听器，恢复空闲状态且还原 stage.eventMode
    const stage = this.getRootStage();
    if (stage) {
      stage.off("pointermove", this.onPointerMove, this);
      stage.off("pointerup", this.onPointerUp, this);
      stage.off("pointerupoutside", this.onPointerUp, this);
      if (this.oldStageEventMode !== null) {
        stage.eventMode = this.oldStageEventMode;
        this.oldStageEventMode = null;
      }
    }

    this.isDragging = false;

    // 启动"退出拖拽"缩放动画：从当前 dragScaleMul 回到 1.0。
    {
      this.dragScaleAnim = "out";
      this.dragScaleProgress = 0;
      this.dragScaleFromMul = this.dragScaleMul;
      this.dragScaleToMul = 1.0;
    }

    // 获取配置中的快速点击时间阈值（卡牌操作逻辑专区：不受 gameSpeed 影响）
    const threshold = CONFIG.cardVisuals?.clickThresholdMS ?? 250;
    const distanceThreshold = CONFIG.cardVisuals?.clickDistanceThreshold ?? 10;

    if (duration <= threshold && this.dragMaxDistance <= distanceThreshold) {
      // 一定时间阈值与距离阈值内，快速抬起鼠标左键，且没有显著位移：
      // 视为一次"点击"——既可能把未选中的牌切到选中态，也可能把已选中的牌切回未选中。
      // 选中状态由 onClick 回调（GameController.toggleSelection）来翻转。
      this.callbacks.onClick(this);

      // 同步卡牌可视状态
      if (this.selected) {
        this.cardState = CardState.Selected;
      } else {
        this.cardState = this.isMouseOver ? CardState.Hovered : CardState.Normal;
      }

      // 短按选中 / 取消选中：鼠标通常未离开，没有新的 pointerover。
      // 必须强制把 hoverScale progress 打回 0，才能重播入场弹性（仅设 suppress 不够——
      // 短按时 progress 几乎没降，松手后仍停在稳态）。
      // forceImmediate：短按 dragScale 抬升有限，与弹性入场可叠加，立即重播更跟手。
      if (this.isMouseOver) {
        this.restartHoverScaleEntrance({ forceImmediate: true });
      }
      this.callbacks.onDragEnd?.(this);
    } else {
      // 超过时间或距离阈值松手：这是一次"慢点击/拖拽"，不构成有效点击操作。
      // 选中状态保持不变——选中和取消选中都只由"快速点击判定"决定，
      // 慢点击/拖拽不会顺手把已选中的卡取消掉。
      this.cardState = this.selected
        ? CardState.Selected
        : this.isMouseOver
          ? CardState.Hovered
          : CardState.Normal;

      // 长按/拖拽松手：重置 progress；若 dragScale 仍高则先 suppress，待 out 完成再入场。
      if (this.isMouseOver) {
        this.restartHoverScaleEntrance();
      }
      this.callbacks.onDragEnd?.(this);
    }
  }

  /**
   * 鼠标在卡上移动：把鼠标位置投影到卡牌本地坐标系（左上角为原点，单位像素）。
   *
   * 注意：必须把鼠标位置转换到 **未变形之前的卡面坐标系**——
   * 我们对 displayWrapper 应用 hoverScale + wobble rotation，对 mesh 应用 corner 透视；
   * mesh 的角点是以"原始矩形"为基准的，所以这里期望的鼠标坐标也是相对"原始矩形"。
   *
   * 由于 displayWrapper 的 transform（scale/rotation/breathing）作用在外层，
   * 而 `event.getLocalPosition(this)` 给出的是相对 CardView 自身的坐标，
   * 而 CardView 自身的 pivot 是 (W/2, H/2)、scale=1（外部由 tween 控制），
   * 这个本地坐标恰好就是原始未变形矩形的 (x, y)——直接使用即可。
   */
  private onHoverMove(event: FederatedPointerEvent): void {
    this.cachePointerGlobal(event);
    const localPos = event.getLocalPosition(this);
    this.mouseLocalX = localPos.x;
    this.mouseLocalY = localPos.y;
  }

  /** 缓存指针全局坐标，供选中位移等「无 pointermove」帧刷新本地坐标。 */
  private cachePointerGlobal(event: FederatedPointerEvent): void {
    this.lastPointerGlobalX = event.global.x;
    this.lastPointerGlobalY = event.global.y;
    this.hasLastPointerGlobal = true;
  }

  /**
   * 用缓存的全局指针位置投影到卡牌本地坐标。
   * 在 isMouseOver 或 isDragging 时调用：选中上移/下移时鼠标可能不动，
   * 必须每帧重算；悬停时供伪 3D 倾斜使用，拖拽时仍刷新坐标以便松手后立刻接上倾斜。
   */
  private refreshMouseLocalFromGlobal(): void {
    if (!this.hasLastPointerGlobal) return;
    if (!this.isMouseOver && !this.isDragging) return;
    const local = this.toLocal({
      x: this.lastPointerGlobalX,
      y: this.lastPointerGlobalY,
    });
    this.mouseLocalX = local.x;
    this.mouseLocalY = local.y;
  }

  /**
   * 强制重播触碰弹性缩放入场。
   *
   * 短按选中/取消选中后鼠标常不离开，没有新 pointerover；若只设 suppress 而不把
   * progress 打回 0，短按期间 progress 几乎不降，松手后仍停在稳态 → 看不到弹性。
   *
   * @param opts.forceImmediate 为 true 时立即入场（短按选中/取消：与 dragScale 可叠加）。
   *   默认 false：若 dragScaleMul > 1.02 先 suppress，等 dragScale out 完成后再入场
   *   （长按/拖拽松手，避免双重放大顿挫；out 结束时 updateDragScale 会清 suppress 并呼吸）。
   */
  private restartHoverScaleEntrance(opts?: { forceImmediate?: boolean }): void {
    this.hoverScaleProgress = 0;
    this.hoverScaleSettled = false;
    this.outOvershootActive = false;
    this.outOvershootProgress = 0;

    const immediate = opts?.forceImmediate === true || this.dragScaleMul <= 1.02;
    if (immediate) {
      this.suppressHoverScaleUntilReenter = false;
      this.triggerHoverBreathing();
    } else {
      this.suppressHoverScaleUntilReenter = true;
    }
  }

  /**
   * 视觉效果更新 Ticker
   */
  public update(dtMS: number): void {
    if (!this.contentContainer || !this.tiltMesh) return;

    // 如果首次烤纹理失败（例如 renderer 还没注入），每帧重试一次直到成功。
    if (!this.cardTexture) {
      this.bakeCardTexture();
    }

    // 0a. 速度旋转采样（rope external 时内部 early-return，旋转由绳写）
    this.updateMoveRotation(dtMS);

    // 0b. 拖拽目标同步（逻辑 dragTarget；坐标由绳或旧 lerp 写）
    this.updateDragging(dtMS);

    // 0c. 弹性绳积分：写 x/y/rotation（主场景 positionDriver=external）
    if (this.usesRopeDriver()) {
      this.stepElasticRope(dtMS);
    }

    // 0d. 结算弹簧（scoring 通道；在绳之后，不写 x/y）
    this.settleSpringTick?.(dtMS);

    this.updateDragScale(dtMS);

    // 归位完成判定（rope 在 stepElasticRope 内也会清 isReturning）
    if (this.isReturning && !this.isDragging && !this.usesRopeDriver()) {
      const dist = Math.hypot(this.x - this.layoutX, this.y - this.layoutY);
      if (dist < 2) {
        this.isReturning = false;
      }
    }

    // 1. 常态化的手牌的呼吸晃动
    this.updateBreathing(dtMS);

    // 1b. 鼠标触碰呼吸晃动（独立通道，叠加在常态之上）
    this.updateHoverBreathing(dtMS);

    // 1c. 选中上移/下移等外部 tween 改卡位时，鼠标可能不动 → 无 pointermove。
    //     每帧用缓存的全局坐标重投影到本地，保证伪 3D 倾斜与位移动画可叠加、不跳变。
    this.refreshMouseLocalFromGlobal();

    // 2. 鼠标悬停小弹性缩放
    this.updateHoverScale(dtMS);

    // 3. 卡牌伪3D倾斜：真实鼠标悬停时按鼠标位置倾斜；未悬停时由"常态伪3D倾斜呼吸晃动"
    //    通过虚拟鼠标产生缓慢的圆周倾斜。两种来源共用同一套投影公式与同一份目标角偏移，
    //    悬停一旦激活，呼吸态会自然让位（同 target，靠插值平滑切换）。
    //    拖拽中（isDragging）两种倾斜均关闭，目标角归零，避免悬空跟手时仍出现伪 3D 扭曲。
    this.updateMouse3DTilt(dtMS);

    // 3b. 抓牌翻面（绕竖中轴线翻面：背面 → 一条线 → 正面）。独立通道，仅在发牌后短暂激活。
    this.updateDrawFlip(dtMS);

    // 3c. 弃牌/出牌结束翻面（正面 → 飞行途中翻约 90° → 压成一条线）。仅在丢弃飞出时短暂激活。
    this.updateDiscardFlip(dtMS);

    // 4. 将计算后的效果应用到视觉容器
    this.applyVisuals();
  }

  /**
   * 卡牌移动旋转（velocity-based tilt）：根据卡牌实际移动速度产生符合直觉的拖尾旋转。
   *
   * 物理直觉：把卡牌想象成一张被钉子（轴点）插进中上部的纸片。钉子带着卡牌移动时，
   * 卡牌不会刚性地随钉子平移，而是会以钉孔为支点产生轻微的拖尾旋转——
   *   - 水平移动产生明显旋转（钉孔到质心的连线垂直于运动方向，有最大力臂）；
   *   - 沿"钉孔→质心"方向（这里是垂直方向）的移动几乎不产生旋转（无力臂）。
   *
   * 实现：把瞬时位移分解到"与轴点-中心连线垂直"的方向上，作为有效速度 vEffective；
   * 再线性映射到目标旋转角并夹到 ±maxRotationRad。velocityRotation 用 followLerp 追目标，
   * 同时每帧受 friction 持续向 0 衰减——这两个机制叠加形成"刚开始动→快速跟到目标→
   * 持续运动时维持→停下后自然回正"的观感。
   *
   * 重要：本函数只更新 velocityRotation 这一个状态量。最终把它转化为
   * "绕轴点旋转的视觉效果"是在 applyVisuals() 中通过位置补偿完成的——
   * 这样可以保持 displayWrapper 几何 pivot 不变（中心），不污染其他效果。
   */
  private updateMoveRotation(dtMS: number): void {
    const cfg = CONFIG.cardMoveRotation;

    // external：旋转由弹性绳等外核写 this.rotation，禁止 velocityRotation 覆盖。
    if (this.positionDriver === "external") {
      this.velocityRotation = 0;
      this.velSmoothX = 0;
      this.velSmoothY = 0;
      this.prevX = this.x;
      this.prevY = this.y;
      this.prevSampled = true;
      return;
    }

    // 弃牌飞行期：禁用速度→旋转联动，让卡牌保持飞出瞬间设定的随机旋转角度。
    // 速度旋转直接置零；同时维护 prev/lastSpeed，避免弃牌结束后第一帧速度爆冲。
    if (this.discardFlying) {
      this.velocityRotation = 0;
      this.velSmoothX = 0;
      this.velSmoothY = 0;
      if (!this.prevSampled) {
        this.prevSampled = true;
      } else if (dtMS > 0) {
        const vx = (this.x - this.prevX) / dtMS;
        const vy = (this.y - this.prevY) / dtMS;
        this.lastSpeedPxPerSec = Math.hypot(vx, vy) * 1000;
      }
      this.prevX = this.x;
      this.prevY = this.y;
      return;
    }

    if (!cfg || !cfg.enabled || dtMS <= 0) {
      // 关闭或时间步无效时，平滑回零（不直接置零，避免开关切换的瞬间跳变）。
      this.velocityRotation *= 0.85;
      if (Math.abs(this.velocityRotation) < 1e-4) this.velocityRotation = 0;
      this.velSmoothX *= 0.85;
      this.velSmoothY *= 0.85;
      // 首次进入时仍要把 prev 同步到当前 x/y，避免之后再开启时第一次速度爆冲。
      if (!this.prevSampled) {
        this.prevX = this.x;
        this.prevY = this.y;
        this.prevSampled = true;
      } else if (dtMS > 0) {
        // 即便旋转关了，也要维护 lastSpeedPxPerSec —— moveToWithOvershoot 的触发阈值依赖它。
        const vx = (this.x - this.prevX) / dtMS;
        const vy = (this.y - this.prevY) / dtMS;
        this.lastSpeedPxPerSec = Math.hypot(vx, vy) * 1000;
        this.prevX = this.x;
        this.prevY = this.y;
      }
      return;
    }

    // 首帧初始化：不计算速度，直接同步 prev 后跳出。
    if (!this.prevSampled) {
      this.prevX = this.x;
      this.prevY = this.y;
      this.prevSampled = true;
      this.lastSpeedPxPerSec = 0;
      this.velSmoothX = 0;
      this.velSmoothY = 0;
      return;
    }

    // 帧率归一化系数：以 16.67ms（60fps）为基准，dt 越大每帧应用的衰减/插值越多。
    const frameScale = dtMS / 16.6667;

    // 1. 瞬时速度（px/ms）。
    //    prevX/prevY 是"上一帧 update 入口"看到的位置；this.x/this.y 是"本帧 update 入口"
    //    看到的位置。两次入口之间完整覆盖了一帧——包括上一帧 update 内部 updateDragging
    //    对 this.x 的写入，也包括两帧之间外部 tween（CardFx.moveTo / selectMove / flyOut）
    //    经由 TweenManager.update() 对 this.x 的写入。所以这里采样的是真正的
    //    "每帧位移"，能稳定捕获 drag、归位 tween、未来的发牌弃牌等一切移动来源。
    //
    //    关键时序：必须在 updateDragging 之前采样（否则当前帧的 updateDragging 写入会被
    //    算到下一帧的 prev → 实际等于把本帧 drag 位移整个吃掉，vx 永远 ≈ 0）。
    //    我们在 update() 主体最早一步就调用了 updateMoveRotation，正好满足此前提。
    const rawVx = (this.x - this.prevX) / dtMS;
    const rawVy = (this.y - this.prevY) / dtMS;

    // 顺便更新"上一帧速度模长（px/s）"——供 CardFx.moveToWithOvershoot 等
    // "判断当前速度是否达到过冲阈值"的逻辑读取。用原始差分（非 EMA），
    // 保证过冲触发阈值仍反映真实位移强度，不被平滑滞后污染。
    this.lastSpeedPxPerSec = Math.hypot(rawVx, rawVy) * 1000;

    // 采样完立刻 snapshot 当前位置作为下一帧的 prev。
    // （之前的实现把 snapshot 放到 update 出口，会导致"出口→下一帧入口"之间
    // 没有任何 x 写入，差分始终为 0——这是个隐蔽 bug。）
    this.prevX = this.x;
    this.prevY = this.y;

    // 1b. 对旋转用速度做 EMA：拖拽时 this.x 由 lerp+maxStep 推进，目标点又由
    //     pointermove 异步跳变；再叠加 rAF 的 dt 抖动，单帧 raw vx 会在「顶速 /
    //     追赶中 / 几乎贴手」之间跳。直接映射到 targetRot 就会出现旋转角闪抖。
    //     lastSpeed 仍用 raw；只有视觉旋转跟平滑速度。
    const smoothMS = Math.max(0, cfg.velocitySmoothMS ?? 36);
    let vx: number;
    let vy: number;
    if (smoothMS > 0) {
      const alpha = 1 - Math.exp(-dtMS / smoothMS);
      this.velSmoothX += (rawVx - this.velSmoothX) * alpha;
      this.velSmoothY += (rawVy - this.velSmoothY) * alpha;
      vx = this.velSmoothX;
      vy = this.velSmoothY;
    } else {
      this.velSmoothX = rawVx;
      this.velSmoothY = rawVy;
      vx = rawVx;
      vy = rawVy;
    }

    // 2. 方向投影：把速度投影到"与 (pivotOffsetX, pivotOffsetY) 向量垂直"的方向上。
    //    设 d = (ox, oy) 是从几何中心指向轴点的向量。
    //    若 d 是非零向量，其垂直方向单位向量为 perp = (-oy, ox) / |d|。
    //    钉子带动卡牌平移时，沿 d 方向的速度分量没有力臂（不产生旋转），
    //    沿 perp 方向的速度分量贡献全部旋转。这天然实现了用户要求的
    //    "轴点在中上部时，垂直拖动几乎不旋转、水平拖动旋转最明显"。
    //    当 d 退化为 0（轴点在几何中心）时，回退为只使用 vx——保持有意义的水平偏转。
    const ox = cfg.pivotOffsetX;
    const oy = cfg.pivotOffsetY;
    const dLen = Math.hypot(ox, oy);
    let vEffective: number;
    if (dLen > 1e-3) {
      // perp = (-oy, ox) / dLen
      vEffective = (-oy * vx + ox * vy) / dLen;
    } else {
      vEffective = vx;
    }

    // 3. 最小速度阈值过滤微抖动。
    if (Math.abs(vEffective) < cfg.minSpeed) {
      vEffective = 0;
    }

    // 4. 映射到目标旋转角并截断。
    //    maxRot 是派生上限：由"卡牌追踪速度上限 (CONFIG.dragHandCard.maxSpeed, px/s)"
    //    和 rotationPerSpeed (rad/(px/ms)) 计算得到——即"卡牌达到最高速度时产生的旋转角"。
    //    这样做的好处：当速度上限或速度系数任一改变时，旋转幅度上限自动匹配，
    //    避免手填值与速度上限失配造成的"打不到上限"或"长期被截断"等死区。
    //    实际截断仍然保留作为安全网（vEffective 来自 updateDragging 的位置差分，
    //    理论上不会超过 maxSpeed/1000，但其他移动源如 tween 突变时可能瞬时超出）。
    const rotK = (isDrawingCards && cfg.drawRotationPerSpeed !== undefined) ? cfg.drawRotationPerSpeed : cfg.rotationPerSpeed;
    let targetRot = vEffective * rotK;
    const maxRot = computeMaxRot(this);
    if (targetRot > maxRot) targetRot = maxRot;
    else if (targetRot < -maxRot) targetRot = -maxRot;

    // 5. 驱动 velocityRotation。
    //    仍在有效移动 → 只 follow；已停住 → follow 到 0 并 friction 回正。
    //    （主场景 external 已 early-return；本路径仅 internal 遗留。）
    const lerpRaw = Math.max(0, Math.min(1, cfg.followLerp));
    const followAlpha = 1 - Math.pow(1 - lerpRaw, frameScale);
    const frictionRaw = Math.max(0, Math.min(1, cfg.friction));
    const frictionAlpha = frictionRaw > 0 ? 1 - Math.pow(1 - frictionRaw, frameScale) : 0;
    const moving = vEffective !== 0;

    this.velocityRotation += (targetRot - this.velocityRotation) * followAlpha;
    if (!moving && frictionAlpha > 0) {
      this.velocityRotation *= 1 - frictionAlpha;
    }

    // 6. 微量裁剪：避免长期 1e-7 量级的浮点尾巴持续耗算。
    if (Math.abs(this.velocityRotation) < 1e-5) {
      this.velocityRotation = 0;
    }
  }

  /**
   * 拖拽中：不写 x/y（由弹性绳 step 写）。
   * 每帧仍回调 onDragging，使鼠标静止、牌仍在追赶时也能完成换位判定。
   */
  private updateDragging(dtMS: number): void {
    if (!this.isDragging || dtMS <= 0) return;
    this.callbacks.onDragging?.(this, this.dragTargetX, this.dragTargetY);
  }

  /**
   * 推进"进入/退出拖拽"的缩放动画。
   * 进入：dragScaleMul 从 1（或当前值）→ dragScaleTarget，受 dragScaleInCurve 控制。
   * 退出：dragScaleMul 从当前值 → 1，受 dragScaleOutCurve 控制。
   * 该乘数会在 applyVisuals 中与 currentScale 相乘，从而与 hover 等其他缩放复合。
   */
  private updateDragScale(dtMS: number): void {
    if (this.dragScaleAnim === null) return;

    const dragConf = CONFIG.dragHandCard;
    const durationMS = scaleTimeMS(
      this.dragScaleAnim === "in"
        ? (dragConf?.dragScaleInDurationMS ?? 180)
        : (dragConf?.dragScaleOutDurationMS ?? 180),
    );

    if (durationMS <= 0) {
      // 时长为 0：瞬间到位
      const wasOut = this.dragScaleAnim === "out";
      this.dragScaleMul = this.dragScaleToMul;
      this.dragScaleAnim = null;
      if (wasOut) {
        // 卡牌完全回落：解除 pointerup 后的 hoverScale 抑制（短按选中/取消或长按），
        // 并触发一次鼠标呼吸晃动。
        this.suppressHoverScaleUntilReenter = false;
        this.triggerHoverBreathing();
      }
      return;
    }

    this.dragScaleProgress = Math.min(1, this.dragScaleProgress + dtMS / durationMS);

    const curve =
      this.dragScaleAnim === "in"
        ? dragConf?.dragScaleInCurve
        : dragConf?.dragScaleOutCurve;

    // 注意：sampleCurve 在 curve.enabled=false 时返回 1（即立即吸附到终点），
    // 这是与 hoverScale 一致的"禁用曲线 = 跳过缓动"语义。
    const t = curve ? sampleCurve(curve, this.dragScaleProgress) : this.dragScaleProgress;
    this.dragScaleMul = this.dragScaleFromMul + (this.dragScaleToMul - this.dragScaleFromMul) * t;

    if (this.dragScaleProgress >= 1) {
      const wasOut = this.dragScaleAnim === "out";
      this.dragScaleMul = this.dragScaleToMul;
      this.dragScaleAnim = null;
      // "退出拖拽缩放"动画刚刚完成：卡牌从放大态完全回落到 1.0 的瞬间，
      // (1) 解除 pointerup 后的 hoverScale 抑制（短按选中/取消选中，或长按/慢点击）——
      //     让 hoverScale 从这一刻起按 cardState 重新入场放大（若鼠标仍在卡上），
      //     从而重播触碰弹性缩放。
      // (2) 触发一次"鼠标触碰呼吸晃动"——这是"鼠标呼吸晃动（触碰与回落）"专区的第二个触发点。
      //     与 pointerover 共用同一参数集，因此动画风格与"鼠标进入卡牌时"完全一致。
      if (wasOut) {
        this.suppressHoverScaleUntilReenter = false;
        this.triggerHoverBreathing();
      }
    }
  }

  /**
   * 触发一次"鼠标触碰呼吸晃动"脉冲（一次性脱手动画）。
   *
   * 同一个触发点被两处复用：
   *   1. pointerover：鼠标进入卡牌时；
   *   2. 拖拽缩放退出动画完成时（dragScaleMul 从 dragScaleTarget 回到 1.0 的瞬间）——
   *      参数面板中"鼠标呼吸晃动（触碰与回落）"专区的第二个触发点。
   *
   * 每次触发都重置进度与两个独立相位，从满幅度起跳，可打断上一次未播完的脉冲。
   * 配置未启用或时长无效时静默跳过。
   */
  private triggerHoverBreathing(): void {
    const conf = CONFIG.cardVisuals;
    if (!this.isVisualEnabled("hoverBreathing")) return;
    if ((conf?.hoverBreathingDurationMS ?? 0) <= 0) return;
    this.hoverBreathingActive = true;
    this.hoverBreathingProgress = 0;
    this.hoverBreathTime = 0;
    this.hoverWobbleTime = 0;
  }

  private updateBreathing(dtMS: number): void {
    const visualConf = CONFIG.cardVisuals;
    if (!visualConf || !this.isVisualEnabled("breathing")) {
      this.breathingY = 0;
      this.wobbleRot = 0;
      return;
    }

    // 常态呼吸晃动：纯由时间驱动，不受 hover / 拖拽 通道影响。
    // 拖拽位置作用在卡牌根节点，常态呼吸作用在内层 displayWrapper，
    // 两者独立叠加，因此拖拽时仍保留常态呼吸不会引起抖动。
    this.breathingTime += dtMS * visualConf.breathingSpeed;
    this.wobbleTime += dtMS * visualConf.wobbleSpeed;

    this.breathingY = Math.sin(this.breathingTime) * visualConf.breathingAmplitude;
    this.wobbleRot = Math.cos(this.wobbleTime) * visualConf.wobbleAmplitude;
  }

  /**
   * 推进鼠标触碰呼吸晃动（独立通道）。
   *
   * 这是一段完全独立于常态呼吸晃动的"脱手式"动画：触发瞬间幅度最大，
   * 随时间按指数包络 exp(-decay * progress) 衰减到接近 0，
   * progress 到达 1 时整段动画结束，hover 通道完全归零。
   *
   * 输出 hoverBreathingY / hoverWobbleRot 会在 applyVisuals 中与常态值相加叠加，
   * 因此与常态呼吸晃动相互独立、互不干扰。
   */
  private updateHoverBreathing(dtMS: number): void {
    const conf = CONFIG.cardVisuals;
    const hoverBreathingOn = this.isVisualEnabled("hoverBreathing");

    // 总开关关闭、拖拽中或未激活：直接清零 hover 通道，但不影响常态呼吸。
    if (
      !conf ||
      !hoverBreathingOn ||
      this.cardState === CardState.Dragging ||
      !this.hoverBreathingActive
    ) {
      this.hoverBreathingY = 0;
      this.hoverWobbleRot = 0;
      // 关闭/中断时顺便复位 active，避免下次开启后残留脉冲。
      if (!hoverBreathingOn) {
        this.hoverBreathingActive = false;
      }
      return;
    }

    const dur = Math.max(1, conf.hoverBreathingDurationMS ?? 1);
    this.hoverBreathingProgress += dtMS / dur;
    if (this.hoverBreathingProgress >= 1) {
      // 动画结束：彻底清零
      this.hoverBreathingActive = false;
      this.hoverBreathingProgress = 0;
      this.hoverBreathingY = 0;
      this.hoverWobbleRot = 0;
      return;
    }

    // 两条独立的指数衰减包络：
    //   speedEnv = exp(-speedDecay * progress)  → 缩放相位累加速度（频率随时间变慢）
    //   ampEnv   = exp(-ampDecay   * progress)  → 缩放幅度（每帧 sin/cos 输出按比例变小）
    // 同时衰减速度和幅度，避免出现"恒频高速振荡 + 幅度被生硬压扁"的截断观感。
    const speedDecay = Math.max(0, conf.hoverBreathingSpeedDecay ?? 0);
    const ampDecay = Math.max(0, conf.hoverBreathingAmplitudeDecay ?? 0);
    const speedEnv = Math.exp(-speedDecay * this.hoverBreathingProgress);
    const ampEnv = Math.exp(-ampDecay * this.hoverBreathingProgress);

    // 独立相位累加：速率随时间衰减，因此振荡频率会随 progress 增长逐渐放慢
    this.hoverBreathTime += dtMS * (conf.hoverBreathingSpeed ?? 0) * speedEnv;
    this.hoverWobbleTime += dtMS * (conf.hoverWobbleSpeed ?? 0) * speedEnv;

    this.hoverBreathingY = Math.sin(this.hoverBreathTime) * (conf.hoverBreathingAmplitude ?? 0) * ampEnv;
    this.hoverWobbleRot = Math.cos(this.hoverWobbleTime) * (conf.hoverWobbleAmplitude ?? 0) * ampEnv;
  }

  private updateHoverScale(dtMS: number): void {
    const visualConf = CONFIG.cardVisuals;
    if (!visualConf || !this.isVisualEnabled("hoverScale")) {
      this.currentScale = 1.0;
      this.hoverScaleProgress = 0;
      this.hoverScaleSettled = false;
      this.outOvershootActive = false;
      this.outOvershootProgress = 0;
      // 立即把 displayWrapper 恢复到 1.0 缩放（applyVisuals 当帧也会同步，但这里保险一下）。
      this.displayWrapper?.scale.set(1.0);
      return;
    }

    // 如果鼠标在这个牌上游走 (Hovered) 或者是点击选中态且有鼠标悬停 (Selected + isMouseOver)。
    // 但若 pointerup 后压下了"抑制再次放大"标志（短按选中/取消选中，或长按/慢点击松手），
    // 则即便 cardState=Hovered/Selected 也按未悬停处理：走平滑回缩分支、与 dragScaleMul
    // 同步回到 1.0；待 suppress 解除后再重新入场，从而重播触碰弹性缩放。
    const isHovered =
      !this.suppressHoverScaleUntilReenter &&
      (this.cardState === CardState.Hovered || (this.isMouseOver && this.cardState === CardState.Selected));

    if (isHovered) {
      // 鼠标重新进入：取消正在进行的过弹回缩，回到入场分支。
      // 注意 progress 不重置（如果还有残余 progress 就接着涨）。
      if (this.outOvershootActive) {
        this.outOvershootActive = false;
        this.outOvershootProgress = 0;
      }

      // 触碰悬停：向 1 递增 progress
      if (this.hoverScaleProgress < 1) {
        const duration = visualConf.hoverScaleDurationMS || 250;
        this.hoverScaleProgress = Math.min(1, this.hoverScaleProgress + dtMS / duration);
        if (this.hoverScaleProgress >= 1) {
          // 入场动画达到饱和点，标记为"正常完结"。
          this.hoverScaleSettled = true;
        }
      }

      const curve = visualConf.hoverScaleCurve;
      // 采样曲线
      const y = sampleCurve(curve, this.hoverScaleProgress);

      const overshoot = visualConf.hoverOvershootScale;
      const settle = visualConf.hoverSettleScale;
      // 极值点数量 N：1=经典一次过弹；>=2 时引入阻尼振荡（首峰、谷、次峰、…）。
      const N = Math.max(1, Math.floor(visualConf.hoverOvershootCount ?? 1));
      // 阻尼因子 damping∈(0,1]：每过一个极值振幅乘以此因子。仅 N>=2 生效。
      const damping = Math.min(1, Math.max(0.0001, visualConf.hoverOvershootDamping ?? 0.5));

      if (overshoot > settle && settle > 1.0) {
        // 阻尼正弦振荡过弹模型：
        //   base(y) = 1 + (settle - 1) · y                    // 线性基线：1.0 → settle
        //   phase(y) = N · π · y                              // y=0:0, y=1:Nπ，起止 sin=0
        //   极值点位于 y_k = (2k-1)/(2N), k=1..N
        //   envelope(y) = damping^(N·y - 0.5)                 // 在 y_k 处恰为 damping^(k-1)
        //   amp0 由首峰 = overshoot 反推：amp0 = overshoot - base(y_1)
        //   s(y) = base(y) + amp0 · envelope(y) · sin(phase)
        const y1 = 1 / (2 * N);                                // 首峰位置
        const baseY1 = 1.0 + (settle - 1.0) * y1;
        const amp0 = overshoot - baseY1;
        const phase = N * Math.PI * y;
        // envelope = damping^(N·y - 0.5)。N·y - 0.5 在 y=0 时是 -0.5，会让 envelope > 1，
        // 但此处 sin(phase=0)=0，osc 仍为 0，不影响起点。
        const envelope = Math.pow(damping, N * y - 0.5);
        const base = 1.0 + (settle - 1.0) * y;
        this.currentScale = base + amp0 * envelope * Math.sin(phase);
      } else {
        // 退化分支：overshoot 未真正大于 settle，普通插值
        const s = typeof settle === "number" ? settle : 1.05;
        this.currentScale = 1.0 + (s - 1.0) * y;
      }
    } else {
      // ── 离开分支 ──────────────────────────────────────────────
      // 如果离开瞬间入场动画尚未播完（hoverScaleSettled=false）且配置了过弹次数 >= 1，
      // 走"阻尼正弦振荡回缩过弹"；否则走原来的平滑插值回缩。

      const outN = Math.max(0, Math.floor(visualConf.hoverScaleOutOvershootCount ?? 0));

      // 触发判定：仅在尚未进入过弹回缩、入场动画未播至完结（!hoverScaleSettled）、
      // 且本次确实有入场进度（progress > 0）时启动过弹回缩。
      // 正常停留至稳态后再移开，hoverScaleSettled=true 会一直保持到本周期 progress 归零，
      // 整个回缩期间持续走原平滑回缩，不会被误触发过弹。
      // 注意：hoverScaleSettled 不在此处清零；在平滑回缩 progress 减到 0 时统一清零。
      if (!this.outOvershootActive && !this.hoverScaleSettled && this.hoverScaleProgress > 0 && outN >= 1) {
        this.outOvershootActive = true;
        this.outOvershootProgress = 0;
        this.outOvershootStartScale = this.currentScale;
        // 立即停止入场 progress 的统计（避免回缩期间被误判为"未被打断"）
        this.hoverScaleProgress = 0;
      }

      if (this.outOvershootActive) {
        // ── 阻尼振荡回缩（围绕 1.0 振动，首峰目标可参数化）──
        // y: 0 → 1，按 hoverScaleOutDurationMS 推进
        const duration = visualConf.hoverScaleOutDurationMS || 150;
        this.outOvershootProgress = Math.min(1, this.outOvershootProgress + dtMS / duration);
        const y = this.outOvershootProgress;

        const N = Math.max(1, outN);
        const damping = Math.min(1, Math.max(0.0001, visualConf.hoverScaleOutOvershootDamping ?? 0.5));
        const startScale = this.outOvershootStartScale;
        const firstScale = visualConf.hoverScaleOutOvershootFirstScale ?? 0.97;

        // 极值序列 peak[k] (k=0..N)：
        //   peak[0] = startScale                                    // 起点
        //   peak[1] = firstScale                                    // 首次过缩目标（用户参数，绝对 scale 值）
        //   peak[k] = 1 + (firstScale - 1) · (-1)^(k-1) · damping^(k-1)   // 后续按 damping 衰减并左右穿越 1.0
        //   peak[N] = 1.0                                           // 终点钉死
        // 相邻极值之间用 (1 - cos(π·t))/2 余弦平滑过渡。
        const k = Math.min(N - 1, Math.floor(N * y));               // 当前所在区间索引 [k, k+1]
        const t = N * y - k;                                        // 区间内进度 0~1

        const peakAt = (idx: number): number => {
          if (idx <= 0) return startScale;
          if (idx >= N) return 1.0;
          // idx >= 1：从首峰起每步按 damping 衰减、符号交替穿越 1.0。
          // idx=1: 系数 +1 → 1 + (firstScale - 1) = firstScale  ✓
          // idx=2: 系数 -1·damping → 落到 1 的对侧并衰减
          const sign = (idx - 1) % 2 === 0 ? 1 : -1;
          const mag = (firstScale - 1.0) * Math.pow(damping, idx - 1);
          return 1.0 + sign * mag;
        };

        const a = peakAt(k);
        const b = peakAt(k + 1);
        const smoothT = (1 - Math.cos(Math.PI * t)) / 2;
        this.currentScale = a + (b - a) * smoothT;

        if (this.outOvershootProgress >= 1) {
          // 收尾：钉死到 1.0，退出过弹回缩态。
          // 本次悬停周期结束，清掉"完结"标志，准备下一次悬停从头开始。
          this.currentScale = 1.0;
          this.outOvershootActive = false;
          this.outOvershootProgress = 0;
          this.hoverScaleSettled = false;
        }
      } else {
        // ── 原平滑回缩 ──
        if (this.hoverScaleProgress > 0) {
          const duration = visualConf.hoverScaleOutDurationMS || 150;
          this.hoverScaleProgress = Math.max(0, this.hoverScaleProgress - dtMS / duration);
          if (this.hoverScaleProgress <= 0) {
            // 平滑回缩完成（progress 归零）。本次悬停周期结束，清掉"完结"标志。
            this.hoverScaleSettled = false;
          }
        }
        const targetScale = 1.0;
        const speed = visualConf.hoverScaleOutSpeed || 0.15;
        this.currentScale += (targetScale - this.currentScale) * speed * (dtMS / 16.67);
      }
    }
  }

  /**
   * 计算 4 角偏移（伪 3D 翻折）。
   *
   * 数学模型：
   *   把卡牌视为厚度为零的 3D 平板，4 个角处于平面 z=0。
   *   鼠标位置即"按下点"。**离鼠标越近的角向 +z（屏幕里、背景方向）凹陷，
   *   越远的角向 -z（屏幕外）凸起**。
   *
   *   然后用透视投影 (x', y') = center + (x - center) * focal / (focal + z)
   *   投影到 2D 平面，得到 4 角的视觉位移。
   *
   *   z > 0  -> 分母大 -> 角靠向中心 -> 看起来"远" = 凹陷 ✓
   *   z < 0  -> 分母小 -> 角远离中心 -> 看起来"近" = 凸出 ✓
   *
   * 这是真正的 3D 翻折投影，能 100% 复现你描述的"鼠标处下压 / 对角抬起"视觉。
   */
  private updateMouse3DTilt(dtMS: number): void {
    const visualConf = CONFIG.cardVisuals;
    const W = CardSkin.width;
    const H = CardSkin.height;

    // 真实鼠标 3D 倾斜：仅悬停、且非拖拽时开启。
    // Selected / 选中上移仍可与倾斜叠加；拖拽（含悬空跟手）必须关闭，
    // 否则鼠标停在牌上会持续驱动角点扭曲，出现「拖着不动也在倾斜」。
    // 归零走下方 target→current 平滑插值，松手后接回悬停倾斜不会硬切。
    // 小丑牌通过 isVisualEnabled 叠加 CONFIG.joker.effects 门控。
    const hoverActive =
      !!visualConf &&
      this.isVisualEnabled("mouse3DTilt") &&
      !this.isDragging &&
      this.isMouseOver &&
      this.mouseLocalX !== null &&
      this.mouseLocalY !== null;

    // 常态伪 3D 倾斜呼吸：仅当真实悬停未激活、且非拖拽时起效。
    // 拖拽中牌跟手，呼吸倾斜会与拖拽位姿打架，故排除 isDragging。
    const idleActive =
      !hoverActive &&
      !!visualConf &&
      this.isVisualEnabled("idleTilt") &&
      !this.isDragging &&
      (this.cardState === CardState.Normal ||
        this.cardState === CardState.Hovered ||
        this.cardState === CardState.Selected);

    // 推进常态倾斜呼吸的相位（即便当前未激活也持续走时，避免重新激活时相位跳变）
    if (visualConf) {
      this.idleTiltTime += dtMS * (visualConf.idleTiltSpeed ?? 0.0008);
    }

    // 计算 4 角"目标"偏移
    if (hoverActive) {
      let strength = visualConf!.mouse3DTiltStrength ?? 2.0;
      // 左右倾斜幅度梯度：按手牌位置 t = i/(n-1) 在 LeftMul ~ RightMul 间线性插值，
      // 乘到基础 strength 上。n<=1 时 t=0.5。仅作用于真实鼠标悬停的伪 3D 倾斜。
      if (visualConf!.mouse3DTiltGradientEnabled) {
        const n = this.handCount;
        const t = n > 1 ? this.handIndex / (n - 1) : 0.5;
        const leftMul = visualConf!.mouse3DTiltStrengthLeftMul ?? 0.3;
        const rightMul = visualConf!.mouse3DTiltStrengthRightMul ?? 1.0;
        const tClamped = Math.min(1, Math.max(0, t));
        const mul = leftMul + (rightMul - leftMul) * tClamped;
        strength *= mul;
      }
      this.computeTiltTargetFromMouse(this.mouseLocalX!, this.mouseLocalY!, strength);
    } else if (idleActive) {
      // 用时间驱动一个"虚拟鼠标"在卡牌中心附近做缓慢的椭圆轨迹运动，
      // 复用与 mouse3DTilt 完全相同的投影公式，得到呼吸般的伪 3D 倾斜。
      const radius = Math.max(0, Math.min(1, visualConf!.idleTiltRadius ?? 0.55));
      const t = this.idleTiltTime;
      // 椭圆运动：x 用 sin，y 用 cos 并乘以略低的比率，避免完美正圆显得机械
      const cx = W / 2;
      const cy = H / 2;
      const rx = (W / 2) * radius;
      const ry = (H / 2) * radius;
      const vmx = cx + Math.sin(t) * rx;
      const vmy = cy + Math.cos(t * 0.85) * ry;
      const strength = visualConf!.idleTiltStrength ?? 0.6;
      this.computeTiltTargetFromMouse(vmx, vmy, strength);
    } else {
      this.targetCornerOffset.tlX = 0; this.targetCornerOffset.tlY = 0;
      this.targetCornerOffset.trX = 0; this.targetCornerOffset.trY = 0;
      this.targetCornerOffset.brX = 0; this.targetCornerOffset.brY = 0;
      this.targetCornerOffset.blX = 0; this.targetCornerOffset.blY = 0;
    }

    // 平滑插值：current -> target
    // 由 cardVisuals.mouse3DTiltSmoothEnabled / mouse3DTiltSmoothing 控制：
    //   - 关闭平滑：k = 1，瞬时跳到目标角度，无过渡。
    //   - 启用平滑：k = clamp(speed * dt/16.67, 0..1)，帧率无关的指数 lerp。
    // 老 preset 无这两字段时按"启用 + 0.15"兜底，保持原行为。
    const smoothEnabled = visualConf?.mouse3DTiltSmoothEnabled ?? true;
    let k: number;
    if (!smoothEnabled) {
      k = 1;
    } else {
      const speed = visualConf?.mouse3DTiltSmoothing ?? 0.15;
      k = Math.min(1, Math.max(0, speed * (dtMS / 16.67)));
    }
    this.currentCornerOffset.tlX += (this.targetCornerOffset.tlX - this.currentCornerOffset.tlX) * k;
    this.currentCornerOffset.tlY += (this.targetCornerOffset.tlY - this.currentCornerOffset.tlY) * k;
    this.currentCornerOffset.trX += (this.targetCornerOffset.trX - this.currentCornerOffset.trX) * k;
    this.currentCornerOffset.trY += (this.targetCornerOffset.trY - this.currentCornerOffset.trY) * k;
    this.currentCornerOffset.brX += (this.targetCornerOffset.brX - this.currentCornerOffset.brX) * k;
    this.currentCornerOffset.brY += (this.targetCornerOffset.brY - this.currentCornerOffset.brY) * k;
    this.currentCornerOffset.blX += (this.targetCornerOffset.blX - this.currentCornerOffset.blX) * k;
    this.currentCornerOffset.blY += (this.targetCornerOffset.blY - this.currentCornerOffset.blY) * k;
  }

  /**
   * 共用的角点投影计算：给定卡牌本地坐标系中的一个"鼠标位置" (mx, my) 和强度，
   * 用与 mouse3DTilt 完全相同的透视投影模型，写入 this.targetCornerOffset。
   *
   * 由 updateMouse3DTilt（真实鼠标）和常态伪3D倾斜呼吸（虚拟鼠标）共同使用，
   * 这样能确保两种倾斜的视觉模型 100% 一致。
   */
  private computeTiltTargetFromMouse(mx: number, my: number, strength: number): void {
    const W = CardSkin.width;
    const H = CardSkin.height;

    // 把"强度"转换成 z 深度的最大幅度（像素）。strength=2.0 -> 约 28 像素。
    const zMax = strength * 14;
    // 焦距：越大透视越温和，越小越夸张。
    const focal = 240;

    const corners: Array<{ x: number; y: number; key: "tl" | "tr" | "br" | "bl" }> = [
      { x: 0, y: 0, key: "tl" },
      { x: W, y: 0, key: "tr" },
      { x: W, y: H, key: "br" },
      { x: 0, y: H, key: "bl" },
    ];

    const diag = Math.hypot(W, H);
    const cx = W / 2;
    const cy = H / 2;

    for (const c of corners) {
      const d = Math.hypot(c.x - mx, c.y - my);
      const t = d / diag;
      const z = zMax * (1 - 2 * t);
      const denom = focal + z;
      const k = focal / denom;
      const projX = cx + (c.x - cx) * k;
      const projY = cy + (c.y - cy) * k;
      const dx = projX - c.x;
      const dy = projY - c.y;

      if (c.key === "tl") { this.targetCornerOffset.tlX = dx; this.targetCornerOffset.tlY = dy; }
      else if (c.key === "tr") { this.targetCornerOffset.trX = dx; this.targetCornerOffset.trY = dy; }
      else if (c.key === "br") { this.targetCornerOffset.brX = dx; this.targetCornerOffset.brY = dy; }
      else { this.targetCornerOffset.blX = dx; this.targetCornerOffset.blY = dy; }
    }
  }

  private applyVisuals(): void {
    const W = CardSkin.width;
    const H = CardSkin.height;

    // 1. 透视变形：通过 4 角偏移驱动 PerspectiveMesh
    if (this.tiltMesh) {
      const co = this.currentCornerOffset;
      this.tiltMesh.setCorners(
        0 + co.tlX,     0 + co.tlY,      // TL
        W + co.trX,     0 + co.trY,      // TR
        W + co.brX,     H + co.brY,      // BR
        0 + co.blX,     H + co.blY,      // BL
      );
    }

    // 2. 外层呼吸晃动 / hover 缩放 / 旋转晃动 / 卡牌移动旋转 —— 全部作用在 displayWrapper 上。
    //    displayWrapper 的 pivot 是 (W/2, H/2)，position 基准在 (W/2, H/2)，
    //    旋转/缩放原本围绕几何中心。
    //
    //    Z 旋转 = 常态 wobbleRot + hover 通道 hoverWobbleRot + 卡牌移动旋转 velocityRotation，
    //    三者完全独立相加。
    //
    //    关键：velocityRotation 物理上要求"以轴点（pivotOffset 处）为不动点旋转"，
    //    而 displayWrapper 的几何 pivot 仍然必须保持在中心（不能直接改 pivot，
    //    否则会污染所有其他效果——缩放、wobble、breathing 等都假设围绕中心）。
    //    解决方案：在保持几何 pivot 不变的前提下，给 displayWrapper.position 加一个
    //    "反向补偿位移"，使最终视觉效果等价于"绕中心旋转后，再把整体平移回去，
    //    让轴点回到旋转前的位置"。
    //
    //    数学：设 d = (ox, oy) 是从几何中心指向轴点的本地向量（未旋转）。
    //    绕中心旋转 θ 后，d 变成 R(θ)·d。要让轴点位置不变（即父坐标系中保持
    //    旋转前的位置），需要把整体平移 (d - R(θ)·d)。
    //    注意：wobbleRot/hoverWobbleRot 仍按"绕几何中心"的语义生效（它们的物理意义
    //    就是绕中心微抖），所以补偿仅针对 velocityRotation 这一分量。
    if (this.displayWrapper) {
      const totalY = this.breathingY + this.hoverBreathingY;
      const wobbleTotal = this.wobbleRot + this.hoverWobbleRot;
      // 卡牌移动旋转：velocityRotation 现在是整个状态机统一输出的旋转量，
      // 包含 IDLE/ARMED 的跟随、INERTIA 的惯性过冲、SPRING 的弹簧回弹三阶段
      // 全部合并在一个变量里——所以无需再叠加其他过冲通道。
      const vRot = this.velocityRotation;
      const totalRot = wobbleTotal + vRot + this.scoringRotOffset;

      // 仅为 velocityRotation 计算绕轴点的位置补偿。
      // 当 vRot ≈ 0 或轴点恰在中心时补偿为 0，自动退化为原行为。
      let pivotCompX = 0;
      let pivotCompY = 0;
      if (vRot !== 0) {
        const mv = CONFIG.cardMoveRotation;
        const ox = mv?.pivotOffsetX ?? 0;
        const oy = mv?.pivotOffsetY ?? 0;
        if (ox !== 0 || oy !== 0) {
          const cos = Math.cos(vRot);
          const sin = Math.sin(vRot);
          // R(θ)·d = (cos·ox - sin·oy, sin·ox + cos·oy)
          const rotOx = cos * ox - sin * oy;
          const rotOy = sin * ox + cos * oy;
          // 补偿 = d - R(θ)·d，使轴点在旋转前后位置不变。
          // 同时这个补偿也要被外层 currentScale × dragScaleMul 缩放——
          // 因为 displayWrapper 自身的 scale 会作用在它的子节点上，而 position
          // 是相对父节点（CardView）的，不受 displayWrapper.scale 影响。
          // 所以这里直接用本地未缩放量即可（外层 CardView 在父级用 pivot/scale 整体缩放，
          // 与本补偿独立）。
          pivotCompX = ox - rotOx;
          pivotCompY = oy - rotOy;
        }
      }

      this.displayWrapper.position.set(W / 2 + pivotCompX, H / 2 + totalY + pivotCompY);
      this.displayWrapper.rotation = totalRot;
      // 最终缩放 = hover/常态 currentScale × 拖拽缩放乘数 × 结算缩放乘数（独立通道、可与 hover 复合）
      const finalScale = this.currentScale * this.dragScaleMul * this.scoringScaleMul;
      // 抓牌翻面：仅在 X 轴叠加 flipScaleX（= |cos(flipAngle)|），实现绕竖中轴线的翻面压缩。
      // 通道静默时 flipScaleX 恒为 1，对常态缩放无任何影响。
      this.displayWrapper.scale.set(finalScale * this.flipScaleX, finalScale);
    }

    // 3. 轴点可视化（调试用）。
    //    挂在 CardView 自身、不进入 displayWrapper：所以它不跟着 velocityRotation 转，
    //    永远停在"轴点应该在的位置"——这正是调参时想看到的参考点。
    //    懒创建 / 懒销毁，避免常态运行时多一份 Graphics 开销。
    this.updatePivotMarker(W, H);
  }

  /**
   * 根据 CONFIG.cardMoveRotation.showPivot 与 pivotOffsetX/Y 同步轴点可视化标记。
   *
   * 标记是个红色小十字 + 半透明圆点，画在 CardView 本地坐标 (W/2 + ox, H/2 + oy)。
   * 由于挂在 CardView 直接 children 而非 displayWrapper 里，
   * 它不会跟随 velocityRotation 旋转——这恰恰是"轴点应当不动"的视觉证据：
   * 拖拽时若补偿数学正确，卡牌图案上"原本在标记下的那个点"应当始终被标记盖住，
   * 不出现相对滑动。
   */
  private updatePivotMarker(W: number, H: number): void {
    const cfg = CONFIG.cardMoveRotation;
    const enabled = !!cfg?.showPivot;

    if (!enabled) {
      if (this.pivotMarker) {
        if (this.pivotMarker.parent) {
          this.pivotMarker.parent.removeChild(this.pivotMarker);
        }
        this.pivotMarker.destroy();
        this.pivotMarker = null;
      }
      return;
    }

    // 启用：创建或更新位置。
    if (!this.pivotMarker) {
      const g = new Graphics();
      // 半透明红色圆点（外圈）
      g.circle(0, 0, 7).fill({ color: 0xff3344, alpha: 0.35 });
      // 实心红色小点（中心）
      g.circle(0, 0, 2.5).fill({ color: 0xff3344, alpha: 0.95 });
      // 十字辅助线
      g.moveTo(-9, 0).lineTo(9, 0).stroke({ color: 0xff3344, width: 1, alpha: 0.85 });
      g.moveTo(0, -9).lineTo(0, 9).stroke({ color: 0xff3344, width: 1, alpha: 0.85 });
      g.roundPixels = false;
      // 必须放在 displayWrapper 之上，确保不被卡面遮挡。
      this.pivotMarker = g;
      super.addChild(g); // 用 super 绕开 addChild 重定向，确保挂在 CardView 直接 children 下
    }

    const ox = cfg?.pivotOffsetX ?? 0;
    const oy = cfg?.pivotOffsetY ?? 0;
    this.pivotMarker.position.set(W / 2 + ox, H / 2 + oy);
    // 确保它总在最上层（hover 时 displayWrapper 的 zIndex 等不会盖住它）。
    if (this.pivotMarker.parent) {
      this.pivotMarker.parent.setChildIndex(
        this.pivotMarker,
        this.pivotMarker.parent.children.length - 1,
      );
    }
  }

  private bindEvents(): void {
    // eventMode = "dynamic"：让 Pixi 每帧用最后已知的鼠标位置主动重做 hit-test。
    //
    // 必须用 dynamic 而非 static 的原因：
    //   松手归位场景——拖拽时鼠标停在某处不动，松手后卡牌从鼠标下方飞回手牌槽位。
    //   此时鼠标如果一直不动，"static" 模式不会重新 hit-test，于是：
    //     - isMouseOver 一直停在 true
    //     - cardState 一直停在 Hovered
    //     - updateHoverScale 持续把 currentScale 推到 hoverSettleScale 并稳定在那里
    //     - 卡牌视觉上看起来"被放大卡死"，直到鼠标轻轻一动 Pixi 才重做 hit-test
    //       发现鼠标已不在卡上 → 触发 pointerout → cardState=Normal → 缩放回落。
    //   切到 "dynamic" 后，Pixi 每帧用最后已知鼠标位置发一次合成 pointermove，
    //   归位中的卡牌脱离鼠标的瞬间就会触发 pointerout，无需用户移动鼠标。
    //
    // 性能：dynamic 比 static 每帧多一次按对象的 hit-test。一手 8 张牌的量级
    //   完全可以忽略（每帧 ~8 次矩形包含测试）。
    this.eventMode = "dynamic";
    this.cursor = "pointer";

    // 鼠标触碰碰撞范围（迟滞 hit area）：
    //   - 未悬停时：使用较小的 enter 矩形（scale = hoverHitEnterScale），鼠标要往里走才触发进入；
    //   - 已悬停时：使用较大的 leave 矩形（scale = hoverHitLeaveScale），鼠标要往外走才触发离开。
    // 注意：Pixi 命中测试在卡牌本地坐标（未应用 pivot/scale）下进行，矩形原点取 (0,0)~(W,H)。
    // 因此 hover 缩放本身不会影响 hitArea；我们只关心配置中相对卡面名义尺寸的倍率。
    const W = CardSkin.width;
    const H = CardSkin.height;
    const self = this;
    this.hitArea = {
      contains(x: number, y: number): boolean {
        const cv = CONFIG.cardVisuals;
        // 小丑牌额外受 joker.effects.hoverHit 门控；关闭时退化为固定矩形。
        if (!self.isVisualEnabled("hoverHit")) {
          // 关闭迟滞：退化为与卡面等大的固定矩形（仍然显式提供，避免 Pixi 走 children-bounds 路径
          // 受 mesh 角点偏移污染）。
          return x >= 0 && x <= W && y >= 0 && y <= H;
        }
        const scale = self.isMouseOver ? cv.hoverHitLeaveScale : cv.hoverHitEnterScale;
        const halfW = (W * scale) / 2;
        const halfH = (H * scale) / 2;
        const cx = W / 2;
        const cy = H / 2;
        return x >= cx - halfW && x <= cx + halfW && y >= cy - halfH && y <= cy + halfH;
      },
    };

    this.on("pointerdown", this.onPointerDown, this);

    this.on("pointerover", () => {
      this.isMouseOver = true;
      if (this.cardState === CardState.Normal) {
        this.cardState = CardState.Hovered;
      }
      // 鼠标真正重新进入卡牌：解除 hoverScale 抑制，允许下一次正常放大。
      this.suppressHoverScaleUntilReenter = false;
      // 用缓存全局点立刻刷新本地坐标，避免等 pointermove 才恢复倾斜。
      this.refreshMouseLocalFromGlobal();
      if (this.isDragging) return;
      // 触发"鼠标触碰呼吸晃动"（独立通道，一次性脱手脉冲）。
      // 每次进入都重置进度与相位，重新从满幅度起跳，可打断上一次未播完的脉冲。
      this.triggerHoverBreathing();
      this.callbacks.onHoverIn(this);
    });

    this.on("pointerout", () => {
      this.isMouseOver = false;
      if (this.cardState === CardState.Hovered) {
        this.cardState = CardState.Normal;
      }
      // 拖拽中牌跟手，hit-test 可能短暂判定离开；保留 mouseLocal，由 refresh 继续更新，
      // 便于松手后悬停倾斜立刻接上（拖拽期间倾斜本身已关闭，不会误驱动角点）。
      if (!this.isDragging) {
        this.mouseLocalX = null;
        this.mouseLocalY = null;
      }
      // 鼠标离开卡牌：抑制标志自然失效。
      this.suppressHoverScaleUntilReenter = false;
      if (this.isDragging) return;
      this.callbacks.onHoverOut(this);
    });

    this.on("pointermove", (event) => {
      // 悬停与拖拽都更新本地坐标（拖拽时倾斜关闭，坐标供松手后恢复）。
      if (this.isMouseOver || this.isDragging) {
        this.onHoverMove(event);
      }
    });
  }
}
