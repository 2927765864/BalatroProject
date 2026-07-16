/**
 * CharLayerComponent（逐字层）
 * ---------------------------------------------------------------
 * 唯一负责"拆字 + 隐藏原生 Text + 管理逐字 PIXI.Text 节点生命周期"的底层组件。
 *
 * 设计动机：
 *   过去 BreathingTextComponent（呼吸）和 BounceTextComponent（弹弹）各自
 *   都在做"把宿主 Text 隐藏，自己拆一组逐字 Text 出来渲染"。同一宿主上同时
 *   挂两个时，它们会抢 `pixiText.visible`、各建一组重叠的逐字节点，靠互相
 *   检测避让又会出现"谁都不渲染"的死区。
 *
 *   现在把"拆字 + 接管渲染"收敛成唯一的 CharLayer。呼吸 / 弹弹 / 文字抖动
 *   退化成纯粹的"效果提供者"（CharEffect）：每帧只往逐字层申请到的字符上
 *   叠加自己的贡献（呼吸写 y 偏移，弹弹写 scale，抖动写 rotation），
 *   不再碰 visible、不再自建节点。
 *
 * 每帧固定流程（tick）：
 *   1. 若文本 / 样式变了就重建逐字 Text（并通知宿主 visualChanged 让阴影重烤）。
 *   2. 把每个字复位到基线：position = (baseX, baseY），scale = 1。
 *   3. 依次让已注册的效果把贡献累加上去（y 累加、scale 累乘、rotation 累加）。
 *   4. 仅当 scale/rotation 改变剪影时 notifyVisualChanged（弹弹 / 文字抖动同帧同步阴影）；
 *      纯位移（呼吸起伏）**不**触发重烤。
 *   5. 一旦因 scale/rotation 重烤：烤纹理前把字 **钉回基线 position**（去掉 offset），
 *      保留 scale/rotation —— 阴影跟角/缩放抖，但**不**跟呼吸上下起伏；烤完再恢复位移。
 *
 * 不变量：
 *   - 任意时刻宿主上最多只有这一组逐字 Text。
 *   - `pixiText.visible` 只有 CharLayer 一个所有者。
 *   - 没有任何效果（chars 也无意义）或文本为空时，回退显示原生 Text。
 *
 * 与旧存档兼容：
 *   - 旧存档里只有 breathingText / bounceText，没有 charLayer。呼吸 / 弹弹
 *     组件 onAttach 时会惰性确保宿主挂上一个 CharLayer（自动 addComponent）。
 *   - charLayer 本身无关键持久化数据（基线由宿主几何算），序列化为空 data。
 */
import { Text } from "pixi.js";
import { UIComponent, type SerializedComponent } from "../UIComponent";
import { uiHierarchy } from "../UIHierarchy";
import type { UIText } from "@ui/components/UIText";
import type { UINode } from "../UINode";

/** 每帧每个字符的累加器：效果往里叠贡献。 */
export interface CharFrame {
  /** 基线 y 之上的额外偏移（像素，多个效果累加）。 */
  offsetY: number;
  /** 基线 x 之上的额外偏移（像素，多个效果累加）。预留。 */
  offsetX: number;
  /** 缩放（多个效果累乘，初值 1）。 */
  scale: number;
  /** 旋转弧度（多个效果累加，初值 0）。 */
  rotation: number;
}

/**
 * 逐字效果接口。呼吸 / 弹弹各实现一份，向 CharLayer 注册。
 * CharLayer 每帧对每个字符调 contribute，把贡献写进 acc。
 */
export interface CharEffect {
  /**
   * 把本效果对第 i 个字（共 count 个）的贡献写进 acc。
   * @param i      字符下标
   * @param count  字符总数
   * @param now    performance.now()
   * @param acc    本帧累加器（offsetY 累加、scale 累乘、offsetX 累加）
   */
  contribute(i: number, count: number, now: number, acc: CharFrame): void;
  /**
   * 当前是否仍有视觉活动。呼吸恒 true；弹弹在播放完后返回 false。
   * 仅用于让 CharLayer 判断"是否所有效果都静止"——目前 CharLayer 始终运行，
   * 此接口预留给未来做"全静止时停 tick 省电"的优化。
   */
  isActive(): boolean;
  /**
   * 为 true 时，本效果造成的 scale/rotation 不计入阴影剪影重烤。
   * 常态微抖（文字抖动）应设为 true，避免每帧 DropShadow 重烤。
   * 弹弹等瞬时剪影动画保持默认 false。
   */
  ignoreSilhouetteForShadow?: boolean;
}

/** 判断宿主是不是 UIText（有 getPixiText 接口）。 */
function isTextHost(host: unknown): host is UIText {
  return (
    !!host &&
    typeof host === "object" &&
    typeof (host as { getPixiText?: unknown }).getPixiText === "function"
  );
}

/**
 * 确保宿主挂上 CharLayer，并返回它。供呼吸 / 弹弹在 onAttach 里调用。
 * 已存在则直接返回；不存在则创建并 addComponent。
 */
export function ensureCharLayer(host: UINode): CharLayerComponent | null {
  if (!isTextHost(host)) return null;
  const existing = host.getComponent<CharLayerComponent>("charLayer");
  if (existing) return existing;
  const layer = new CharLayerComponent();
  host.addComponent(layer);
  return host.getComponent<CharLayerComponent>("charLayer") ?? layer;
}

export class CharLayerComponent extends UIComponent {
  readonly type = "charLayer";
  readonly displayName = "逐字层";
  override readonly removable = false;

  /** 当前生成的逐字 Text（按字符顺序）。 */
  private chars: Text[] = [];
  /** 每个字的基线 x / y（复位用）。 */
  private baseX: number[] = [];
  private baseY: number[] = [];
  /** 上次成功拆字时的文本 / 样式 hash，用于检测变化触发重建。 */
  private lastText = "";
  private lastStyleHash = "";
  /** 注册到本层的效果（呼吸 / 弹弹）。按注册顺序应用。 */
  private effects: CharEffect[] = [];
  /**
   * 上一帧是否有「会改剪影」的活跃效果（scale/rotation 非基线）。
   * 用于动画结束那帧补一次阴影重烤、落回稳态。
   * 纯位移（呼吸）不算——阴影本就不该跟着起伏。
   */
  private wasSilhouetteActiveLastFrame = false;
  /** App ticker 反注册。 */
  private unsubscribeTick: (() => void) | null = null;

  // ---- 效果注册（供 CharEffect 组件调用）------------------------

  registerEffect(effect: CharEffect): void {
    if (!this.effects.includes(effect)) this.effects.push(effect);
  }

  unregisterEffect(effect: CharEffect): void {
    const idx = this.effects.indexOf(effect);
    if (idx >= 0) this.effects.splice(idx, 1);
    // 注意：不在此处立即 teardownChars。注销可能发生在 contribute 迭代过程中
    // （弹弹播完自注销），此刻 tick 还在用 chars 写回，若立即销毁会操作已 destroy
    // 的对象。真正的"无效果 → 回退原生 Text + 清字符"统一放到 tick 开头处理。
  }

  hasEffects(): boolean {
    return this.effects.length > 0;
  }

  // ---- 生命周期 -------------------------------------------------

  protected override onAttach(): void {
    if (!isTextHost(this.host)) return;

    const ticker = uiHierarchy.getTicker();
    if (ticker) {
      const onTick = (): void => this.tick();
      ticker.add(onTick);
      this.unsubscribeTick = (): void => {
        ticker.remove(onTick);
      };
    }
  }

  protected override onDetach(): void {
    if (this.unsubscribeTick) {
      this.unsubscribeTick();
      this.unsubscribeTick = null;
    }
    this.teardownChars();
    this.showNativeText();
    this.effects = [];
  }

  apply(): void {
    // 无独立数据需要应用；字符按 tick 驱动。
  }

  // ---- 渲染接管 -------------------------------------------------

  private showNativeText(): void {
    if (isTextHost(this.host)) {
      this.host.getPixiText().visible = true;
    }
  }

  /** 把宿主当前样式做个简易 hash，用来检测是否需要重建逐字 Text。 */
  private computeStyleHash(t: Text): string {
    const s = t.style;
    return [
      s.fontFamily,
      s.fontSize,
      s.fontWeight,
      s.fontStyle,
      JSON.stringify((s as unknown as { fill?: unknown }).fill ?? null),
      s.stroke ? JSON.stringify(s.stroke) : "",
      s.letterSpacing ?? 0,
      t.anchor.x,
      t.anchor.y,
    ].join("|");
  }

  private rebuildIfNeeded(force = false): void {
    if (!isTextHost(this.host)) return;
    const src = this.host.getPixiText();
    const text = src.text;
    const styleHash = this.computeStyleHash(src);
    if (
      !force &&
      text === this.lastText &&
      styleHash === this.lastStyleHash &&
      this.chars.length > 0
    ) {
      return;
    }
    this.teardownChars();
    this.buildChars(src, text);
    this.lastText = text;
    this.lastStyleHash = styleHash;
    // 内容变了 → 阴影等快照型组件需要重烤。
    this.host.notifyVisualChanged();
  }

  private buildChars(src: Text, text: string): void {
    if (text.length === 0) return;

    const style = src.style;
    const anchorX = src.anchor.x;
    const anchorY = src.anchor.y;
    const tint = src.tint;
    const alpha = src.alpha;
    const resolution = src.resolution;

    const chars: Text[] = [];
    const widths: number[] = [];
    let totalWidth = 0;

    for (const ch of [...text]) {
      const t = new Text({ text: ch, style, resolution });
      t.tint = tint;
      t.alpha = alpha;
      t.eventMode = "none";
      t.roundPixels = false;
      // 锚点水平 0.5，让缩放沿单字中轴线进行（消除亚像素抖动）。
      t.anchor.set(0.5, anchorY);
      chars.push(t);
      widths.push(t.width);
      totalWidth += t.width;
    }

    const firstLeftX = src.position.x - anchorX * totalWidth;
    let cursorX = firstLeftX;

    const baseX: number[] = [];
    const baseY: number[] = [];
    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i]!;
      const w = widths[i]!;
      const cx = cursorX + w / 2;
      ch.position.set(cx, src.position.y);
      baseX.push(cx);
      baseY.push(src.position.y);
      cursorX += w;
      this.host.addChild(ch);
    }

    this.chars = chars;
    this.baseX = baseX;
    this.baseY = baseY;
  }

  private teardownChars(): void {
    for (const ch of this.chars) {
      if (ch.parent) ch.parent.removeChild(ch);
      ch.destroy();
    }
    this.chars = [];
    this.baseX = [];
    this.baseY = [];
  }

  // ---- 每帧 tick ------------------------------------------------

  private tick(): void {
    if (!isTextHost(this.host)) return;

    // 没有任何效果挂着：不接管渲染，保持原生 Text 可见，确保字符已清掉。
    if (this.effects.length === 0) {
      if (this.chars.length > 0) {
        this.teardownChars();
        this.showNativeText();
      }
      return;
    }

    // 有效果接管：原生 Text 必须隐藏。
    const src = this.host.getPixiText();
    if (src.visible) src.visible = false;

    // 文本 / 样式变了就重建逐字 Text。
    if (
      src.text !== this.lastText ||
      this.computeStyleHash(src) !== this.lastStyleHash
    ) {
      this.rebuildIfNeeded();
    } else if (this.chars.length === 0 && src.text.length > 0) {
      // 首次或被清空过：保证有字符。
      this.rebuildIfNeeded(true);
    }

    const count = this.chars.length;
    if (count === 0) return;

    const now = performance.now();

    // 用快照遍历：效果的 contribute 内部可能 register/unregister（如弹弹播完
    // 自注销），快照可避免在本帧迭代中被修改而漏算 / 报错。
    const effectsSnapshot = this.effects.slice();

    // 逐字 transform 与阴影策略：
    //   - scale / rotation 会改变字的外形 → 阴影必须同帧重烤，否则肉眼可见滞后
    //     （弹弹、文字抖动均走此路径，ShadowComponent 同步 rebuild）
    //   - 仅 offsetX/Y（呼吸起伏）不触发重烤
    //   - 重烤时必须钉回基线 position：否则 generateTexture 会把呼吸 Y 烤进阴影，
    //     导致「抖动开阴影 → 呼吸起伏连带进影」；scale/rotation 仍保留进烤片
    //   - 标记 ignoreSilhouetteForShadow 的效果不计入阴影剪影判定
    let silhouetteChanged = false;

    for (let i = 0; i < count; i += 1) {
      const ch = this.chars[i]!;
      // 1) 复位到基线。
      const acc: CharFrame = { offsetX: 0, offsetY: 0, scale: 1, rotation: 0 };
      // 阴影剪影判定：只看 scale/rotation（位移永不单独触发重烤）。
      let shadowScale = 1;
      let shadowRotation = 0;
      // 2) 累加所有效果的贡献。
      for (const effect of effectsSnapshot) {
        const beforeScale = acc.scale;
        const beforeRot = acc.rotation;
        effect.contribute(i, count, now, acc);
        if (!effect.ignoreSilhouetteForShadow) {
          const scaleMul =
            beforeScale !== 0 ? acc.scale / beforeScale : acc.scale;
          shadowScale *= scaleMul;
          shadowRotation += acc.rotation - beforeRot;
        }
      }
      // 3) 写回（视觉含全部效果，含呼吸位移）。
      ch.position.set(this.baseX[i]! + acc.offsetX, this.baseY[i]! + acc.offsetY);
      ch.scale.set(acc.scale);
      ch.rotation = acc.rotation;

      if (
        Math.abs(shadowScale - 1) > 0.001 ||
        Math.abs(shadowRotation) > 0.001
      ) {
        silhouetteChanged = true;
      }
    }

    // 阴影是"烤宿主快照"的。只在剪影形状（scale/rotation）变化时重烤：
    //   - 有 scale/rotation（弹弹 / 抖动）→ 每帧通知，但烤前钉回基线 XY
    //   - 仅位移（呼吸）→ 不通知
    //   - 剪影动画结束那一帧补发一次，落回稳态
    // 旧纹理释放走 DeferredTextureDestroy，避免 BindGroup 悬空黑屏。
    if (silhouetteChanged || this.wasSilhouetteActiveLastFrame) {
      this.notifyShadowSilhouetteBake();
    }
    this.wasSilhouetteActiveLastFrame = silhouetteChanged;
  }

  /**
   * 为阴影重烤：临时去掉逐字 position 偏移（呼吸等），保留 scale/rotation，
   * 同步 notifyVisualChanged，再恢复位移。
   *
   * 这样阴影跟角抖 / 缩放，不跟上下起伏。
   */
  private notifyShadowSilhouetteBake(): void {
    const count = this.chars.length;
    if (count === 0) {
      this.host.notifyVisualChanged();
      return;
    }

    const savedX: number[] = new Array(count);
    const savedY: number[] = new Array(count);
    for (let i = 0; i < count; i += 1) {
      const ch = this.chars[i]!;
      savedX[i] = ch.position.x;
      savedY[i] = ch.position.y;
      ch.position.set(this.baseX[i]!, this.baseY[i]!);
    }

    this.host.notifyVisualChanged();

    for (let i = 0; i < count; i += 1) {
      this.chars[i]!.position.set(savedX[i]!, savedY[i]!);
    }
  }

  // ---- 序列化 ----------------------------------------------------

  serialize(): SerializedComponent {
    return { type: this.type, data: {} };
  }

  deserialize(_d: Record<string, unknown>): void {
    // 无持久化字段。
  }

  buildInspector(): HTMLElement {
    const root = document.createElement("div");
    root.className = "ui-comp-body";
    root.textContent = "逐字层：承载呼吸 / 弹弹等逐字效果（自动管理）。";
    return root;
  }
}
