/**
 * 弹性绳调试绘制：共线弹性段 + 刚性延伸段 + 锚点。
 * 仅沙盒使用；坐标为父容器（与 CardView.x/y 同一空间）。
 */

import { Container, Graphics, Text } from "pixi.js";
import type { ElasticRopeDebugSnapshot } from "./ElasticRopeTypes";

export class ElasticRopeDebugDraw {
  readonly root = new Container();
  private readonly rope = new Graphics();
  private readonly anchor = new Graphics();
  private readonly hud: Text;

  constructor() {
    this.root.label = "ElasticRopeDebug";
    this.root.addChild(this.rope);
    this.root.addChild(this.anchor);
    this.hud = new Text({
      text: "",
      style: {
        fontFamily: "monospace",
        fontSize: 12,
        fill: 0xcbe88b,
      },
    });
    this.hud.position.set(12, 12);
    this.root.addChild(this.hud);
  }

  update(
    snap: ElasticRopeDebugSnapshot,
    opts: {
      drawRope: boolean;
      drawAnchor: boolean;
      showHud: boolean;
      elasticColor: number;
      rigidColor: number;
    },
  ): void {
    this.rope.clear();
    this.anchor.clear();

    if (opts.drawRope && snap.D > 0.5) {
      // 弹性段 C → elasticEnd
      this.rope.moveTo(snap.C.x, snap.C.y);
      this.rope.lineTo(snap.elasticEnd.x, snap.elasticEnd.y);
      this.rope.stroke({ width: 2, color: opts.elasticColor, alpha: 0.9 });

      // 刚性段 elasticEnd → T
      if (snap.Lr > 0.5) {
        this.rope.moveTo(snap.elasticEnd.x, snap.elasticEnd.y);
        this.rope.lineTo(snap.T.x, snap.T.y);
        this.rope.stroke({ width: 2, color: opts.rigidColor, alpha: 0.85 });
      }

      // 目标点
      this.rope.circle(snap.T.x, snap.T.y, 4);
      this.rope.fill({ color: opts.rigidColor, alpha: 0.8 });
    }

    if (opts.drawAnchor) {
      const a = snap.anchorWorld;
      const s = 6;
      this.anchor.moveTo(a.x - s, a.y);
      this.anchor.lineTo(a.x + s, a.y);
      this.anchor.moveTo(a.x, a.y - s);
      this.anchor.lineTo(a.x, a.y + s);
      this.anchor.stroke({ width: 2, color: 0xff4466, alpha: 1 });
    }

    this.hud.visible = opts.showHud;
    if (opts.showHud) {
      this.hud.text = [
        `D=${snap.D.toFixed(1)} Le=${snap.Le.toFixed(1)} Lr=${snap.Lr.toFixed(1)}`,
        `|v|=${snap.speed.toFixed(1)} Vterm≈${snap.terminalSpeedApprox.toFixed(0)}`,
        `|Fs|=${snap.FsMag.toFixed(1)}`,
      ].join("\n");
    }
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
