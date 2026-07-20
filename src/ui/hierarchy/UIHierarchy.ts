/**
 * UIHierarchy（重做版）
 * ---------------------------------------------------------------
 * 全局 UI 节点登记 + 持久化 + 排序的入口。
 *
 * 唯一渲染规则（请记牢）：
 *   - Hierarchy 面板里同层从上到下 = PIXI 渲染从先到后 = 越上越底层。
 *   - 父先渲染，子后渲染。所有 UINode 子节点永远在父节点末尾。
 *
 * 关键约束：
 *   - 渲染顺序完全由"每个 PIXI Container 内 UINode 子节点位于 children 末尾"
 *     这一不变量决定，不再依赖 zIndex / sortableChildren。
 *   - reparent / reorder 全部以 UINode 兄弟序列为口径，
 *     完成后调一次父节点 resortChildren()，把 UINode 子节点重新压到末尾。
 *
 * persist 行为（CRITICAL）：
 *   - 增量更新 CONFIG.uiNodes：只覆盖已注册节点的条目，保留其它。
 *   - **hydrate 完成前禁止 persist**。
 *     构造期节点先挂在代码默认父下（例如 scorePanel 在 HUD 下），
 *     真正的父子关系只存在于 CONFIG.uiNodes，要等 hydrateFromConfig 的
 *     reparent 通才还原。若在这之前 persist，会把"代码临时父子关系"
 *     写回存档，永久毁掉用户/shipping 布局（历史事故根因）。
 *   - hydrateFromConfig 末尾会强制 sweep 一次，并把 post-hydrate 状态 persist。
 */
import { isUINode, type UINode } from "./UINode";
import {
  componentRegistry,
  type SerializedComponent,
} from "./UIComponent";
import {
  CONFIG,
  activeDefaultConfig,
  type UINodeSerialized,
} from "@game/config";
import type { Container, Renderer, Ticker } from "pixi.js";

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
  /** 首次 hydrate 完成前不允许 persist 覆盖外部存档。 */
  private hydratedOnce = false;
  /** 批量重建期间不广播也不 persist。 */
  private silent = false;
  /** 某些组件（如 ShadowComponent）需要拿 renderer 烤纹理，由 main.ts 注入。 */
  private rendererRef: Renderer | null = null;
  /** 某些组件（如 BreathingTextComponent）需要每帧 tick，由 main.ts 注入 PIXI ticker。 */
  private tickerRef: Ticker | null = null;

  /** main.ts 在 app.init() 之后注入；组件按需读。 */
  setRenderer(r: Renderer | null): void {
    this.rendererRef = r;
  }

  getRenderer(): Renderer | null {
    return this.rendererRef;
  }

  /** main.ts 在 app.init() 之后注入 PIXI ticker；组件按需读。 */
  setTicker(t: Ticker | null): void {
    this.tickerRef = t;
  }

  getTicker(): Ticker | null {
    return this.tickerRef;
  }

  // ---- 注册 / 注销 -------------------------------------------------

  register(node: UINode): void {
    if (this.nodes.has(node.nodeId)) {
      console.warn(`[UIHierarchy] id 重复：${node.nodeId}`);
    }
    this.nodes.set(node.nodeId, node);

    const wasSilent = this.silent;
    this.silent = true;
    try {
      this.applyConfigToNode(node);
    } finally {
      this.silent = wasSilent;
    }

    // 注册时也确保父节点重新排一遍，把这个新 UINode 子压到末尾
    const uiParent = node.findUINodeParent();
    if (uiParent) uiParent.resortChildren();

    if (!this.silent && this.hydratedOnce) this.persist();
    this.emit("nodeAdded", node);
    this.emit("tree");
  }

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

  allNodes(): UINode[] {
    return [...this.nodes.values()];
  }

  // ---- 树形查询 ---------------------------------------------------

  /** Hierarchy 的根节点：父链上没有任何 UINode 的已注册节点。 */
  rootNodes(): UINode[] {
    const result: UINode[] = [];
    for (const node of this.nodes.values()) {
      if (!node.findUINodeParent()) result.push(node);
    }
    return this.sortByPixiOrder(result);
  }

  /** 某个 UINode 直接挂的 UINode 子节点。 */
  childrenOf(node: UINode): UINode[] {
    const out: UINode[] = [];
    this.collectDirectUIChildren(node, out);
    return this.sortByPixiOrder(out);
  }

  private collectDirectUIChildren(root: UINode, out: UINode[]): void {
    const stack: unknown[] = [...(root.children as unknown[])];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur) continue;
      if (isUINode(cur)) {
        out.push(cur);
      } else {
        for (const c of ((cur as { children?: unknown[] }).children ?? []))
          stack.push(c);
      }
    }
  }

  /** 按 PIXI children 出现顺序对兄弟节点排序。 */
  private sortByPixiOrder(nodes: UINode[]): UINode[] {
    return nodes.slice().sort((a, b) => {
      const pa = a.parent;
      const pb = b.parent;
      if (pa && pb && pa === pb) {
        return pa.children.indexOf(a) - pb.children.indexOf(b);
      }
      return 0;
    });
  }

  // ---- 父子 / 排序 -----------------------------------------------

  /**
   * 把 child reparent 到 newParent 下；newParent=null 表示挂到 worldRoot。
   * reparent 后调用新父节点的 resortChildren()，把 UINode 子压到末尾。
   *
   * @param opts.silent 为 true 时不广播、不 persist（供 hydrate 内部批量使用）。
   *   默认 false：交互式拖拽 reparent 会写回存档。
   */
  reparent(
    child: UINode,
    newParent: UINode | null,
    worldRoot: Container,
    opts?: { silent?: boolean },
  ): void {
    if (newParent && this.isAncestor(child, newParent)) {
      console.warn("[UIHierarchy] 拒绝把节点挂到自己后代下");
      return;
    }
    const target = newParent ?? worldRoot;
    if (child.parent === target) return;

    const silent = opts?.silent === true;
    const wasSilent = this.silent;
    if (silent) this.silent = true;

    try {
      // 1) 计算在 target 下保持屏幕世界坐标不变的 local transform 参数
      const W_child = child.getGlobalTransform();
      const W_target = target.getGlobalTransform();

      // 计算 W_target 的逆矩阵
      const det = W_target.a * W_target.d - W_target.b * W_target.c;
      let T_a = 1, T_b = 0, T_c = 0, T_d = 1, T_tx = 0, T_ty = 0;
      if (Math.abs(det) > 1e-6) {
        const inv_det = 1 / det;
        T_a = W_target.d * inv_det;
        T_b = -W_target.b * inv_det;
        T_c = -W_target.c * inv_det;
        T_d = W_target.a * inv_det;
        T_tx = (W_target.c * W_target.ty - W_target.d * W_target.tx) * inv_det;
        T_ty = (W_target.b * W_target.tx - W_target.a * W_target.ty) * inv_det;
      }

      // L = T_target_inv * W_child
      const L_a = T_a * W_child.a + T_c * W_child.b;
      const L_b = T_b * W_child.a + T_d * W_child.b;
      const L_c = T_a * W_child.c + T_c * W_child.d;
      const L_d = T_b * W_child.c + T_d * W_child.d;
      const L_tx = T_a * W_child.tx + T_c * W_child.ty + T_tx;
      const L_ty = T_b * W_child.tx + T_d * W_child.ty + T_ty;

      // 分解 L 矩阵
      const newX = L_tx;
      const newY = L_ty;
      const scaleX = Math.sqrt(L_a * L_a + L_b * L_b);
      const scaleY = Math.sqrt(L_c * L_c + L_d * L_d);
      const newRotation = Math.atan2(L_b, L_a);
      const lDet = L_a * L_d - L_b * L_c;
      const newScaleX = scaleX;
      const newScaleY = lDet < 0 ? -scaleY : scaleY;

      // 2) 真正改变 PIXI 父节点
      target.addChild(child);

      // 3) 设置并应用新的 transform 参数，触发单次更新
      child.transform.setTransformDirect(newX, newY, newRotation, newScaleX, newScaleY);

      // 立即排一次。新父节点是 UINode 时调它自己的 resort；
      // 是 worldRoot 时 UINode 子永远是 worldRoot 的子，不需要规范化。
      if (isUINode(target)) target.resortChildren();
    } finally {
      if (silent) this.silent = wasSilent;
    }

    if (silent) return;
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
   * 兄弟节点重排：把 node 放到同父 UINode 兄弟序列中的 targetIndex 位置。
   * targetIndex 是 UINode 兄弟序列里的下标（0 表最上 = 最先渲染 = 最底层）。
   */
  reorder(node: UINode, targetIndex: number): void {
    const parent = node.parent;
    if (!parent) return;
    if (!parent.children.includes(node)) return;

    // 1) 取当前 UINode 兄弟序列
    const uiSiblings: UINode[] = [];
    for (const child of parent.children) {
      if (isUINode(child)) uiSiblings.push(child);
    }
    const oldIdx = uiSiblings.indexOf(node);
    if (oldIdx < 0) return;

    // 2) 移动后期望的新序列
    uiSiblings.splice(oldIdx, 1);
    const clamped = Math.max(0, Math.min(targetIndex, uiSiblings.length));
    uiSiblings.splice(clamped, 0, node);

    // 3) 写回 PIXI children：UINode 兄弟一律压到 children 末尾，按新顺序排
    //    这步等价于"父节点的内部 UI 在前，UINode 子在后，且 UINode 子之间按新顺序"。
    for (const sibling of uiSiblings) {
      parent.setChildIndex(sibling, parent.children.length - 1);
    }

    if (isUINode(parent)) parent.resortChildren();

    this.emit("nodeReordered", node);
    this.emit("tree");
    this.persist();
  }

  // ---- 组件变化（广播 + 持久化）---------------------------------

  notifyComponentsChanged(node: UINode): void {
    if (this.silent) return;
    if (!this.hydratedOnce) return;
    if (!this.nodes.has(node.nodeId)) return;
    this.emit("componentsChanged", node);
    this.persist();
  }

  notifyTransformChanged(node: UINode): void {
    if (this.silent) return;
    if (!this.hydratedOnce) return;
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

  applyConfigToNode(node: UINode): void {
    const saved = CONFIG.uiNodes?.[node.nodeId];
    if (!saved) return;

    const savedComps = saved.components ?? [];
    for (const sc of savedComps) {
      // 节点主动屏蔽的组件类型（如牌堆数量文字的 shadow）不要从存档复活。
      if (node.isComponentBlocked(sc.type)) continue;
      if (!node.getComponent(sc.type)) {
        const comp = componentRegistry.create(sc.type);
        if (comp) node.addComponent(comp);
      }
    }
    // 若存档里曾有现已屏蔽的组件，确保运行时也不残留。
    for (const sc of savedComps) {
      if (node.isComponentBlocked(sc.type) && node.getComponent(sc.type)) {
        node.removeComponent(sc.type);
      }
    }
    for (const comp of node.listComponents()) {
      if (node.isComponentBlocked(comp.type)) continue;
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
    for (const comp of node.listComponents()) {
      try {
        comp.apply();
      } catch (err) {
        console.error(`[UIHierarchy] 组件 ${comp.type} apply 失败：`, err);
      }
    }
  }

  /**
   * 全量按存档重建：
   *   1) 把每个节点 reparent 到存档里指定的父；
   *   2) 把每个父下 UINode 子按存档 siblingIndex 排好，并统一压到 children 末尾；
   *   3) 灌字段。
   */
  hydrateFromConfig(worldRoot: Container): void {
    // 防御：若运行时 uiNodes 被误清空（例如旧版 applyConfig 在缺字段时写成 {}），
    // 回退到 shipping / activeDefaultConfig，避免把代码硬编码布局 persist 回 CONFIG。
    let data = CONFIG.uiNodes ?? {};
    if (Object.keys(data).length === 0) {
      const fallback = activeDefaultConfig.uiNodes ?? {};
      if (Object.keys(fallback).length > 0) {
        CONFIG.uiNodes = JSON.parse(JSON.stringify(fallback)) as Record<
          string,
          UINodeSerialized
        >;
        data = CONFIG.uiNodes;
        console.warn(
          "[UIHierarchy] CONFIG.uiNodes 为空，已回退到 activeDefaultConfig（shipping）。",
        );
      }
    }
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

    // 第二遍：每个父下 UINode 子按存档 siblingIndex 排，然后压到末尾
    const byParent = new Map<Container, Array<{ node: UINode; idx: number }>>();
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
      for (const { node } of list) {
        parent.setChildIndex(node, parent.children.length - 1);
      }
    }

    // 全局再 sweep 一次，确保任意 UINode 父都满足"UINode 子在末尾"
    this.sweepAllContainers(worldRoot);

    // 第三遍：灌字段
    for (const node of this.nodes.values()) this.applyConfigToNode(node);

    this.silent = false;
    this.hydratedOnce = true;
    this.persist();
    this.emit("tree");
  }

  private sweepAllContainers(root: Container): void {
    if (isUINode(root)) root.resortChildren();
    for (const child of [...root.children]) {
      this.sweepAllContainers(child as Container);
    }
  }

  /**
   * persist：增量写回 CONFIG.uiNodes。
   * siblingIndex 用"该节点在父下 UINode 兄弟序列中的位置"，不混合非 UINode。
   *
   * 守卫：hydrate 完成前一律拒绝写回。构造期树是"代码默认父子"，
   * 真正布局以 CONFIG.uiNodes / shipping 为准；提前写回会污染存档。
   * 唯一合法的首写点是 hydrateFromConfig 末尾（此时 hydratedOnce 已 true）。
   */
  persist(): void {
    if (!this.hydratedOnce) {
      return;
    }
    const out: Record<string, UINodeSerialized> = { ...(CONFIG.uiNodes ?? {}) };
    for (const node of this.nodes.values()) {
      const parent = node.findUINodeParent();
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

  private uiSiblingIndex(node: UINode): number {
    const parent = node.parent;
    if (!parent) return 0;
    let i = 0;
    for (const child of parent.children) {
      if (!isUINode(child)) continue;
      if (child === node) return i;
      i += 1;
    }
    return i;
  }
}

export const uiHierarchy = new UIHierarchyImpl();
