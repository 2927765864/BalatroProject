/**
 * UIComponent
 * ---------------------------------------------------------------
 * 类比 Unity 的 MonoBehaviour：一个组件挂在 UINode 上，按"类型"分类，
 * 同一节点上同类型组件只允许存在一份。
 *
 * 三个核心职责：
 *   1. 持有自己的可序列化数据（component-specific state）。
 *   2. 把数据应用到宿主 UINode 上（onAttach / onChange）。
 *   3. 把自身渲染到调参面板的 inspector 中（buildInspector）。
 *
 * Transform 等默认组件 removable=false，其余可加可删。
 */
// 注意：本文件只用 UINode 作为类型，不引入运行时实例，避免循环引用。
import type { UINode } from "./UINode";

/** 组件序列化后的形态（写入 CONFIG.uiNodes[id].components）。 */
export interface SerializedComponent {
  type: string;
  data: Record<string, unknown>;
}

/**
 * 组件基类。子类只需关心：
 *   - 字段
 *   - serialize / applyData
 *   - buildInspector
 */
export abstract class UIComponent {
  /** 组件类型 id，全工程唯一，比如 "transform" / "tween"。 */
  abstract readonly type: string;
  /** 组件在 inspector 顶部显示的名字。 */
  abstract readonly displayName: string;
  /** 是否允许被"删除组件"按钮移除。Transform 这种默认组件应为 false。 */
  readonly removable: boolean = true;

  /** 宿主节点。由 UINode.addComponent 注入，构造时不要依赖。 */
  protected host!: UINode;

  /** 把组件挂上宿主时调用，可用于初始 apply。 */
  attach(host: UINode): void {
    this.host = host;
    this.onAttach();
  }

  /** 即将从宿主移除时调用。 */
  detach(): void {
    this.onDetach();
  }

  /** 子类可重写：组件被挂到节点上时的钩子。 */
  protected onAttach(): void {}

  /** 子类可重写：组件被移除时的钩子（清理 PIXI 资源 / 反注册等）。 */
  protected onDetach(): void {}

  /**
   * 数据 → 宿主。
   * 内部状态变化（inspector 改值 / 反序列化）后调用，把状态应用到宿主上。
   */
  abstract apply(): void;

  /** 序列化字段，落到 CONFIG.uiNodes[*].components 里。 */
  abstract serialize(): SerializedComponent;

  /** 反序列化：把外部数据写入组件字段。之后由 hierarchy 统一 apply()。 */
  abstract deserialize(data: Record<string, unknown>): void;

  /**
   * 渲染 inspector DOM。返回的 element 会被插入 component 折叠面板内。
   * 由 ControlPanel 在打开节点 inspector 时调用。
   */
  abstract buildInspector(): HTMLElement;
}

// ---- 组件类型注册表 -----------------------------------------------

export type UIComponentFactory = () => UIComponent;

export interface UIComponentTypeMeta {
  type: string;
  displayName: string;
  factory: UIComponentFactory;
  /** Transform 这种默认组件不允许从"添加组件"菜单里再加一遍。 */
  hiddenInAddMenu?: boolean;
  /**
   * 可选：限制本组件可被挂到哪些 UINode 上。
   * 例如 BreathingText 只能挂在 UIText（文字/数字）节点上，不能挂到 Panel。
   * 返回 false 时：
   *   - HierarchyView 的"添加组件"下拉里会过滤掉本组件；
   *   - 即使外部代码调 addComponent，也不会触发硬错，但渲染端组件可以选择 no-op。
   */
  canAttach?: (host: UINode) => boolean;
}

class ComponentRegistryImpl {
  private readonly map = new Map<string, UIComponentTypeMeta>();

  register(meta: UIComponentTypeMeta): void {
    if (this.map.has(meta.type)) {
      console.warn(`[UIComponent] 类型重复注册：${meta.type}`);
    }
    this.map.set(meta.type, meta);
  }

  get(type: string): UIComponentTypeMeta | undefined {
    return this.map.get(type);
  }

  /** 添加组件下拉菜单里要展示的项。 */
  listAddable(): UIComponentTypeMeta[] {
    return [...this.map.values()].filter((m) => !m.hiddenInAddMenu);
  }

  create(type: string): UIComponent | null {
    const meta = this.map.get(type);
    if (!meta) {
      console.warn(`[UIComponent] 未知组件类型：${type}`);
      return null;
    }
    return meta.factory();
  }
}

export const componentRegistry = new ComponentRegistryImpl();
