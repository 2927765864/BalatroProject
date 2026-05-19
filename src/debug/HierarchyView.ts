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
 *        ─ 其他组件...（每个都是可折叠的小卡片，右侧有"删除"按钮）
 *        ─ [＋ 添加组件] 下拉
 *      然后是该节点的 UINode 子节点（递归渲染）
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
  /** 节流：在多个 hierarchy 事件接连发生时只重绘一次。 */
  private renderScheduled = false;
  private readonly unsubscribe: () => void;

  constructor(opts: HierarchyViewOptions) {
    this.mount = opts.mount;
    this.worldRoot = opts.worldRoot;
    this.mount.classList.add("ui-hier-tree");

    this.unsubscribe = uiHierarchy.subscribe(() => this.scheduleRender());
    this.scheduleRender();
  }

  destroy(): void {
    this.unsubscribe();
    this.mount.innerHTML = "";
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
    this.mount.innerHTML = "";

    const roots = uiHierarchy.rootNodes();
    if (roots.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ui-hier-empty";
      empty.textContent = "（暂无 UI 节点）";
      this.mount.appendChild(empty);
      return;
    }

    for (const root of roots) {
      this.mount.appendChild(this.renderNode(root, 0));
    }
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

    // 缩进 padding
    header.style.paddingLeft = `${depth * 12 + 4}px`;

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
      body.style.marginLeft = `${depth * 12 + 16}px`;

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
    card.className = "ui-comp-card";

    const head = document.createElement("div");
    head.className = "ui-comp-head";

    const title = document.createElement("span");
    title.className = "ui-comp-title";
    title.textContent = comp.displayName;
    head.appendChild(title);

    if (comp.removable) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "ui-comp-del";
      del.textContent = "删除";
      del.title = `从 ${node.displayName} 移除 ${comp.displayName}`;
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        node.removeComponent(comp.type);
        // hierarchy 会广播 componentsChanged，触发 scheduleRender。
      });
      head.appendChild(del);
    }
    card.appendChild(head);

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

    return card;
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
      .filter((m) => !node.getComponent(m.type));

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
      if (comp) node.addComponent(comp);
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
      // 拖进 target，作为其末尾子节点
      uiHierarchy.reparent(src, target, this.worldRoot);
      return;
    }
    // 兄弟：先 reparent 到 target 的父，再在父的 children 里调整顺序
    const targetParent = target.parent;
    if (!targetParent) return;
    const targetParentUI =
      this.findUINodeAncestor(targetParent) /* 同级 UI 父，可能是 null=worldRoot */;
    uiHierarchy.reparent(src, targetParentUI, this.worldRoot);
    // 计算新顺序
    const siblings = targetParent.children;
    const targetIdx = siblings.indexOf(target);
    if (targetIdx < 0) return;
    const newIdx = zone === "before" ? targetIdx : targetIdx + 1;
    uiHierarchy.reorder(src, newIdx);
  }

  /** 从一个 PIXI 父节点向上找 UINode（找不到返回 null = 视为 worldRoot）。 */
  private findUINodeAncestor(c: Container | null | undefined): UINode | null {
    let cur: unknown = c;
    while (cur) {
      if (typeof (cur as { nodeId?: unknown }).nodeId === "string") {
        return cur as UINode;
      }
      cur = (cur as { parent?: unknown }).parent;
    }
    return null;
  }
}
