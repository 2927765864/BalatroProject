/**
 * TweenComponent
 * ---------------------------------------------------------------
 * 占位组件。先把"如何把第三方组件接入 hierarchy + inspector"的形态走通，
 * 真正驱动 tween 的逻辑等真正需要时再补。
 *
 * 当前仅暴露三个字段：duration / easing / autoPlay，inspector 渲染对应控件。
 * apply() 暂时是 no-op：未来想让它真正控制宿主，就在这里订阅业务事件并把
 * 宿主 push 给 TweenManager。
 */
import { UIComponent, type SerializedComponent } from "../UIComponent";
import { uiHierarchy } from "../UIHierarchy";

const EASING_OPTIONS = [
  "linear",
  "easeIn",
  "easeOut",
  "easeInOut",
] as const;

type Easing = (typeof EASING_OPTIONS)[number];

interface TweenData {
  duration: number; // 毫秒
  easing: Easing;
  autoPlay: boolean;
}

export class TweenComponent extends UIComponent {
  readonly type = "tween";
  readonly displayName = "Tween";

  private data: TweenData = {
    duration: 300,
    easing: "easeOut",
    autoPlay: false,
  };

  apply(): void {
    // 占位：未来真正接入动效系统时在这里把 this.host 注册到 TweenManager。
  }

  serialize(): SerializedComponent {
    return { type: this.type, data: { ...this.data } };
  }

  deserialize(d: Record<string, unknown>): void {
    if (typeof d["duration"] === "number") this.data.duration = d["duration"];
    if (typeof d["easing"] === "string" && (EASING_OPTIONS as readonly string[]).includes(d["easing"])) {
      this.data.easing = d["easing"] as Easing;
    }
    if (typeof d["autoPlay"] === "boolean") this.data.autoPlay = d["autoPlay"];
  }

  buildInspector(): HTMLElement {
    const root = document.createElement("div");
    root.className = "ui-comp-body";

    // duration
    {
      const row = document.createElement("div");
      row.className = "ui-comp-row";
      const lab = document.createElement("span");
      lab.className = "ui-comp-row-label";
      lab.textContent = "Duration (ms)";
      const input = document.createElement("input");
      input.type = "number";
      input.className = "panel-number";
      input.min = "0";
      input.step = "10";
      input.value = String(this.data.duration);
      input.addEventListener("input", () => {
        const v = Number(input.value);
        if (!Number.isFinite(v)) return;
        this.data.duration = Math.max(0, v);
        uiHierarchy.notifyComponentsChanged(this.host);
      });
      row.appendChild(lab);
      row.appendChild(input);
      root.appendChild(row);
    }

    // easing
    {
      const row = document.createElement("div");
      row.className = "ui-comp-row";
      const lab = document.createElement("span");
      lab.className = "ui-comp-row-label";
      lab.textContent = "Easing";
      const sel = document.createElement("select");
      sel.className = "panel-select";
      for (const e of EASING_OPTIONS) {
        const opt = document.createElement("option");
        opt.value = e;
        opt.textContent = e;
        if (e === this.data.easing) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener("change", () => {
        this.data.easing = sel.value as Easing;
        uiHierarchy.notifyComponentsChanged(this.host);
      });
      row.appendChild(lab);
      row.appendChild(sel);
      root.appendChild(row);
    }

    // autoPlay
    {
      const row = document.createElement("div");
      row.className = "ui-comp-row";
      const lab = document.createElement("span");
      lab.className = "ui-comp-row-label";
      lab.textContent = "Auto Play";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = this.data.autoPlay;
      input.addEventListener("change", () => {
        this.data.autoPlay = input.checked;
        uiHierarchy.notifyComponentsChanged(this.host);
      });
      row.appendChild(lab);
      row.appendChild(input);
      root.appendChild(row);
    }

    return root;
  }
}
