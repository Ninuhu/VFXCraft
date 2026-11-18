import { Vector3 } from "three";
import type { Project } from "../core/document/model.ts";
import { hierarchyAt, IDENTITY_MATRIX, transformPosition } from "../core/document/hierarchy.ts";
import type { Camera3D } from "./Camera3D.ts";

////////////////////
// スナップと同じ原点・間隔を持つプレビューグリッドを描く。線数を制限して極小間隔でも停止する
export function drawHierarchyGrid(canvas: HTMLCanvasElement, project: Project, timeUs: number, selected: string | undefined,
    space: "world" | "parent", interval: number, view: Camera3D, opacity: number): void {
    if (!Number.isFinite(interval) || interval < 1e-6 || interval > 1e9 || opacity === 0) return;
    const layer = project.layers.find((item) => item.id === selected); // 選択中の親基底
    const matrix = space === "parent" && layer?.parentId ? hierarchyAt(project, layer.parentId, timeUs).matrix : IDENTITY_MATRIX;
    const ctx = canvas.getContext("2d")!; // 粒子とBloomの後の編集補助
    const count = 40; // 各方向の最大線数
    const center = layer ? hierarchyAt(project, layer.id, timeUs).matrix : IDENTITY_MATRIX;
    // Worldは選択位置の近傍、親ローカルは親原点を基準とする。間隔の整数倍だけへ線を置く。
    const cx = space === "world" ? Math.round(center[3]! / interval) * interval : 0;
    const cy = space === "world" ? Math.round(center[project.mode === "2d" ? 7 : 11]! / interval) * interval : 0;
    const extent = count * interval / 2; // 表示範囲だけを制限しスナップ間隔は変えない
    const projectPoint = (x: number, y: number) => {
        const world = transformPosition(matrix, project.mode === "2d" ? [x, y, 0] : [x, 0, y]);
        if (project.mode === "2d") return [world[0], world[1]];
        const point = new Vector3(...world).project(view.camera);
        return point.z < -1 || point.z > 1 ? undefined : [(point.x + 1) * canvas.width / 2, (1 - point.y) * canvas.height / 2];
    };
    const line = (a: number[], b: number[]) => {
        const start = projectPoint(a[0]!, a[1]!), end = projectPoint(b[0]!, b[1]!);
        if (!start || !end || ![...start, ...end].every(Number.isFinite)) return;
        ctx.moveTo(start[0]!, start[1]!); ctx.lineTo(end[0]!, end[1]!);
    };
    ctx.save(); ctx.strokeStyle = "rgba(166,145,207," + opacity + ")"; ctx.lineWidth = 1; ctx.beginPath();
    for (let index = -count / 2; index <= count / 2; index++) {
        line([cx + index * interval, cy - extent], [cx + index * interval, cy + extent]);
        line([cx - extent, cy + index * interval], [cx + extent, cy + index * interval]);
    }
    ctx.stroke(); ctx.restore();
}
