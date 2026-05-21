/**
 * UINode（重做版）
 * ---------------------------------------------------------------
 * 设计规则（务必满足）：
 *   1. Hierarchy 同层从上到下 = 渲染从先到后（越上越底层）。
 *   2. 父先渲染，子后渲染。子永远盖在父之上。
 *
 * 实现策略：
 *   - 继续利用 PIXI 的父子树承担坐标变换。
 *   - 不依赖 zIndex / sortableChildren 决定渲染顺序。
 *   - 每次 PIXI children 发生变化，UINode 都会把"自己挂着的所有 UINode 子"
 *     一律移动到 children 数组末尾，从而保证：
 *       - 父节点自己的内部显示对象（Graphics / Sprite / Text 等非 UINode）排在前面，
 *         先渲染；
 *       - 所有 UINode 子节点排在后面，按它们之间相对顺序后渲染；
 *       - UINode 子节点之间的顺序 = 注册到该父下的顺序（reparent / reorder
 *         也会落到这个顺序里）。
 *   - 用一个统一的 "UINODE_BRAND" 符号识别 UINode，避免循环依赖 + 跨实例不一致。
 */
import { Container, type ContainerChild } from "pixi.js";
import { uiHierarchy } from "./UIHierarchy";
import { TransformComponent } from "./components/TransformComponent";
import type { UIComponent } from "./UIComponent";

export interface UINodeOptions {
  id: string;
  displayName: string;
}

/** 用 Symbol 在 PIXI 子节点里识别 UINode，比 instanceof 更稳（避免循环依赖）。 */
export const UI_NODE_BRAND: unique symbol = Symbol.for("ui-node-brand");

export function isUINode(obj: unknown): obj is UINode {
  return (
    obj !== null &&
    typeof obj === "object" &&
    (obj as { [UI_NODE_BRAND]?: boolean })[UI_NODE_BRAND] === true
  );
}

export class UINode extends Container {
  readonly [UI_NODE_BRAND] = true;

  readonly nodeId: string;
  readonly displayName: string;
  readonly transform: TransformComponent;

  private readonly components: UIComponent[] = [];
  private registered = false;
  /** 处于 resort 过程中：避免 setChildIndex 触发的 childAdded/Removed 递归。 */
  private resorting = false;

  constructor(opts: UINodeOptions) {
    super();
    this.nodeId = opts.id;
    this.displayName = opts.displayName;
    this.label = opts.id;
    // 关闭 PIXI 自带的 zIndex 排序，自己管 children 顺序。
    this.sortableChildren = false;

    this.transform = new TransformComponent();
    this.attachComponentInternal(this.transform);

    // 第一次被挂到任意父之后，捕获初始 local 位姿，并注册到 hierarchy。
    this.once("added", () => {
      this.transform.captureFromHost();
      if (!this.registered) {
        this.registered = true;
        uiHierarchy.register(this);
      }
    });

    // 每次有任何子节点进来（不论 UINode 还是普通 Graphics），都重排一次，
    // 保证 UINode 子节点最终都位于 children 数组末尾，从而后渲染。
    // 立即同步执行：避免 persist 时拿到尚未规范化的 siblingIndex。
    this.on("childAdded", () => this.resortChildren());
    this.on("childRemoved", () => this.resortChildren());
  }

  // ---- 顺序保证 ------------------------------------------------

  /**
   * 把当前节点 PIXI children 中的所有 UINode 子，按它们当前的相对顺序，
   * 一律放到 children 数组末尾。
   *
   * 这是本模块唯一一处决定"父子渲染顺序"的地方。
   */
  resortChildren(): void {
    if (this.destroyed) return;
    if (this.resorting) return;
    if (this.children.length <= 1) return;

    this.resorting = true;
    try {
      // 把所有 UINode 子按当前出现顺序一律压到 children 末尾。
      // PIXI 的 setChildIndex 会把节点搬到指定下标；按出现顺序逐个搬到末尾，
      // 既能让所有 UINode 都排在非 UINode 之后，又能保留它们之间的相对顺序。
      const uiChildren: UINode[] = [];
      for (const child of this.children) {
        if (isUINode(child)) uiChildren.push(child);
      }
      for (const child of uiChildren) {
        this.setChildIndex(child, this.children.length - 1);
      }
    } finally {
      this.resorting = false;
    }
  }

  // ---- 父子（逻辑）------------------------------------------------

  /** 当前直接挂在自己 PIXI children 上的 UINode 子节点，按 hierarchy 视觉顺序返回。 */
  listUIChildren(): UINode[] {
    const out: UINode[] = [];
    for (const child of this.children) {
      if (isUINode(child)) out.push(child);
    }
    return out;
  }

  /** 当前节点最近的 UINode 祖先。沿 PIXI parent 链向上找。 */
  findUINodeParent(): UINode | null {
    let p: ContainerChild | Container | null = this.parent;
    while (p) {
      if (isUINode(p)) return p;
      p = (p as Container).parent ?? null;
    }
    return null;
  }

  // ---- 组件 ----------------------------------------------------

  getComponent<T extends UIComponent>(type: string): T | undefined {
    return this.components.find((c) => c.type === type) as T | undefined;
  }

  listComponents(): readonly UIComponent[] {
    return this.components;
  }

  addComponent<T extends UIComponent>(component: T): T {
    const existing = this.getComponent<T>(component.type);
    if (existing) {
      console.warn(
        `[UINode:${this.nodeId}] 组件类型已存在，忽略：${component.type}`,
      );
      return existing;
    }
    this.attachComponentInternal(component);
    uiHierarchy.notifyComponentsChanged(this);
    return component;
  }

  removeComponent(type: string): boolean {
    const idx = this.components.findIndex((c) => c.type === type);
    if (idx < 0) return false;
    const c = this.components[idx]!;
    if (!c.removable) return false;
    c.detach();
    this.components.splice(idx, 1);
    uiHierarchy.notifyComponentsChanged(this);
    return true;
  }

  private attachComponentInternal(c: UIComponent): void {
    this.components.push(c);
    c.attach(this);
    c.apply();
  }

  // ---- 视觉脏标记 -------------------------------------------------

  /**
   * 通知"宿主自身的视觉内容发生了变化"——典型场景：
   *   - UIText.setText() 改了文字；
   *   - 业务直接动了内部 PIXI 显示对象的样式 / 颜色 / 几何形状。
   *
   * 任何依赖宿主当前外观做"快照型"渲染的组件（如 ShadowComponent 烤纹理），
   * 都应该监听这个事件并在收到时安排一次重建。
   *
   * 不在以下场景里 emit：
   *   - 仅仅是 transform 变化（位置、缩放、旋转）——sprite 是 child 自动跟随，
   *     不需要重烤。
   *   - 加 / 删 child——已经有 `childAdded` / `childRemoved` 覆盖。
   */
  notifyVisualChanged(): void {
    if (this.destroyed) return;
    // 用 PIXI Container 的 EventEmitter 直接发自定义事件。
    // 类型上 ContainerEvents 没列出自定义名，cast 一下规避。
    (this as unknown as { emit: (name: string) => boolean }).emit(
      "hostVisualChanged",
    );
  }

  // ---- PIXI 销毁联动 ------------------------------------------

  override destroy(options?: Parameters<Container["destroy"]>[0]): void {
    for (const c of this.components) c.detach();
    this.components.length = 0;
    if (this.registered) {
      uiHierarchy.unregister(this);
      this.registered = false;
    }
    super.destroy(options);
  }
}
