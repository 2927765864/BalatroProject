/**
 * UINode
 * ---------------------------------------------------------------
 * 所有"出现在 Hierarchy 里的 UI 元素"的统一基类。
 *
 * 把 PIXI.Container 包一层，做三件事：
 *   1. 构造时自动注册到全局 uiHierarchy（单例），并从 CONFIG.uiNodes 里加载持久化数据。
 *   2. 强制持有一个 TransformComponent（不可删），把 x/y/rotation/scale 暴露成"数据"。
 *   3. 提供 addComponent / removeComponent / getComponent，便于挂载更多可选组件。
 *
 * id 必须由调用方提供且全局唯一，且保持稳定（重启后能匹配到 CONFIG 中的存档）。
 * displayName 仅用于 hierarchy 树里显示，可以中文。
 */
import { Container } from "pixi.js";
import { uiHierarchy } from "./UIHierarchy";
import { TransformComponent } from "./components/TransformComponent";
import type { UIComponent } from "./UIComponent";

export interface UINodeOptions {
  /** 全局唯一 id，例如 "hud.scorePanel"。 */
  id: string;
  /** Hierarchy 里展示的名字，例如 "得分面板"。 */
  displayName: string;
}

export class UINode extends Container {
  readonly nodeId: string;
  readonly displayName: string;

  /** 默认 Transform 组件，所有 UINode 都有，不可删。 */
  readonly transform: TransformComponent;

  /** 当前节点上挂载的全部组件（含 transform）。 */
  private readonly components: UIComponent[] = [];

  constructor(opts: UINodeOptions) {
    super();
    this.nodeId = opts.id;
    this.displayName = opts.displayName;
    this.label = opts.id;
    // 不启用 sortableChildren：保持 PIXI 默认的"addChild 顺序 == 绘制顺序"
    // —— 先 addChild 的在下，后 addChild 的在上；父先画、子盖在父之上，
    // 这与 Unity 中"父在底层、子在顶层"的层级直觉一致。
    // 个别确实需要按 zIndex 排序的容器（如 worldRoot、cardLayer）自行打开即可。

    // 装入 Transform（不可删的默认组件）
    this.transform = new TransformComponent();
    this.attachComponentInternal(this.transform);

    // 注册延后到节点首次被挂到任意父上时：
    //   1) 调用方通常是 `new Node(); node.position.set(...); parent.addChild(node);`，
    //      register 太早会让 transform 默认值 = 0/0。
    //   2) 改在 "added" 触发点 register，可以先 capture 宿主当前位姿、再尝试反序列化存档。
    this.once("added", () => {
      this.transform.captureFromHost();
      uiHierarchy.register(this);
    });

    // UINode 作为父级时，Graphics/Text 等内部实现元素属于“父物体 UI”，
    // 用户在 Hierarchy 里拖进去的 UINode 子物体应始终画在这些父级元素之上。
    this.on("childAdded", (child) => {
      if (this.isUINodeChild(child)) this.keepChildOnTop(child);
    });
  }

  /** 确保刚挂进来的 UINode 子节点画在父节点当前内容之上。 */
  keepChildOnTop(child: UINode): void {
    if (child.parent !== this) return;
    if (this.children[this.children.length - 1] === child) return;
    this.setChildIndex(child, this.children.length - 1);
  }

  private isUINodeChild(child: unknown): child is UINode {
    return (
      child !== null &&
      typeof child === "object" &&
      typeof (child as { nodeId?: unknown }).nodeId === "string"
    );
  }

  // ---- 组件 ----------------------------------------------------

  /** 取指定类型的组件；不存在返回 undefined。 */
  getComponent<T extends UIComponent>(type: string): T | undefined {
    return this.components.find((c) => c.type === type) as T | undefined;
  }

  /** 获取节点上的全部组件（顺序：transform 在最前，之后按添加顺序）。 */
  listComponents(): readonly UIComponent[] {
    return this.components;
  }

  /**
   * 给节点添加一个组件。
   * 同 type 已存在时直接返回旧的，不再重复挂。
   */
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

  /**
   * 删除组件。Transform 这类 removable=false 的组件会被拒绝。
   * 返回是否真的删掉了。
   */
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

  /** 内部统一挂载入口（构造时初始化 transform 也走这条路径）。 */
  private attachComponentInternal(c: UIComponent): void {
    this.components.push(c);
    c.attach(this);
    c.apply();
  }

  // ---- PIXI 销毁联动 ------------------------------------------

  override destroy(options?: Parameters<Container["destroy"]>[0]): void {
    for (const c of this.components) c.detach();
    this.components.length = 0;
    uiHierarchy.unregister(this);
    super.destroy(options);
  }
}
