/**
 * UI Hierarchy 系统入口
 * ---------------------------------------------------------------
 * 这一处集中：
 *   - 重新导出常用 API（UINode / 组件类 / hierarchy 单例 / 注册表）。
 *   - 注册所有"可在添加组件菜单里被选择"的组件类型。
 *
 * 新加组件类型 = 写一个继承 UIComponent 的类 + 在这里 register 一行。
 */
import { componentRegistry } from "./UIComponent";
import { TransformComponent } from "./components/TransformComponent";
import { TweenComponent } from "./components/TweenComponent";
import { TextStyleComponent } from "./components/TextStyleComponent";
import { ShadowComponent } from "./components/ShadowComponent";
import { CharLayerComponent } from "./components/CharLayerComponent";
import {
  BreathingTextComponent,
  breathingTextCanAttach,
} from "./components/BreathingTextComponent";
import {
  BounceTextComponent,
  bounceTextCanAttach,
} from "./components/BounceTextComponent";
import { OpacityComponent } from "./components/OpacityComponent";

export { UINode, isUINode } from "./UINode";
export { uiHierarchy } from "./UIHierarchy";
export {
  UIComponent,
  componentRegistry,
  type SerializedComponent,
} from "./UIComponent";
export { TransformComponent } from "./components/TransformComponent";
export { TweenComponent } from "./components/TweenComponent";
export { TextStyleComponent } from "./components/TextStyleComponent";
export { ShadowComponent } from "./components/ShadowComponent";
export { CharLayerComponent } from "./components/CharLayerComponent";
export { BreathingTextComponent } from "./components/BreathingTextComponent";
export { BounceTextComponent } from "./components/BounceTextComponent";
export { OpacityComponent } from "./components/OpacityComponent";

// 组件类型注册：
//   - transform / textStyle 是默认组件，不出现在"添加组件"下拉里。
//   - tween 是 demo 用的可加组件。
//   - shadow 给宿主整体加 DropShadow，可挂任意 UINode。
componentRegistry.register({
  type: "transform",
  displayName: "Transform",
  factory: () => new TransformComponent(),
  hiddenInAddMenu: true,
});

componentRegistry.register({
  type: "textStyle",
  displayName: "Text",
  factory: () => new TextStyleComponent(),
  hiddenInAddMenu: true,
});

componentRegistry.register({
  type: "tween",
  displayName: "Tween",
  factory: () => new TweenComponent(),
});

componentRegistry.register({
  type: "shadow",
  displayName: "Shadow",
  factory: () => new ShadowComponent(),
});

componentRegistry.register({
  type: "opacity",
  displayName: "透明度",
  factory: () => new OpacityComponent(),
});

// 逐字层：拆字 + 接管渲染的底层管理器。由呼吸 / 弹弹惰性自动挂载，
// 不出现在"添加组件"下拉里，也不允许用户手动删（removable=false）。
componentRegistry.register({
  type: "charLayer",
  displayName: "逐字层",
  factory: () => new CharLayerComponent(),
  hiddenInAddMenu: true,
  canAttach: bounceTextCanAttach,
});

// 逐字呼吸效果：只对 UIText（文字 / 数字）有意义，
// 通过 canAttach 限制添加菜单 —— Panel / Button 容器等节点不会出现在它们的下拉里。
componentRegistry.register({
  type: "breathingText",
  displayName: "逐字呼吸",
  factory: () => new BreathingTextComponent(),
  canAttach: breathingTextCanAttach,
});

componentRegistry.register({
  type: "bounceText",
  displayName: "弹弹动画",
  factory: () => new BounceTextComponent(),
  canAttach: bounceTextCanAttach,
});
