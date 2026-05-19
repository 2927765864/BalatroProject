/**
 * UIHierarchy
 * ---------------------------------------------------------------
 * 单例，掌管全工程的 UINode：
 *   - 按 id 索引节点。
 *   - 维护"显示顺序"（兄弟节点之间的排序）。
 *   - 把节点状态序列化到 CONFIG.uiNodes，启动 / preset 切换时反向恢复。
 *   - 向订阅者（主要是 ControlPanel）广播变化。
 *
 * 这里只描述"hierarchy 这种数据结构"，并不直接渲染 DOM。
 * DOM 渲染由 debug/ControlPanel + debug/HierarchyView 完成。
 */
import type { UINode } from "./UINode";
import {
  componentRegistry,
  type SerializedComponent,
} from "./UIComponent";
import { CONFIG, type UINodeSerialized } from "@game/config";

export type HierarchyEventType =
  | "nodeAdded"
  | "nodeRemoved"
  | "nodeReparented"
  | "nodeReordered"
  | "componentsChanged"
  | "transformChanged"
  | "tree";

export type HierarchyListener = (type: HierarchyEventType, node?: UINode) => void;

class UIHierarchyImpl {
  /** id → node */
  private readonly nodes = new Map<string, UINode>();
  /** 订阅者集合（ControlPanel 内的 hierarchy view）。 */
  private readonly listeners = new Set<HierarchyListener>();
  /**
   * 首次 hydrate 完成前，节点仍在逐个注册。
   * 此时写回 CONFIG.uiNodes 会用“尚未完整注册的树”覆盖已读取的本地存档。
   */
  private hydratedOnce = false;
  /**
   * 静默模式：hydrateFromConfig 等批量重建 hierarchy 状态期间打开，
   * 跳过 persist 写回 + 暂缓向 listener 派发"tree"重绘信号，
   * 避免反序列化过程中把"还没完成同步"的中间态写回 CONFIG。
   */
  private silent = false;

  // ---- 注册 / 注销 -------------------------------------------------

  /**
   * 构造 UINode 时调用。如果同 id 已存在（理论上不应发生），后注册者覆盖前一个。
   * 注册后立即尝试用 CONFIG 里已有的存档数据来"初始化"该节点。
   */
  register(node: UINode): void {
    if (this.nodes.has(node.nodeId)) {
      console.warn(`[UIHierarchy] id 重复：${node.nodeId}`);
    }
    this.nodes.set(node.nodeId, node);

    // 灌存档字段。这里有"被动写入子组件"的副作用（addComponent → 触发 notify），
    // 把它们临时静默掉，避免在 register 期间反复 persist 中间态。
    const wasSilent = this.silent;
    this.silent = true;
    try {
      this.applyConfigToNode(node);
    } finally {
      this.silent = wasSilent;
    }

    if (!this.silent && this.hydratedOnce) this.persist();
    this.emit("nodeAdded", node);
    this.emit("tree");
  }

  /** UINode.destroy 中调用。 */
  unregister(node: UINode): void {
    if (!this.nodes.has(node.nodeId)) return;
    this.nodes.delete(node.nodeId);
    this.emit("nodeRemoved", node);
    this.emit("tree");
  }

  get(id: string): UINode | undefined {
    return this.nodes.get(id);
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  /** 当前注册过的所有节点（顺序不保证，渲染用 listChildrenInOrder）。 */
  allNodes(): UINode[] {
    return [...this.nodes.values()];
  }

  // ---- 树形查询：根据"当前 PIXI 父子"返回层级结构 -----------------

  /**
   * Hierarchy 的"根节点"列表：在所有已注册的 UINode 中，
   * 那些"父链上没有任何 UINode"的节点。
   * 它们就是面板里第一层显示的条目。
   */
  rootNodes(): UINode[] {
    const result: UINode[] = [];
    for (const node of this.nodes.values()) {
      if (!this.findNearestUINodeParent(node)) result.push(node);
    }
    return this.sortByPixiOrder(result);
  }

  /**
   * 返回某个 UINode 直接挂着的、属于 UINode 的子节点（跳过中间的普通 Container）。
   * 这样：
   *   - 我们的 Panel/Button 即使被包了一层 Graphics 也不会被列错；
   *   - 普通的 PIXI.Container（不是 UINode）不会出现在 Hierarchy 里。
   */
  childrenOf(node: UINode): UINode[] {
    const out: UINode[] = [];
    this.collectUINodeDescendants(node, out, /*onlyDirect*/ true);
    return this.sortByPixiOrder(out);
  }

  /** 找到 node 沿 parent 链向上遇到的第一个 UINode。 */
  private findNearestUINodeParent(node: UINode): UINode | null {
    let p = node.parent as unknown;
    while (p) {
      if (this.isUINode(p)) return p as UINode;
      p = (p as { parent?: unknown }).parent;
    }
    return null;
  }

  /** 递归收集 UINode 子孙；onlyDirect=true 时只算"中间隔了普通 Container"的直接 UINode 子。 */
  private collectUINodeDescendants(
    root: UINode,
    out: UINode[],
    onlyDirect: boolean,
  ): void {
    // 在 PIXI 树里向下走
    const stack: unknown[] = [...(root.children as unknown[])];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur) continue;
      if (this.isUINode(cur)) {
        out.push(cur as UINode);
        if (!onlyDirect) {
          for (const c of (cur as UINode).children as unknown[]) stack.push(c);
        }
        // onlyDirect 时遇到 UINode 就停，里面的孙子由它自己一层处理
      } else {
        for (const c of ((cur as { children?: unknown[] }).children ?? []))
          stack.push(c);
      }
    }
  }

  private isUINode(obj: unknown): boolean {
    return (
      obj !== null &&
      typeof obj === "object" &&
      typeof (obj as { nodeId?: unknown }).nodeId === "string"
    );
  }

  /**
   * 按 PIXI children 顺序排列；同一 PIXI 父下兄弟节点的视觉顺序也以此为准。
   * 顺序信息直接来自 child.parent.children 数组下标。
   */
  private sortByPixiOrder(nodes: UINode[]): UINode[] {
    return nodes.slice().sort((a, b) => {
      const pa = a.parent;
      const pb = b.parent;
      if (pa && pb && pa === pb) {
        return pa.children.indexOf(a) - pb.children.indexOf(b);
      }
      // 不同父：用 zIndex 兜底，再 fallback name
      return (a.zIndex || 0) - (b.zIndex || 0);
    });
  }

  // ---- 父子 / 排序 操作 -----------------------------------------

  /**
   * 把 child 重新挂到 newParent 下；newParent=null 表示挂回原始世界根。
   * 注意：transform 不做"换坐标系下重算"，按 Unity 的常规做法直接保留 local 值，
   * 视觉位置会随之变化——用户在 Hierarchy 里看到的就是真实场景图变化。
   */
  reparent(child: UINode, newParent: UINode | null, worldRoot: import("pixi.js").Container): void {
    if (newParent && this.isAncestor(child, newParent)) {
      console.warn("[UIHierarchy] 拒绝把节点挂到自己后代下");
      return;
    }
    const target = newParent ?? worldRoot;
    if (child.parent === target) return;
    target.addChild(child);
    this.normalizeRenderOrder(worldRoot);
    this.emit("nodeReparented", child);
    this.emit("tree");
    this.persist();
  }

  /** child 是否是 maybeDescendant 的祖先（防环）。 */
  private isAncestor(child: UINode, maybeDescendant: UINode): boolean {
    let p: unknown = maybeDescendant;
    while (p) {
      if (p === child) return true;
      p = (p as { parent?: unknown }).parent;
    }
    return false;
  }

  /**
   * 兄弟节点重排：把 node 放到同父 siblings 的指定 index。
   * index 是"目标在 UINode 兄弟序列中的位置"，内部转换成 PIXI children 的 setChildIndex。
   */
  reorder(node: UINode, targetIndex: number): void {
    const parent = node.parent;
    if (!parent) return;
    const all = parent.children;
    if (!all.includes(node)) return;

    // targetIndex 是 UINode 兄弟序列里的下标，不是 PIXI children 的绝对下标。
    // 只重排 UINode 槽位，保持背景 Graphics 等父级内部显示对象停在原位置。
    const slots: number[] = [];
    const uiChildren: UINode[] = [];
    all.forEach((child, index) => {
      if (!this.isUINode(child)) return;
      slots.push(index);
      uiChildren.push(child as UINode);
    });
    const oldIdx = uiChildren.indexOf(node);
    if (oldIdx < 0) return;
    uiChildren.splice(oldIdx, 1);
    const clamped = Math.max(0, Math.min(targetIndex, uiChildren.length));
    uiChildren.splice(clamped, 0, node);
    uiChildren.forEach((child, index) => {
      const slot = slots[index];
      if (slot !== undefined) parent.setChildIndex(child, slot);
    });
    this.normalizeContainer(parent as import("pixi.js").Container);
    this.emit("nodeReordered", node);
    this.emit("tree");
    this.persist();
  }

  /**
   * 统一渲染规则：
   * - 同一层级：Hierarchy 里从上到下，就是 PIXI 里从先到后渲染；
   * - 父子关系：父 UINode 自己的内部显示对象先渲染，UINode 子节点后渲染。
   */
  private normalizeRenderOrder(worldRoot: import("pixi.js").Container): void {
    this.normalizeContainer(worldRoot);
  }

  private normalizeContainer(container: import("pixi.js").Container): void {
    if (this.isUINode(container)) {
      container.sortableChildren = false;
      const uiChildren = container.children.filter((child) => this.isUINode(child));
      for (const child of uiChildren) {
        container.setChildIndex(child, container.children.length - 1);
      }
    }

    for (const child of [...container.children]) {
      if (this.isUINode(child)) {
        this.normalizeContainer(child as import("pixi.js").Container);
      }
    }
  }

  private uiSiblingIndex(node: UINode): number {
    const parent = node.parent;
    if (!parent) return 0;
    let index = 0;
    for (const child of parent.children) {
      if (!this.isUINode(child)) continue;
      if (child === node) return index;
      index += 1;
    }
    return index;
  }

  // ---- 组件变化（仅广播 + 持久化）-------------------------------

  notifyComponentsChanged(node: UINode): void {
    if (this.silent) return;
    // 节点尚未 register（典型场景：UINode 子类 constructor 里调 addComponent）
    // 此时它自己都还不在 this.nodes 里，去 persist 没有意义，反而可能让 persist
    // 拿到“半成品”的兄弟顺序。等节点真正 register 时会自动写入 CONFIG.uiNodes。
    if (!this.nodes.has(node.nodeId)) return;
    this.emit("componentsChanged", node);
    this.persist();
  }

  notifyTransformChanged(node: UINode): void {
    if (this.silent) return;
    if (!this.nodes.has(node.nodeId)) return;
    this.emit("transformChanged", node);
    this.persist();
  }

  // ---- 订阅 ----------------------------------------------------

  subscribe(listener: HierarchyListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(type: HierarchyEventType, node?: UINode): void {
    for (const fn of this.listeners) {
      try {
        fn(type, node);
      } catch (err) {
        console.error("[UIHierarchy] listener 抛错：", err);
      }
    }
  }

  // ---- 持久化 ---------------------------------------------------

  /**
   * 把指定节点的"已持久化数据"灌入它现在的组件实例：
   *   - components 列表对齐（按存档增删）
   *   - 每个组件 deserialize 字段
   *   - 调一次 apply 让数据写回宿主
   *
   * 注意：父子关系 / 兄弟顺序的恢复在 hydrateFromConfig 中统一做，
   * 因为节点是按"构造顺序"逐个 register 进来的，单点 apply 时还看不到全部兄弟。
   */
  applyConfigToNode(node: UINode): void {
    const saved = CONFIG.uiNodes?.[node.nodeId];
    if (!saved) return;

    // 1) 同步组件列表：先按存档清掉"应该存在但还没存在"的可加组件
    const savedComps = saved.components ?? [];
    for (const sc of savedComps) {
      if (!node.getComponent(sc.type)) {
        const comp = componentRegistry.create(sc.type);
        if (comp) node.addComponent(comp);
      }
    }
    // 2) 反序列化每个组件的字段
    for (const comp of node.listComponents()) {
      const sc = savedComps.find((s) => s.type === comp.type);
      if (sc) {
        try {
          comp.deserialize(sc.data);
        } catch (err) {
          console.error(
            `[UIHierarchy] 组件 ${comp.type} 反序列化失败：`,
            err,
          );
        }
      }
    }
    // 3) 让所有组件把字段 apply 到宿主
    for (const comp of node.listComponents()) {
      try {
        comp.apply();
      } catch (err) {
        console.error(`[UIHierarchy] 组件 ${comp.type} apply 失败：`, err);
      }
    }
  }

  /**
   * 全量再走一遍：在 preset 整体载入后被调用。
   * 顺序：
   *   1) 先按存档的 parentId / siblingIndex 修复树结构（reparent + setChildIndex）。
   *   2) 然后逐节点 applyConfigToNode 灌字段。
   */
  hydrateFromConfig(worldRoot: import("pixi.js").Container): void {
    const data = CONFIG.uiNodes ?? {};
    this.silent = true;

    // 第一遍：reparent
    for (const id of Object.keys(data)) {
      const node = this.nodes.get(id);
      if (!node) continue;
      const parentId = data[id]!.parentId;
      const newParent = parentId ? this.nodes.get(parentId) ?? null : null;
      const target = newParent ?? worldRoot;
      if (node.parent !== target) target.addChild(node);
    }

    // 第二遍：每个父下兄弟按存档的 siblingIndex 排序（缺省值放最后）
    //
    // ⚠️ 重要：PIXI children 数组里除了 UINode 还可能混着"非 UINode 的子"
    // （典型例子：Panel 内部 addChild 的背景 Graphics `g`）。如果直接对 UINode
    // 用 setChildIndex(node, 0/1/2...)，会把那些非 UINode 子挤到数组末尾，
    // 视觉上就是"背景被画到了最上面、把里面的文字/图标盖住"——这正是
    // 之前"父盖子"的根本原因。
    //
    // 正确做法：把 UINode 子按存档顺序排好后，逐个放到"原本属于 UINode 的槽位"，
    // 非 UINode 子保持它们当前在 children 中的位置不动。
    const byParent = new Map<unknown, Array<{ node: UINode; idx: number }>>();
    for (const id of Object.keys(data)) {
      const node = this.nodes.get(id);
      if (!node || !node.parent) continue;
      const idx = data[id]!.siblingIndex ?? Number.MAX_SAFE_INTEGER;
      const list = byParent.get(node.parent) ?? [];
      list.push({ node, idx });
      byParent.set(node.parent, list);
    }
    for (const [parent, list] of byParent.entries()) {
      list.sort((a, b) => a.idx - b.idx);
      const container = parent as import("pixi.js").Container;
      // 找出当前 children 数组里属于 UINode 的"槽位"（绝对下标，升序）。
      // 注意：这些下标在 setChildIndex 期间会随着 UINode 子之间互相移动
      // 而变化，但因为我们只在 UINode 之间互相重排、不动非 UINode 子，
      // 所以"第 k 个 UINode 子所在的下标"始终等于 uiNodeSlots[k]。
      const uiNodeSlots: number[] = [];
      container.children.forEach((c, i) => {
        if (this.isUINode(c)) uiNodeSlots.push(i);
      });
      list.forEach(({ node }, i) => {
        const slot = uiNodeSlots[i];
        if (slot === undefined) return;
        container.setChildIndex(node, slot);
      });
    }

    this.normalizeRenderOrder(worldRoot);

    // 第三遍：灌字段
    for (const node of this.nodes.values()) this.applyConfigToNode(node);

    this.silent = false;
    this.hydratedOnce = true;
    this.persist();
    this.emit("tree");
  }

  /**
   * 把当前 hierarchy 状态写回 CONFIG.uiNodes。
   *
   * 关键：在 hydrate 完成前，UINode 是按构造顺序逐个 register 的。期间任意一个节点
   * 触发 notifyComponentsChanged / notifyTransformChanged 都会调到这里——但此时
   * `this.nodes` 里只有“已 register 过的子集”。如果直接整张表覆盖写，就会把
   *   - 还没 register 的节点（构造队列里排在后面的）的存档条目
   *   - 通过 `hideInHierarchy` 等方式不参与 hierarchy 的节点
   * 全部抹掉。
   *
   * 因此 persist 必须做“增量更新”：只覆盖已注册节点的条目，保留其余条目原样。
   * 只有在 hydrateFromConfig 末尾（确认所有节点都注册完）才考虑“删掉孤儿条目”。
   */
  persist(): void {
    const out: Record<string, UINodeSerialized> = { ...(CONFIG.uiNodes ?? {}) };
    for (const node of this.nodes.values()) {
      const parent = this.findNearestUINodeParent(node);
      const siblingIndex = this.uiSiblingIndex(node);
      const components: SerializedComponent[] = node
        .listComponents()
        .map((c) => c.serialize());
      out[node.nodeId] = {
        parentId: parent ? parent.nodeId : null,
        siblingIndex,
        components,
      };
    }
    CONFIG.uiNodes = out;
  }
}

export const uiHierarchy = new UIHierarchyImpl();
