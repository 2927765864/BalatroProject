/**
 * UIText
 * ---------------------------------------------------------------
 * Hierarchy 友好的文字节点：把 PIXI.Text 包成 UINode，便于在调参面板里
 * 单独看到、单独调位置、单独挂额外组件（如未来的 TextFxComponent）。
 *
 * 用法（与裸 PIXI.Text 的差别就是多了 id / displayName）：
 *
 *   const t = new UIText({
 *     id: "hud.scorePanel.handName",
 *     displayName: "牌型文字",
 *     text: "牌型: 无",
 *     style: { fontFamily, fontSize: 18, fill: 0xffffff, fontWeight: "bold" },
 *   });
 *   t.setAnchor(0.5, 0);
 *   t.position.set(120, 30);
 *   parent.addChild(t);
 *
 * 之后业务里通过 `t.setText("xxx")` 改文本；同样的内部入口也被
 * TextStyleComponent.apply() 复用（面板里改了 text 字段时）。
 *
 * 默认会自动挂上 TextStyleComponent（不可删的固定组件），用来在 inspector 里
 * 暴露 text 字段。
 */
import { Text, type TextStyleOptions } from "pixi.js";
import { UINode } from "@ui/hierarchy/UINode";
import { TextStyleComponent } from "@ui/hierarchy/components/TextStyleComponent";

export interface UITextOptions {
  /** Hierarchy 中的稳定 id，例如 "hud.scorePanel.handName"。 */
  id: string;
  /** Hierarchy 中显示的名字，例如 "牌型文字"。 */
  displayName: string;
  /** 初始文本。 */
  text: string;
  /** PIXI TextStyle 选项（与 new Text({ style }) 一致）。 */
  style?: TextStyleOptions;
}

export class UIText extends UINode {
  private readonly pixiText: Text;
  /** 由 UIText 自动挂载的"文字内容"组件（不可删）。 */
  readonly textStyle: TextStyleComponent;

  constructor(opts: UITextOptions) {
    super({ id: opts.id, displayName: opts.displayName });
    this.pixiText = new Text({ text: opts.text, style: opts.style });
    this.addChild(this.pixiText);

    // 给节点挂上 TextStyleComponent。captureFromHost 在添加后立刻执行一次，
    // 让组件字段的初始 text 与 PIXI.Text 自带的 text 对齐。
    this.textStyle = new TextStyleComponent(opts.text);
    this.addComponent(this.textStyle);
  }

  /**
   * 改文本。业务代码（GameController 等）每次更新动态值都走这里。
   * TextStyleComponent.apply() 也会调它，从而打通"面板改值 → 文字立即变"。
   */
  setText(value: string): void {
    if (this.pixiText.text === value) return;
    this.pixiText.text = value;
    // 保持组件字段同步（不能反过来再 apply，否则会无限循环；
    // TextStyleComponent 内部已经避免在 apply 中调 setText 触发反向写）。
    this.textStyle.syncFromHost(value);
    // 通知"宿主视觉内容已变化"。ShadowComponent 等做"宿主快照型"渲染的
    // 组件会监听这个事件并安排重烤。
    this.notifyVisualChanged();
  }

  /** 取当前 PIXI.Text 上的真实文本。 */
  getText(): string {
    return this.pixiText.text;
  }

  /** 透传 PIXI.Text.anchor：保持既有调用方式 `setAnchor(0.5, 0)`。 */
  setAnchor(x: number, y: number = x): this {
    this.pixiText.anchor.set(x, y);
    return this;
  }

  /**
   * 暴露内部 PIXI.Text 给"逐字效果"这类组件用。
   *
   * 设计取舍：BreathingTextComponent 需要：
   *   - 读 PIXI TextStyle / 当前 text / anchor / 是否可见 等做"逐字拆分"；
   *   - 临时把它隐藏起来、再渲染一组逐字小 Text。
   * 让组件直接 down-cast 节点的 children 并不安全（顺序可能被打乱）。
   * 走这个 getter，宿主显式说"我愿意把内部 Text 借给你看"。
   */
  getPixiText(): import("pixi.js").Text {
    return this.pixiText;
  }
}
