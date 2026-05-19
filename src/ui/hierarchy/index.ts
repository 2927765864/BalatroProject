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

export { UINode } from "./UINode";
export { uiHierarchy } from "./UIHierarchy";
export {
  UIComponent,
  componentRegistry,
  type SerializedComponent,
} from "./UIComponent";
export { TransformComponent } from "./components/TransformComponent";
export { TweenComponent } from "./components/TweenComponent";
export { TextStyleComponent } from "./components/TextStyleComponent";

// 组件类型注册：
//   - transform / textStyle 是默认组件，不出现在"添加组件"下拉里。
//   - tween 是 demo 用的可加组件。
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
