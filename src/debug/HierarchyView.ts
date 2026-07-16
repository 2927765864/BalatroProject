/**
 * HierarchyView
 * ---------------------------------------------------------------
 * 把 uiHierarchy 渲染成 Unity 风格的 hierarchy 树 + inspector。
 *
 * UI 形态（每个 UI 节点一行）：
 *
 *   ▸  标题栏：[展开箭头] [名字]                          [⠿ drag-handle]
 *   ↓  展开后：
 *        ─ Transform (固定)
 *           x / y / rotation / scaleX / scaleY
 *        ─ 其他组件...（每个都是可折叠的小卡片，右侧有"更多"按钮）
 *        ─ [＋ 添加组件] 下拉
 *      然后是该节点的 UINode 子节点（递归渲染）
 *
 * 深层级自适应：
 *   - 标题栏缩进有硬上限（headerIndentPx），只负责树形视觉。
 *   - 参数区 body 缩进封顶（bodyIndentPx），不随 depth 线性吞宽，
 *     保证 number 输入框始终有可用宽度，数值不会被裁切看不见。
 *
 * 拖拽：
 *   - 拖头部标题栏，drop 到"另一个节点的标题栏中部" → 作为对方的子。
 *   - drop 到节点的"上/下边沿" (前/后 8px) → 作为该节点的兄弟（前/后插入）。
 *   - 不允许拖给自己后代（hierarchy 内部会拒绝）。
 *
 * 整棵树由 uiHierarchy 的 "tree" 事件触发增量重绘；
 * inspector 展开状态由 expandedNodes 集合记忆，重绘后保留。
 */
import {
  uiHierarchy,
  componentRegistry,
  UIComponent,
} from "@ui/hierarchy";
import type { UINode } from "@ui/hierarchy";
import type { Container } from "pixi.js";

/**
 * 组件参数剪贴板：进程内单例，存放最近一次"复制"的组件序列化数据。
 *
 * 隔离规则：粘贴时**只有相同 type 的组件**才接受这份数据。
 * 这样：
 *   - 拷贝一个 Transform 不会被错误粘到 Shadow 上；
 *   - 拷贝一个 BreathingText 也不会污染其它组件；
 *   - 同类型粘贴时直接 deserialize（与读取本地预设走的是同一代码路径）。
 */
const componentClipboard: { type: string | null; data: Record<string, unknown> | null } = {
  type: null,
  data: null,
};

function copyComponentToClipboard(comp: UIComponent): void {
  const serialized = comp.serialize();
  // 深拷贝避免后续编辑串味——JSON 往返是最稳的方案，组件数据都是可序列化的。
  componentClipboard.type = serialized.type;
  componentClipboard.data = JSON.parse(JSON.stringify(serialized.data));
}

function canPasteToComponent(comp: UIComponent): boolean {
  return componentClipboard.type === comp.type && componentClipboard.data !== null;
}

function pasteComponentFromClipboard(node: UINode, comp: UIComponent): boolean {
  if (!canPasteToComponent(comp)) return false;
  try {
    comp.deserialize(componentClipboard.data as Record<string, unknown>);
    comp.apply();
    uiHierarchy.notifyComponentsChanged(node);
    return true;
  } catch (err) {
    console.error("[HierarchyView] 粘贴组件参数失败：", err);
    return false;
  }
}

// 把"用户操作触发的 hierarchy 重渲"的语义注入。
// notifyComponentsChanged 默认会被 HierarchyView 忽略（保护正在输入的字段），
// 但在"粘贴参数"这种**整组字段被替换**的场景里，必须强制重画 inspector，
// 否则面板上看到的还是旧值（DOM 与 component.data 失同步）。
const FORCE_RERENDER_TOPIC = "ui-hier-force-rerender";
function dispatchForceRerender(): void {
  window.dispatchEvent(new CustomEvent(FORCE_RERENDER_TOPIC));
}

interface HierarchyViewOptions {
  /** 放置树 DOM 的容器。 */
  mount: HTMLElement;
  /** worldRoot 引用：拖到"空白根"上时用来 reparent。 */
  worldRoot: Container;
}

export class HierarchyView {
  private readonly mount: HTMLElement;
  private readonly worldRoot: Container;
  private readonly expanded = new Set<string>();
  private readonly expandedComponents = new Set<string>();
  /** 节流：在多个 hierarchy 事件接连发生时只重绘一次。 */
  private renderScheduled = false;
  private readonly unsubscribe: () => void;
  private forceRerenderHandler: (() => void) | null = null;

  constructor(opts: HierarchyViewOptions) {
    this.mount = opts.mount;
    this.worldRoot = opts.worldRoot;
    this.mount.classList.add("ui-hier-tree");

    this.unsubscribe = uiHierarchy.subscribe((type) => {
      // transformChanged / componentsChanged 来自 inspector 字段的"边输入边提交"
      // （TransformComponent / ShadowComponent / TweenComponent 等）。这两类事件
      // 是字段自己已经写回 PIXI、自己已经在 DOM 上反映了新值，**不需要重绘整棵
      // hierarchy 树**。如果在这里重绘，输入框会被 innerHTML="" 销毁重建，
      // 用户就会丢焦点、丢滚动位置、丢光标位置。
      //
      // 注意：添加/删除组件同样会 emit componentsChanged，但那是**结构变化**，
      // DOM 列表必须更新。这类路径应在调用处显式 scheduleRender()（或
      // dispatchForceRerender），而不是靠本订阅自动重绘。
      if (type === "transformChanged" || type === "componentsChanged") return;
      this.scheduleRender();
    });
    // "粘贴组件参数"等整组字段被替换的场景：必须强制重画，让 inspector 的
    // 输入控件读出最新值。普通的"边输入边改值"场景仍走上面那条静默路径。
    this.forceRerenderHandler = (): void => this.scheduleRender();
    window.addEventListener(FORCE_RERENDER_TOPIC, this.forceRerenderHandler);
    this.scheduleRender();
  }

  destroy(): void {
    this.unsubscribe();
    if (this.forceRerenderHandler) {
      window.removeEventListener(FORCE_RERENDER_TOPIC, this.forceRerenderHandler);
      this.forceRerenderHandler = null;
    }
    this.mount.innerHTML = "";
  }

  /**
   * 编辑模式拾取后：沿祖先链逐级展开目标节点，展开其全部组件卡片，
   * 重绘后滚动到视图内，并短暂高亮节点标题 + inspector（点击后闪一下即消失）。
   *
   * @returns 是否找到并揭示了该节点
   */
  revealAndHighlight(nodeId: string): boolean {
    const node = uiHierarchy.get(nodeId);
    if (!node) return false;

    // 祖先链（根 → 父）全部展开，目标自身也展开以便看到参数。
    const chain: UINode[] = [];
    let cur: UINode | null = node;
    while (cur) {
      chain.unshift(cur);
      cur = cur.findUINodeParent();
    }
    for (const n of chain) {
      this.expanded.add(n.nodeId);
    }
    // 展开该节点上所有组件，参数直接可见。
    for (const comp of node.listComponents()) {
      this.expandedComponents.add(this.componentKey(node, comp));
    }

    this.render();

    const header = this.mount.querySelector<HTMLElement>(
      `.ui-hier-header[data-id="${cssEscape(nodeId)}"]`,
    );
    const wrap = this.mount.querySelector<HTMLElement>(
      `.ui-hier-node[data-id="${cssEscape(nodeId)}"]`,
    );
    const inspector = wrap?.querySelector<HTMLElement>(".ui-hier-inspector") ?? null;

    header?.classList.add("is-edit-picked");
    inspector?.classList.add("is-edit-picked");
    wrap?.classList.add("is-edit-picked-node");

    // 滚到可视区（优先滚 header）。
    header?.scrollIntoView({ block: "nearest", behavior: "smooth" });

    // 高亮在"点击操作"之后短暂停留再消失（不阻塞后续编辑）。
    window.setTimeout(() => {
      header?.classList.remove("is-edit-picked");
      inspector?.classList.remove("is-edit-picked");
      wrap?.classList.remove("is-edit-picked-node");
    }, 1400);

    return true;
  }

  // ---- 渲染 ----------------------------------------------------

  private scheduleRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    queueMicrotask(() => {
      this.renderScheduled = false;
      this.render();
    });
  }

  private render(): void {
    // 兜底：保留可滚动祖先的 scrollTop，避免增删/重排事件触发重绘后视图跳到顶部。
    const scroller = this.findScrollAncestor(this.mount);
    const savedScrollTop = scroller ? scroller.scrollTop : 0;

    this.mount.innerHTML = "";

    const roots = uiHierarchy.rootNodes();
    if (roots.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ui-hier-empty";
      empty.textContent = "（暂无 UI 节点）";
      this.mount.appendChild(empty);
      if (scroller) scroller.scrollTop = savedScrollTop;
      return;
    }

    for (const root of roots) {
      this.mount.appendChild(this.renderNode(root, 0));
    }

    if (scroller) scroller.scrollTop = savedScrollTop;
  }

  /** 向上找第一个真正可垂直滚动的祖先（含自己）。找不到则返回 null。 */
  private findScrollAncestor(el: HTMLElement): HTMLElement | null {
    let cur: HTMLElement | null = el;
    while (cur && cur !== document.body) {
      const style = getComputedStyle(cur);
      const oy = style.overflowY;
      if ((oy === "auto" || oy === "scroll") && cur.scrollHeight > cur.clientHeight) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  /**
   * 树标题栏缩进：保留层级感，但硬封顶，避免深层级把整行文字/手柄挤没。
   * 前若干层按 STEP 累加，之后不再变宽。
   */
  private headerIndentPx(depth: number): number {
    const STEP = 10;
    const BASE = 4;
    const MAX = 56; // ~5 层后封顶
    return Math.min(BASE + depth * STEP, MAX);
  }

  /**
   * Inspector 区域缩进：只做「从属关系」的轻微视觉提示，**不随 depth 线性变窄**。
   * 深层级参数输入框必须保留可用宽度，否则数值会被裁切看不见。
   */
  private bodyIndentPx(depth: number): number {
    const STEP = 4;
    const BASE = 10;
    const MAX = 22;
    return Math.min(BASE + depth * STEP, MAX);
  }

  private renderNode(node: UINode, depth: number): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "ui-hier-node";
    wrap.dataset["id"] = node.nodeId;
    wrap.dataset["depth"] = String(depth);

    // === 标题栏 ===
    const header = document.createElement("div");
    header.className = "ui-hier-header";
    header.draggable = true;
    header.dataset["id"] = node.nodeId;

    // 展开箭头
    const arrow = document.createElement("span");
    arrow.className = "ui-hier-arrow";
    const expanded = this.expanded.has(node.nodeId);
    arrow.textContent = expanded ? "▼" : "▶";
    arrow.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.expanded.has(node.nodeId)) this.expanded.delete(node.nodeId);
      else this.expanded.add(node.nodeId);
      this.scheduleRender();
    });
    header.appendChild(arrow);

    // 缩进：仅标题栏随深度变化（有上限），参数区另算
    header.style.paddingLeft = `${this.headerIndentPx(depth)}px`;

    // 名字
    const name = document.createElement("span");
    name.className = "ui-hier-name";
    name.textContent = node.displayName;
    name.title = node.nodeId;
    header.appendChild(name);

    // drag handle 视觉
    const handle = document.createElement("span");
    handle.className = "ui-hier-handle";
    handle.textContent = "⠿";
    header.appendChild(handle);

    // 拖拽事件
    this.bindDrag(header, node);

    wrap.appendChild(header);

    // === 展开内容：inspector + 子节点 ===
    if (expanded) {
      const body = document.createElement("div");
      body.className = "ui-hier-body";
      // 参数区几乎全宽：小缩进 + 左侧导向线（见 CSS），避免深度累加吃掉输入框
      body.style.marginLeft = `${this.bodyIndentPx(depth)}px`;
      body.dataset["depth"] = String(depth);

      // inspector：组件列表
      body.appendChild(this.renderInspector(node));

      wrap.appendChild(body);

      // 子节点
      for (const child of uiHierarchy.childrenOf(node)) {
        wrap.appendChild(this.renderNode(child, depth + 1));
      }
    }

    return wrap;
  }

  // ---- inspector --------------------------------------------------

  private renderInspector(node: UINode): HTMLElement {
    const root = document.createElement("div");
    root.className = "ui-hier-inspector";

    for (const comp of node.listComponents()) {
      root.appendChild(this.renderComponent(node, comp));
    }

    // 添加组件
    root.appendChild(this.renderAddComponent(node));

    return root;
  }

  private renderComponent(node: UINode, comp: UIComponent): HTMLElement {
    const card = document.createElement("div");
    const key = this.componentKey(node, comp);
    const expanded = this.expandedComponents.has(key);
    card.className = expanded ? "ui-comp-card is-open" : "ui-comp-card";

    const head = document.createElement("div");
    head.className = "ui-comp-head";
    head.title = expanded ? "点击收起组件" : "点击展开组件";
    head.addEventListener("click", () => {
      if (this.expandedComponents.has(key)) this.expandedComponents.delete(key);
      else this.expandedComponents.add(key);
      this.scheduleRender();
    });

    const arrow = document.createElement("span");
    arrow.className = "ui-comp-arrow";
    arrow.textContent = expanded ? "▼" : "▶";
    head.appendChild(arrow);

    const title = document.createElement("span");
    title.className = "ui-comp-title";
    title.textContent = comp.displayName;
    head.appendChild(title);

    // "更多"按钮：弹出菜单，里面有"复制本组件参数 / 粘贴参数 / 删除本组件"
    // 三个操作。Transform / TextStyle 这类 removable=false 的组件仍然有按钮，
    // 但"删除"项会被禁用（这样它们也支持复制 / 粘贴参数）。
    const more = document.createElement("button");
    more.type = "button";
    more.className = "ui-comp-more";
    more.textContent = "更多";
    more.title = `${comp.displayName} 的操作`;
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showComponentMenu(more, node, comp);
    });
    head.appendChild(more);
    card.appendChild(head);

    if (expanded) {
      // 组件自身渲染
      try {
        const body = comp.buildInspector();
        card.appendChild(body);
      } catch (err) {
        const errEl = document.createElement("div");
        errEl.className = "ui-comp-error";
        errEl.textContent = `inspector 抛错：${String(err)}`;
        card.appendChild(errEl);
      }
    }

    return card;
  }

  private componentKey(node: UINode, comp: UIComponent): string {
    return `${node.nodeId}/${comp.type}`;
  }

  // ---- "更多"弹出菜单 -------------------------------------------

  /**
   * 在 anchor 按钮旁弹出一个浮层菜单，包含三个操作：
   *   - 复制本组件参数
   *   - 粘贴参数到本组件（只有剪贴板上的组件 type 与本组件一致时可用）
   *   - 删除本组件（comp.removable=false 时禁用）
   *
   * 同时刻只允许一个菜单打开：再次点击或点其它地方会关掉旧的。
   */
  private showComponentMenu(anchor: HTMLElement, node: UINode, comp: UIComponent): void {
    // 已经有同源菜单 → 当作 toggle 关掉。
    const existing = document.querySelector<HTMLElement>(".ui-comp-menu");
    if (existing) {
      const sameAnchor = existing.dataset["anchorKey"] === this.componentKey(node, comp);
      existing.remove();
      if (sameAnchor) return;
    }

    const menu = document.createElement("div");
    menu.className = "ui-comp-menu";
    menu.dataset["anchorKey"] = this.componentKey(node, comp);

    const makeItem = (
      label: string,
      enabled: boolean,
      onClick: () => void,
      opts: { destructive?: boolean } = {},
    ): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ui-comp-menu-item";
      if (opts.destructive) btn.classList.add("is-destructive");
      btn.textContent = label;
      btn.disabled = !enabled;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        menu.remove();
        if (enabled) onClick();
      });
      return btn;
    };

    menu.appendChild(
      makeItem("复制本组件的参数", true, () => {
        copyComponentToClipboard(comp);
      }),
    );

    const canPaste = canPasteToComponent(comp);
    menu.appendChild(
      makeItem(
        canPaste ? "粘贴参数到本组件" : "粘贴参数到本组件（无匹配剪贴板）",
        canPaste,
        () => {
          if (pasteComponentFromClipboard(node, comp)) {
            // 整组字段被替换：强制重绘 hierarchy 树，让 inspector 上的输入控件
            // 读到最新数据（普通的"边输入边改"路径不会重绘）。
            dispatchForceRerender();
          }
        },
      ),
    );

    menu.appendChild(
      makeItem(
        comp.removable ? "删除本组件" : "删除本组件（固定组件不可删）",
        comp.removable,
        () => {
          node.removeComponent(comp.type);
          // componentsChanged 会被订阅方忽略（保护字段编辑焦点），
          // 删除是结构变化，必须强制重绘 inspector。
          this.expandedComponents.delete(this.componentKey(node, comp));
          this.scheduleRender();
        },
        { destructive: true },
      ),
    );

    // 摆位：紧贴 anchor 按钮的下方，相对 viewport 定位。
    const rect = anchor.getBoundingClientRect();
    document.body.appendChild(menu);
    // 先临时显示，量自身宽高再贴边修正。
    const menuRect = menu.getBoundingClientRect();
    let left = rect.right - menuRect.width;
    let top = rect.bottom + 4;
    if (left < 4) left = 4;
    if (left + menuRect.width > window.innerWidth - 4) {
      left = Math.max(4, window.innerWidth - 4 - menuRect.width);
    }
    if (top + menuRect.height > window.innerHeight - 4) {
      // 翻到上方
      top = Math.max(4, rect.top - menuRect.height - 4);
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    // 点击空白处自动关闭。用 capture 阶段抢在按钮 click 之前。
    const dismiss = (e: Event): void => {
      // 忽略输入框失去焦点等元素级别的 blur 事件，仅在 window 级别 blur（如切换标签页）时才关闭
      if (e.type === "blur" && e.target !== window) return;
      if (e.target instanceof Node && menu.contains(e.target)) return;
      menu.remove();
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("blur", dismiss, true);
    };
    // 微延迟，避免本次 click 立即触发 dismiss。
    window.setTimeout(() => {
      window.addEventListener("pointerdown", dismiss, true);
      window.addEventListener("blur", dismiss, true);
    }, 0);
  }

  private renderAddComponent(node: UINode): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "ui-comp-add";

    const sel = document.createElement("select");
    sel.className = "panel-select";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "＋ 添加组件";
    sel.appendChild(placeholder);

    const available = componentRegistry
      .listAddable()
      // 同一节点同类型组件只允许一份，已经挂上的类型从下拉里去掉
      .filter((m) => !node.getComponent(m.type))
      // canAttach 自定义过滤：例如 BreathingText 只能挂在 UIText 上。
      .filter((m) => !m.canAttach || m.canAttach(node));

    for (const meta of available) {
      const opt = document.createElement("option");
      opt.value = meta.type;
      opt.textContent = meta.displayName;
      sel.appendChild(opt);
    }

    if (available.length === 0) {
      placeholder.textContent = "（无可添加组件）";
      sel.disabled = true;
    }

    sel.addEventListener("change", () => {
      const type = sel.value;
      if (!type) return;
      const comp = componentRegistry.create(type);
      if (comp) {
        node.addComponent(comp);
        // addComponent 会广播 componentsChanged，但订阅方故意忽略该类事件
        // （避免字段边改边提交时整树重绘导致输入框丢焦点）。添加组件是
        // **结构变化**，必须强制重绘 inspector，否则新卡片要等到下次其它
        // 操作触发 scheduleRender 才会出现。
        this.expandedComponents.add(this.componentKey(node, comp));
        this.scheduleRender();
      }
      sel.value = "";
    });

    wrap.appendChild(sel);
    return wrap;
  }

  // ---- 拖拽 -----------------------------------------------------

  private bindDrag(header: HTMLElement, node: UINode): void {
    header.addEventListener("dragstart", (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/x-ui-node-id", node.nodeId);
      header.classList.add("is-dragging");
    });
    header.addEventListener("dragend", () => {
      header.classList.remove("is-dragging");
      // 清掉所有提示线
      for (const el of this.mount.querySelectorAll<HTMLElement>(".drop-before, .drop-after, .drop-inside")) {
        el.classList.remove("drop-before", "drop-after", "drop-inside");
      }
    });
    header.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!e.dataTransfer) return;
      e.dataTransfer.dropEffect = "move";

      const zone = this.computeDropZone(e, header);
      header.classList.remove("drop-before", "drop-after", "drop-inside");
      header.classList.add(`drop-${zone}`);
    });
    header.addEventListener("dragleave", () => {
      header.classList.remove("drop-before", "drop-after", "drop-inside");
    });
    header.addEventListener("drop", (e) => {
      e.preventDefault();
      const srcId = e.dataTransfer?.getData("text/x-ui-node-id");
      if (!srcId || srcId === node.nodeId) return;
      const src = uiHierarchy.get(srcId);
      if (!src) return;

      const zone = this.computeDropZone(e, header);
      this.applyDrop(src, node, zone);
      header.classList.remove("drop-before", "drop-after", "drop-inside");
    });
  }

  private computeDropZone(e: DragEvent, header: HTMLElement): "before" | "after" | "inside" {
    const rect = header.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const edge = Math.max(6, rect.height * 0.25);
    if (y < edge) return "before";
    if (y > rect.height - edge) return "after";
    return "inside";
  }

  private applyDrop(
    src: UINode,
    target: UINode,
    zone: "before" | "after" | "inside",
  ): void {
    if (zone === "inside") {
      // 拖进 target：作为它的末尾 UINode 子（=Hierarchy 里最下面 = 最后渲染 = 最顶层）
      uiHierarchy.reparent(src, target, this.worldRoot);
      return;
    }
    // 兄弟：先 reparent 到 target 的 UINode 父，再按 UINode 兄弟序列重排
    const targetParentUI = target.findUINodeParent();
    uiHierarchy.reparent(src, targetParentUI, this.worldRoot);

    const siblings = (targetParentUI
      ? uiHierarchy.childrenOf(targetParentUI)
      : uiHierarchy.rootNodes()).filter((n) => n !== src);
    const targetIdx = siblings.indexOf(target);
    if (targetIdx < 0) return;
    const newIdx = zone === "before" ? targetIdx : targetIdx + 1;
    uiHierarchy.reorder(src, newIdx);
  }

}

/** 供 querySelector 使用的 id 转义（兼容无 CSS.escape 的环境）。 */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}
