/**
 * ShadowComponent
 * ---------------------------------------------------------------
 * 给宿主 UINode 附加一层"硬剪影"投影：把宿主当前的样子用
 * renderer.generateTexture 烤成一张纹理，染色 + 调透明度 + 沿
 * angle/distance 偏移，作为宿主 children 里**最前**的一格 Sprite
 * （父先于子渲染，children[0] 最先渲，于是被本体覆盖在下面）。
 *
 * 关键设计：
 *   - 不用 filter。filter 会让宿主走 RenderTexture 中转，受 resolution 影响，
 *     本体跟着被降采样，看上去糊。这里本体保持原生渲染路径，零退化。
 *   - sprite 是宿主的 child，自动随宿主 transform 一起变换；不用自己复刻位姿。
 *   - 烤纹理前把 sprite 从宿主上临时摘掉，烤完再挂回去——否则 generateTexture
 *     会把上一次的剪影也抓进新纹理，雪球。
 *   - generateTexture 用 host 的 resolution 提高纹理清晰度；PIXI v8 的
 *     RenderTexture 把 resolution 内化了——sprite 在 local 空间下显示的
 *     大小就是 region.width × region.height（host local 像素），所以
 *     sprite.scale=1 时剪影与本体严格 1:1 重合，不需要任何 1/res 补偿。
 *   - sprite.pivot 放在剪影几何中心；sprite.position 也直接给中心点的目标
 *     位置 = region 中心 + (ox, oy)。这样 scale=1 / skew=0 / distance=0
 *     时剪影像素与本体严格重合，distance 的物理意义就是"剪影沿 angle 方向
 *     偏移 N 像素"，与文本宽度等内容尺寸完全解耦。
 *   - UINode.resortChildren 只移动 UINode 子节点，不会动我们这个 Sprite；
 *     sprite 会稳定停在 children[0]，渲染顺序符合预期。
 *
 * 刷新时机：
 *   - onAttach
 *   - inspector 改参数
 *   - 宿主 childAdded / childRemoved
 *   - hierarchy 的 componentsChanged 事件（别的组件改了宿主外观）
 *   - 宿主 emit("hostVisualChanged")（动态内容变化，如 UIText.setText 改文字、
 *     业务直接改了内部 PIXI 显示对象的视觉属性、逐字 scale 动画）
 *
 * 合并策略：
 *   - `hostVisualChanged` **同步** rebuild：逐字弹弹等路径在 ticker 里改完
 *     scale 立刻通知，必须同帧烤完，否则阴影会比数字晚一拍（rAF 会落到
 *     当帧 render 之后，肉眼可见滞后）。
 *   - childAdded / childRemoved / componentsChanged 仍走 `scheduleRebuild()`：
 *     用 rAF 合并同一帧内多次结构变动，避免 N 次重烤。
 */
import {
  Container,
  Sprite,
  Texture,
  Rectangle,
  type Renderer,
} from "pixi.js";
import { deferDestroyTexture } from "@core/DeferredTextureDestroy";
import { UIComponent, type SerializedComponent } from "../UIComponent";
import { uiHierarchy } from "../UIHierarchy";
import { isUINode } from "../UINode";
import { attachDragScrub } from "@/debug/dragScrub";

interface ShadowData {
  /** #rrggbb */
  color: string;
  /** 0..1 */
  alpha: number;
  /** 度数；0=向右，90=向下 */
  angle: number;
  /** 像素 */
  distance: number;
  /** 剪影 X 方向缩放，1=与本体同宽 */
  scaleX: number;
  /** 剪影 Y 方向缩放，1=与本体同高 */
  scaleY: number;
  /** 剪影 X skew，度数；做"歪倒"投影 */
  skewX: number;
  /** 剪影 Y skew，度数 */
  skewY: number;
}

const DEFAULT_DATA: ShadowData = {
  color: "#000000",
  alpha: 0.5,
  angle: 45,
  distance: 4,
  scaleX: 1,
  scaleY: 1,
  skewX: 0,
  skewY: 0,
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function hexToNumber(hex: string): number {
  if (!HEX_RE.test(hex)) return 0x000000;
  return parseInt(hex.slice(1), 16);
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export class ShadowComponent extends UIComponent {
  readonly type = "shadow";
  readonly displayName = "Shadow";

  private data: ShadowData = { ...DEFAULT_DATA };

  /** 剪影 sprite。生命周期内同一实例反复换纹理。 */
  private sprite: Sprite | null = null;
  /** 上一次烤的纹理；换新前显式销毁，避免 GPU 内存累积。 */
  private texture: Texture | null = null;
  /** 烤出来时 region 的 (x, y, w, h)，用于把 sprite 摆回正确位置以及做缩放枢轴。 */
  private regionOffsetX = 0;
  private regionOffsetY = 0;
  private regionWidth = 0;
  private regionHeight = 0;
  /** 防止"宿主 children 变化触发重烤 → 重烤 add/remove sprite → 又触发"无限套娃。 */
  private rebuilding = false;
  /** inspector 自己刚发出 componentsChanged 时，跳过外部回调里的 rebuild。 */
  private suppressNextComponentsChanged = false;
  /** 宿主子树事件 listener，detach 时摘。 */
  private hostChangeHandler: (() => void) | null = null;
  /** 宿主"视觉内容变化"事件 listener。 */
  private hostVisualHandler: (() => void) | null = null;
  /** uiHierarchy.subscribe 的反注册函数。 */
  private unsubscribeHierarchy: (() => void) | null = null;
  /** rAF 合并：同一帧内多次 scheduleRebuild 只重烤一次。0 表示当前没有排队。 */
  private rafHandle = 0;
  /**
   * 业务侧临时强制隐藏（例如按钮按下「压入」效果）。
   * 为 true 时 applyVisuals 仍更新位姿/染色，但 sprite.visible=false。
   */
  private forceHidden = false;

  // ---- 生命周期 -------------------------------------------------

  protected override onAttach(): void {
    this.sprite = new Sprite();
    this.sprite.label = `__shadow_for_${this.host.nodeId}`;
    this.sprite.eventMode = "none";
    this.sprite.visible = false; // 第一次 rebuild 成功前先藏着

    // 宿主子树变化 → 排队重烤纹理。走 scheduleRebuild 合并，避免一帧内
    // 同时插入/删除多个 child 时重烤多次。
    this.hostChangeHandler = (): void => {
      if (this.rebuilding) return;
      this.scheduleRebuild();
    };
    this.host.on("childAdded", this.hostChangeHandler);
    this.host.on("childRemoved", this.hostChangeHandler);

    // 宿主自身视觉内容发生变化（UIText.setText、逐字 scale/旋转动画等）
    // → **同步**重烤。CharLayer 在 ticker 写完 transform 后立刻 notify，
    // 必须在本帧 render 前烤完；走 rAF 会晚到当帧画面已画出之后，阴影滞后。
    this.hostVisualHandler = (): void => {
      if (this.rebuilding) return;
      this.rebuild();
    };
    (
      this.host as unknown as { on: (name: string, fn: () => void) => void }
    ).on("hostVisualChanged", this.hostVisualHandler);

    // 别的组件改了宿主外观 → 也重烤。Transform 改变不需要重烤
    // （sprite 是 child，自动跟随）。
    // inspector 改自己参数也会触发 componentsChanged，但那只是为了走持久化，
    // 不需要重烤；通过 suppressNextComponentsChanged 跳过一次。
    this.unsubscribeHierarchy = uiHierarchy.subscribe((type, node) => {
      if (node !== this.host) return;
      if (this.rebuilding) return;
      if (type !== "componentsChanged") return;
      if (this.suppressNextComponentsChanged) {
        this.suppressNextComponentsChanged = false;
        return;
      }
      this.scheduleRebuild();
    });

    this.rebuild();
  }

  protected override onDetach(): void {
    if (this.rafHandle !== 0) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = 0;
    }
    if (this.hostChangeHandler) {
      this.host.off("childAdded", this.hostChangeHandler);
      this.host.off("childRemoved", this.hostChangeHandler);
      this.hostChangeHandler = null;
    }
    if (this.hostVisualHandler) {
      (
        this.host as unknown as {
          off: (name: string, fn: () => void) => void;
        }
      ).off("hostVisualChanged", this.hostVisualHandler);
      this.hostVisualHandler = null;
    }
    if (this.unsubscribeHierarchy) {
      this.unsubscribeHierarchy();
      this.unsubscribeHierarchy = null;
    }
    if (this.sprite) {
      if (this.sprite.parent) this.sprite.parent.removeChild(this.sprite);
      this.sprite.destroy({ children: false, texture: false });
      this.sprite = null;
    }
    // 延迟销毁：避免 WebGPU batch BindGroup 仍引用该 textureSource 时立刻
    // destroy 导致 resources=null → 下一帧 textureSource1 空引用黑屏。
    deferDestroyTexture(this.texture);
    this.texture = null;
  }

  apply(): void {
    // 反序列化后调用。第一次可能 onAttach 还没跑。
    if (!this.sprite) return;
    this.rebuild();
  }

  // ---- 核心：烤纹理 + 摆位 -----------------------------------------

  /**
   * 排队一次 rebuild，rAF 内合并同帧多次请求为一次。
   * 用于 child 增删 / componentsChanged 等可能一帧内连发的结构事件。
   *
   * 注意：hostVisualChanged（含逐字缩放动画）走同步 rebuild，不要用本方法，
   * 否则阴影会比本体晚至少一帧。
   */
  private scheduleRebuild(): void {
    if (this.rafHandle !== 0) return;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = 0;
      // 别在已经 detach 之后偷跑。
      if (!this.sprite) return;
      this.rebuild();
    });
  }

  private rebuild(): void {
    const sprite = this.sprite;
    if (!sprite) return;

    // 同步路径执行了，把任何已排队的 rAF 取消，省一次空跑。
    if (this.rafHandle !== 0) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = 0;
    }

    const renderer = uiHierarchy.getRenderer();
    if (!renderer) {
      sprite.visible = false;
      return;
    }

    this.rebuilding = true;
    try {
      // 第 1 步：先把 sprite 从宿主上摘掉，再烤纹理，避免把旧剪影抓进来。
      if (sprite.parent === this.host) {
        this.host.removeChild(sprite);
      }

      const ok = this.regenerateTexture(renderer);
      if (!ok) {
        sprite.visible = false;
        return;
      }

      // 第 2 步：把 sprite 挂回宿主 children[0]，最先渲染 = 最底层。
      this.host.addChildAt(sprite, 0);

      // 第 3 步：摆位、染色、透明度。
      this.applyVisuals();
    } finally {
      this.rebuilding = false;
    }
  }

  /** 烤一张反映宿主当前样子的纹理；同步更新 regionOffset / regionSize。返回是否成功。 */
  private regenerateTexture(renderer: Renderer): boolean {
    const host = this.host;
    const sprite = this.sprite!;

    // 祖先剪影不应包含「只要本体、不要阴影」的子节点（如牌堆 44/52）。
    // 烤之前临时隐藏，算 bounds / generateTexture 都排除它们，烤完再还原。
    const hidden = this.hideExcludedShadowCaptureChildren(host);

    try {
      // host 在自己 local 空间下的内容包围盒。
      const bounds = host.getLocalBounds();
      if (bounds.width <= 0 || bounds.height <= 0) {
        return false;
      }

      // PIXI v8 内部会把 region 的 width/height 做 `| 0`（floor 到整数），
      // 不修正的话边缘会少一两像素，导致剪影看上去"比本体小一圈"。
      // 这里把 region 向外扩到整数边界，并把 (x, y) 一起对齐到整数，
      // 让 sprite 的 position 重新对得齐。
      const x0 = Math.floor(bounds.x);
      const y0 = Math.floor(bounds.y);
      const x1 = Math.ceil(bounds.x + bounds.width);
      const y1 = Math.ceil(bounds.y + bounds.height);
      const region = new Rectangle(x0, y0, x1 - x0, y1 - y0);

      this.regionOffsetX = region.x;
      this.regionOffsetY = region.y;
      this.regionWidth = region.width;
      this.regionHeight = region.height;

      let tex: Texture | null = null;
      try {
        tex = renderer.generateTexture({
          target: host,
          frame: region,
          resolution: renderer.resolution,
          antialias: true,
          textureSourceOptions: { autoGarbageCollect: false },
        });
        tex.source.autoGarbageCollect = false;
      } catch (err) {
        console.warn(`[ShadowComponent] generateTexture 失败：`, err);
        return false;
      }

      const oldTex = this.texture;
      this.texture = tex;
      sprite.texture = tex;
      // 旧纹理延迟数帧销毁，等 batch BindGroup 换绑完成后再释放 GPU 资源。
      if (oldTex && oldTex !== tex) deferDestroyTexture(oldTex);
      return true;
    } finally {
      for (const child of hidden) child.visible = true;
    }
  }

  /**
   * 递归隐藏 host 子树中 excludeFromParentShadowCapture 的 UINode。
   * 返回本次被隐藏的节点，供调用方还原 visible。
   */
  private hideExcludedShadowCaptureChildren(root: Container): Container[] {
    const hidden: Container[] = [];
    const walk = (node: Container): void => {
      for (const child of node.children) {
        if (!(child instanceof Container)) continue;
        if (isUINode(child) && child.excludeFromParentShadowCapture) {
          if (child.visible) {
            child.visible = false;
            hidden.push(child);
          }
          // 整棵子树已隐藏，不必再往下走。
          continue;
        }
        walk(child);
      }
    };
    walk(root);
    return hidden;
  }

  /**
   * 摆位 + 染色 + 透明度。sprite 已经是 host 的 child，跟随宿主 transform。
   *
   * 坐标系核心约定（PIXI v8）：
   *   - RenderTexture 把 resolution 内化了：纹理在 PIXI 显示路径里就是按
   *     `region.width × region.height`（host local 像素）大小显示，1:1，
   *     不需要再除以 res 做"物理像素 → 逻辑像素"换算。
   *   - 所以 `sprite.scale = 1` 时，剪影刚好与本体重合；用户调到 2 不会再"放大"，
   *     而是真的 2 倍大。
   *   - pivot 设在剪影的"几何中心"（逻辑像素），让 scaleX/Y、skewX/Y 是绕中心做的，
   *     视觉上"放缩不漂移"。pivot 用 scale=1 的位置算，与 scale 解耦。
   */
  private applyVisuals(): void {
    const sprite = this.sprite;
    if (!sprite) return;

    sprite.scale.set(this.data.scaleX, this.data.scaleY);

    // skew 用度数暴露给 inspector，PIXI 里是弧度。
    sprite.skew.set(
      (this.data.skewX * Math.PI) / 180,
      (this.data.skewY * Math.PI) / 180,
    );

    // pivot 放在剪影中心（host local 像素 = sprite local 像素，因为 scale=1
    // 时纹理 1:1 显示）。scale ≠ 1 时仍以这个中心为缩放枢轴。
    sprite.pivot.set(this.regionWidth / 2, this.regionHeight / 2);

    // 偏移：以 host local 坐标系为基准。
    // angle: 0=右, 90=下（PIXI 的 y 朝下）。
    const rad = (this.data.angle * Math.PI) / 180;
    const ox = Math.cos(rad) * this.data.distance;
    const oy = Math.sin(rad) * this.data.distance;

    // sprite.position = sprite 的 pivot 在父 local 下的位置。
    // pivot 是中心 → position 也直接给中心点的目标位置：
    //   region 左上 + 半个 region 大小，再叠 (ox, oy)。
    // 这样 scaleX=scaleY=1, skew=0, distance=0 时，sprite 像素与本体严格重合。
    const cx = this.regionOffsetX + this.regionWidth / 2;
    const cy = this.regionOffsetY + this.regionHeight / 2;
    sprite.position.set(cx + ox, cy + oy);

    sprite.tint = hexToNumber(this.data.color);
    sprite.alpha = clamp(this.data.alpha, 0, 1);
    sprite.visible = !this.forceHidden;
  }

  /**
   * 临时强制隐藏/显示剪影（不改序列化数据）。
   * 用于按钮按下时模拟「压入」：阴影消失。
   */
  setForceHidden(hidden: boolean): void {
    if (this.forceHidden === hidden) return;
    this.forceHidden = hidden;
    if (this.sprite) {
      // 有纹理时才显示；无纹理保持隐藏，等下次 rebuild。
      this.sprite.visible = !hidden && this.texture !== null;
    }
  }

  /** 阴影方向角（度，0=右，90=下）。 */
  get angle(): number {
    return this.data.angle;
  }

  /** 阴影偏移距离（像素）。 */
  get distance(): number {
    return this.data.distance;
  }

  // ---- 序列化 ----------------------------------------------------

  serialize(): SerializedComponent {
    return { type: this.type, data: { ...this.data } };
  }

  deserialize(d: Record<string, unknown>): void {
    if (typeof d["color"] === "string" && HEX_RE.test(d["color"])) {
      this.data.color = d["color"].toLowerCase();
    }
    if (typeof d["alpha"] === "number") this.data.alpha = clamp(d["alpha"], 0, 1);
    if (typeof d["angle"] === "number") this.data.angle = d["angle"];
    if (typeof d["distance"] === "number") this.data.distance = d["distance"];
    if (typeof d["scaleX"] === "number") this.data.scaleX = d["scaleX"];
    if (typeof d["scaleY"] === "number") this.data.scaleY = d["scaleY"];
    if (typeof d["skewX"] === "number") this.data.skewX = d["skewX"];
    if (typeof d["skewY"] === "number") this.data.skewY = d["skewY"];
    // 兼容老存档里残留的 blur / quality 字段：直接忽略。
  }

  // ---- inspector DOM --------------------------------------------

  buildInspector(): HTMLElement {
    const root = document.createElement("div");
    root.className = "ui-comp-body";

    // 改 color / alpha / angle / distance 都只动 sprite 自身属性，
    // 不需要重烤纹理。notify 仅为了走持久化，跳过自己监听里的重烤。
    const commit = (): void => {
      this.applyVisuals();
      this.suppressNextComponentsChanged = true;
      uiHierarchy.notifyComponentsChanged(this.host);
    };

    // color
    {
      const row = document.createElement("div");
      row.className = "ui-comp-row";
      const lab = document.createElement("span");
      lab.className = "ui-comp-row-label";
      lab.textContent = "Color";
      const input = document.createElement("input");
      input.type = "color";
      input.value = this.data.color;
      input.addEventListener("input", () => {
        this.data.color = input.value.toLowerCase();
        commit();
      });
      row.appendChild(lab);
      row.appendChild(input);
      root.appendChild(row);
    }

    // alpha
    {
      const row = document.createElement("div");
      row.className = "ui-comp-row";
      const lab = document.createElement("span");
      lab.className = "ui-comp-row-label";
      lab.textContent = "Alpha";
      const input = document.createElement("input");
      input.type = "number";
      input.className = "panel-number";
      input.min = "0";
      input.max = "1";
      input.step = "0.01";
      input.value = this.data.alpha.toFixed(2);
      attachDragScrub(input, { step: 0.01, min: 0, max: 1, digits: 2 });
      input.addEventListener("input", () => {
        const v = Number(input.value);
        if (!Number.isFinite(v)) return;
        this.data.alpha = clamp(v, 0, 1);
        commit();
      });
      input.addEventListener("change", () => {
        input.value = this.data.alpha.toFixed(2);
      });
      row.appendChild(lab);
      row.appendChild(input);
      root.appendChild(row);
    }

    // angle
    {
      const row = document.createElement("div");
      row.className = "ui-comp-row";
      const lab = document.createElement("span");
      lab.className = "ui-comp-row-label";
      lab.textContent = "Angle (°)";
      const input = document.createElement("input");
      input.type = "number";
      input.className = "panel-number";
      input.step = "1";
      input.value = this.data.angle.toFixed(1);
      attachDragScrub(input, { step: 1, digits: 1 });
      input.addEventListener("input", () => {
        const v = Number(input.value);
        if (!Number.isFinite(v)) return;
        this.data.angle = v;
        commit();
      });
      input.addEventListener("change", () => {
        input.value = this.data.angle.toFixed(1);
      });
      row.appendChild(lab);
      row.appendChild(input);
      root.appendChild(row);
    }

    // distance
    {
      const row = document.createElement("div");
      row.className = "ui-comp-row";
      const lab = document.createElement("span");
      lab.className = "ui-comp-row-label";
      lab.textContent = "Distance";
      const input = document.createElement("input");
      input.type = "number";
      input.className = "panel-number";
      input.step = "0.5";
      input.value = this.data.distance.toFixed(1);
      attachDragScrub(input, { step: 0.5, digits: 1 });
      input.addEventListener("input", () => {
        const v = Number(input.value);
        if (!Number.isFinite(v)) return;
        this.data.distance = v;
        commit();
      });
      input.addEventListener("change", () => {
        input.value = this.data.distance.toFixed(1);
      });
      row.appendChild(lab);
      row.appendChild(input);
      root.appendChild(row);
    }

    // 通用工具：一个数值字段，改完只调 applyVisuals（不重烤纹理）。
    const addNumberRow = (
      label: string,
      key: "scaleX" | "scaleY" | "skewX" | "skewY",
      opts: { step: number; digits: number; min?: number },
    ): void => {
      const row = document.createElement("div");
      row.className = "ui-comp-row";
      const lab = document.createElement("span");
      lab.className = "ui-comp-row-label";
      lab.textContent = label;
      const input = document.createElement("input");
      input.type = "number";
      input.className = "panel-number";
      input.step = String(opts.step);
      if (opts.min !== undefined) input.min = String(opts.min);
      input.value = this.data[key].toFixed(opts.digits);
      attachDragScrub(input, {
        step: opts.step,
        digits: opts.digits,
        ...(opts.min !== undefined ? { min: opts.min } : {}),
      });
      input.addEventListener("input", () => {
        const v = Number(input.value);
        if (!Number.isFinite(v)) return;
        this.data[key] = opts.min !== undefined ? Math.max(opts.min, v) : v;
        commit();
      });
      input.addEventListener("change", () => {
        input.value = this.data[key].toFixed(opts.digits);
      });
      row.appendChild(lab);
      row.appendChild(input);
      root.appendChild(row);
    };

    // scale —— 把剪影放大缩小；1 = 与本体同尺寸。
    addNumberRow("Scale X", "scaleX", { step: 0.05, digits: 2, min: 0 });
    addNumberRow("Scale Y", "scaleY", { step: 0.05, digits: 2, min: 0 });

    // skew —— 让剪影做"歪倒"投影，比如墙上人形阴影。度数。
    addNumberRow("Skew X (°)", "skewX", { step: 1, digits: 1 });
    addNumberRow("Skew Y (°)", "skewY", { step: 1, digits: 1 });

    return root;
  }
}
