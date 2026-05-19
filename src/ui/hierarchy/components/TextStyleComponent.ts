/**
 * TextStyleComponent
 * ---------------------------------------------------------------
 * 挂在 UIText 上的默认（不可删）组件。
 * 第一版只暴露 "text"——后续按需扩展 fontSize / fill / fontWeight 等。
 *
 * 注意 host 的 setText / 组件内部 apply 之间的双向同步：
 *   - 业务代码改文字 → UIText.setText(...) → 同步调 component.syncFromHost(text)
 *     这一路径**不会**再触发 apply()，避免无限递归。
 *   - inspector 改字段 → component.data.text 变化 → apply() → host.setText(text)
 *     这一路径写回 host；UIText.setText 内部会判等避免再次发起同步。
 */
import { UIComponent, type SerializedComponent } from "../UIComponent";
import { uiHierarchy } from "../UIHierarchy";
import type { UIText } from "@ui/components/UIText";

interface TextStyleData {
  text: string;
}

export class TextStyleComponent extends UIComponent {
  readonly type = "textStyle";
  readonly displayName = "Text";
  override readonly removable = false;

  private data: TextStyleData;

  constructor(initialText = "") {
    super();
    this.data = { text: initialText };
  }

  protected override onAttach(): void {
    // 宿主必须是 UIText（运行时再核一遍，避免被误挂到其他 UINode 上）。
    if (typeof (this.host as unknown as { setText?: unknown }).setText !== "function") {
      console.warn(
        `[TextStyleComponent] 必须挂在 UIText 上：${this.host.nodeId}`,
      );
    }
  }

  apply(): void {
    const host = this.host as unknown as UIText;
    if (typeof host.setText === "function" && host.getText() !== this.data.text) {
      host.setText(this.data.text);
    }
  }

  /**
   * 由 UIText.setText 反向调用：业务代码改了文字后，把组件字段同步过来，
   * 这样 inspector 打开时显示的也是最新值。不会再次触发 apply。
   */
  syncFromHost(text: string): void {
    this.data.text = text;
    // 这里**不**调 notifyComponentsChanged：业务每帧都可能改文字（比如得分滚动），
    // 频繁 persist 会带来不必要的开销。等用户在 inspector 主动改了才落盘。
  }

  serialize(): SerializedComponent {
    return { type: this.type, data: { ...this.data } };
  }

  deserialize(d: Record<string, unknown>): void {
    if (typeof d["text"] === "string") this.data.text = d["text"];
  }

  buildInspector(): HTMLElement {
    const root = document.createElement("div");
    root.className = "ui-comp-body";

    const row = document.createElement("div");
    row.className = "ui-comp-row";

    const lab = document.createElement("span");
    lab.className = "ui-comp-row-label";
    lab.textContent = "Text";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "panel-text";
    input.value = this.data.text;
    input.addEventListener("input", () => {
      this.data.text = input.value;
      this.apply();
      uiHierarchy.notifyComponentsChanged(this.host);
    });

    row.appendChild(lab);
    row.appendChild(input);
    root.appendChild(row);

    return root;
  }
}
