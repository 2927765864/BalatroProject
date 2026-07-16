/**
 * UIEditModePicker
 * ---------------------------------------------------------------
 * 「界面UI」参数面板的可视化编辑模式：
 *   - 进入后，鼠标悬停到的 UINode 在画面上用矩形高亮；
 *   - 点击第一个命中的 UINode → 回调 onPick，由 HierarchyView 逐级展开并高亮参数；
 *   - 选中后（或 ESC / 再次点按钮）自动退出；画面高亮随之清除。
 *
 * 命中规则：
 *   - 遍历 uiHierarchy 全部已注册节点；
 *   - getBounds() 为屏幕空间 AABB；
 *   - 多节点重叠时优先更深层（子节点），同层取面积更小者。
 *
 * 事件：
 *   - 在 window 上 capture 阶段监听 pointermove / pointerdown，
 *     避免与卡牌、按钮等业务交互抢事件；命中后 stopPropagation + preventDefault。
 *   - 落在 #control-panel / #panel-trigger 上的指针不参与拾取。
 */
import { uiHierarchy, type UINode } from "@ui/hierarchy";

export interface UIEditModePickerOptions {
  /** 选中某个 UINode 时回调（调用方负责展开 hierarchy 并退出编辑模式）。 */
  onPick: (node: UINode) => void;
  /** 编辑模式开关状态变化时回调（用于同步按钮 UI）。 */
  onActiveChange?: (active: boolean) => void;
}

export class UIEditModePicker {
  private active = false;
  private readonly onPick: (node: UINode) => void;
  private readonly onActiveChange?: (active: boolean) => void;
  private readonly highlightEl: HTMLDivElement;
  private readonly labelEl: HTMLDivElement;

  constructor(opts: UIEditModePickerOptions) {
    this.onPick = opts.onPick;
    this.onActiveChange = opts.onActiveChange;

    this.highlightEl = document.createElement("div");
    this.highlightEl.className = "ui-edit-highlight";
    this.highlightEl.setAttribute("aria-hidden", "true");

    this.labelEl = document.createElement("div");
    this.labelEl.className = "ui-edit-highlight-label";
    this.highlightEl.appendChild(this.labelEl);

    document.body.appendChild(this.highlightEl);
    this.hideHighlight();
  }

  isActive(): boolean {
    return this.active;
  }

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    document.body.classList.toggle("ui-edit-mode-active", active);
    if (!active) {
      this.hideHighlight();
    }
    this.onActiveChange?.(active);
  }

  toggle(): void {
    this.setActive(!this.active);
  }

  destroy(): void {
    this.setActive(false);
    this.highlightEl.remove();
    window.removeEventListener("pointermove", this.onPointerMove, true);
    window.removeEventListener("pointerdown", this.onPointerDown, true);
    window.removeEventListener("keydown", this.onKeyDown, true);
  }

  /** 在构造后调用一次，绑定全局监听（始终挂着，内部用 active 门控）。 */
  attach(): void {
    window.addEventListener("pointermove", this.onPointerMove, true);
    window.addEventListener("pointerdown", this.onPointerDown, true);
    window.addEventListener("keydown", this.onKeyDown, true);
  }

  // ---- 事件 ----------------------------------------------------

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.active) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.setActive(false);
    }
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.active) return;
    if (this.isOverChrome(e.target)) {
      this.hideHighlight();
      return;
    }
    const node = this.pickAt(e.clientX, e.clientY);
    if (node) this.showHighlight(node);
    else this.hideHighlight();
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.active) return;
    // 只响应主键，避免右键菜单等干扰。
    if (e.button !== 0) return;
    if (this.isOverChrome(e.target)) return;

    const node = this.pickAt(e.clientX, e.clientY);
    if (!node) return;

    // 吞掉事件，避免误触卡牌点击 / 按钮。
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation?.();

    this.hideHighlight();
    // 先退出编辑模式再回调，避免回调里切 tab 时仍处在吞事件状态。
    this.setActive(false);
    try {
      this.onPick(node);
    } catch (err) {
      console.error("[UIEditModePicker] onPick 抛错：", err);
    }
  };

  // ---- 命中测试 ------------------------------------------------

  /**
   * 在屏幕坐标 (clientX, clientY) 下找最合适的 UINode。
   * 返回 null 表示空白处。
   */
  private pickAt(clientX: number, clientY: number): UINode | null {
    let best: UINode | null = null;
    let bestDepth = -1;
    let bestArea = Number.POSITIVE_INFINITY;

    for (const node of uiHierarchy.allNodes()) {
      if (!node || node.destroyed || !node.visible || !this.isWorldVisible(node)) continue;
      if (!this.pointHitsNode(node, clientX, clientY)) continue;

      const depth = this.depthOf(node);
      const area = this.screenArea(node);
      // 更深优先；同深度面积更小优先（更具体的叶子）。
      if (
        depth > bestDepth ||
        (depth === bestDepth && area < bestArea)
      ) {
        best = node;
        bestDepth = depth;
        bestArea = area;
      }
    }
    return best;
  }

  private pointHitsNode(node: UINode, clientX: number, clientY: number): boolean {
    try {
      const b = node.getBounds();
      // 空节点（无几何）跳过
      if (b.width <= 0 || b.height <= 0) return false;
      return (
        clientX >= b.x &&
        clientX <= b.x + b.width &&
        clientY >= b.y &&
        clientY <= b.y + b.height
      );
    } catch {
      return false;
    }
  }

  private screenArea(node: UINode): number {
    try {
      const b = node.getBounds();
      return Math.max(0, b.width) * Math.max(0, b.height);
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  private depthOf(node: UINode): number {
    let d = 0;
    let p: UINode | null = node.findUINodeParent();
    while (p) {
      d += 1;
      p = p.findUINodeParent();
    }
    return d;
  }

  /** 沿 parent 链检查是否全部 visible（PIXI v8 无 worldVisible 时的等价物）。 */
  private isWorldVisible(node: UINode): boolean {
    let cur: { visible?: boolean; parent?: unknown } | null = node;
    while (cur) {
      if (cur.visible === false) return false;
      cur = (cur.parent as { visible?: boolean; parent?: unknown } | null) ?? null;
    }
    return true;
  }

  // ---- 高亮 DOM ------------------------------------------------

  private showHighlight(node: UINode): void {
    try {
      const b = node.getBounds();
      const pad = 2;
      this.highlightEl.style.display = "block";
      this.highlightEl.style.left = `${b.x - pad}px`;
      this.highlightEl.style.top = `${b.y - pad}px`;
      this.highlightEl.style.width = `${Math.max(0, b.width) + pad * 2}px`;
      this.highlightEl.style.height = `${Math.max(0, b.height) + pad * 2}px`;
      this.labelEl.textContent = node.displayName || node.nodeId;
    } catch {
      this.hideHighlight();
    }
  }

  private hideHighlight(): void {
    this.highlightEl.style.display = "none";
    this.labelEl.textContent = "";
  }

  /** 指针是否落在调参面板 / 触发器等调试 chrome 上（这些区域不拾取）。 */
  private isOverChrome(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return Boolean(
      target.closest("#control-panel") ||
        target.closest("#panel-trigger") ||
        target.closest(".ui-edit-highlight"),
    );
  }
}
