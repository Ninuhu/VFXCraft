import { useEffect, useRef } from "react";
import { Quaternion, Vector3 } from "three";
import { MaterialPreview } from "../../rendering/MaterialPreview.ts";
import { attachCameraInput } from "../../rendering/cameraInput3D.ts";
import { drawHierarchyGrid } from "../../rendering/hierarchyGrid.ts";
import { hierarchyAt, IDENTITY_MATRIX, isLayerLocked } from "../../core/document/hierarchy.ts";
import { DEFAULT_BACKGROUND, resolveBackground } from "../../core/materials/materialEvaluation.ts";
import { validateBackground } from "../../core/document/validateDocument.ts";
import type { Project } from "../../core/document/model.ts";
import { displayedTransform, transformCommand } from "./transformEditing.ts";
import { useEditor } from "./EditorContext.tsx";

export type PreviewActions = { reset(): void; frame(): void };

////////////////////
// 描画ループはReactから独立し、同じ文書プレビューを読む。GPU・画像・入力はこの部品が解放する。
export function PreviewPanel({ actions }: { actions: { current: PreviewActions | null } }) {
    const editor = useEditor(), latest = useRef(editor); // フレームごとにReactを更新せず最新設定だけ読む
    latest.current = editor;
    const canvas = useRef<HTMLCanvasElement>(null), overlay = useRef<SVGSVGElement>(null), stats = useRef<HTMLOutputElement>(null); // 描画と補助表示
    const renderer = useRef<MaterialPreview | null>(null); // ギズモとカメラが共有する一台
    const points = useRef<{ origin: [number, number]; ends: [number, number][]; unit: number } | null>(null); // 現在の射影軸
    const drag = useRef<{ token: symbol; x: number; y: number; axis: number; values: ReturnType<typeof displayedTransform>;
        project: Project; length: number; dx: number; dy: number; time: number } | null>(null); // 一ドラッグの固定基準

    useEffect(() => {
        let active: MaterialPreview; // マウントごとに所有する資源
        try { active = new MaterialPreview(canvas.current!); } catch (error) { latest.current.report(error); return; }
        renderer.current = active;
        const detach = attachCameraInput(canvas.current!, active.view, (error) => latest.current.report(error)); // ハンドル上はイベントを停止する
        const images = new Map<string, ImageBitmap>(), blobs = new Map<string, Blob>(); // デコードは文書変更時だけ
        let disposed = false, frame = 0, previous: Project | undefined, lastReport = 0, lastDrawProject: Project | undefined, lastDrawKey = "", imageRevision = 0; // 解除と統計更新の管理
        let fpsStart = performance.now(), drawnFrames = 0, measuredFps: number | null = null; // 実際に描画指示した頻度。制作FPSと区別する
        actions.current = { reset: () => active.view.reset(), frame: () => active.frame() };
        ////////////////////
        // カメラの射影で編集軸を同じCanvas座標へ配置する。
        function render(now: number) {
            const current = latest.current, project = current.flow.history.preview, time = current.time.current; // 一文書を読む
            if (now - fpsStart >= 1000) {
                measuredFps = Math.round(drawnFrames * 1000 / (now - fpsStart)); drawnFrames = 0; fpsStart = now;
                if (stats.current) { stats.current.dataset.fps = String(measuredFps); stats.current.textContent = (stats.current.textContent ?? "").split("／更新")[0] + "／更新 " + measuredFps + " FPS"; }
            }
            try {
                if (previous !== project) {
                    const ids = new Set(project.assets.map((item) => item.id.toLowerCase())); // 削除画像をGPUからも解放
                    for (const [id] of blobs) if (!ids.has(id)) { images.get(id)?.close(); images.delete(id); blobs.delete(id); }
                    for (const id of ids) {
                        const blob = current.flow.getImage(id); // 保存フローの所有するBlob
                        if (!blob || blobs.get(id) === blob) continue;
                        blobs.set(id, blob);
                        void createImageBitmap(blob, { premultiplyAlpha: "none" }).then((image) => {
                            if (disposed || blobs.get(id) !== blob) image.close(); else { images.get(id)?.close(); images.set(id, image); imageRevision++; }
                        }).catch((error: unknown) => { if (!disposed) current.report(error); });
                    }
                    previous = project;
                }
                let common = DEFAULT_BACKGROUND; // 設定欠損時も描画を続行
                try { common = resolveBackground(DEFAULT_BACKGROUND, validateBackground(JSON.parse(localStorage.getItem("vfxcraft.preview.background") ?? "{}"))); } catch { /* 既定値へ復旧 */ }
                const drawKey = JSON.stringify([time, current.light, current.selection.active, current.space, current.interval, common, imageRevision,
                    current.tool, active.view.camera.position.toArray(), active.view.camera.quaternion.toArray()]); // 静止時にGPUへ同じデータを再転送しない
                if (lastDrawProject === project && lastDrawKey === drawKey) { frame = requestAnimationFrame(render); return; }
                const result = active.draw(project, time, { light: current.light, images, background: common, hideBackgroundGrid: true }); // T09の編集グリッドだけを重ねる
                drawnFrames++;
                lastDrawProject = project; lastDrawKey = drawKey;
                if (stats.current) {
                    stats.current.dataset.cpuMs = String(result.simulationMs + result.sortMs + result.prepareMs + result.bodyMs + result.bloomMs);
                    stats.current.dataset.particles = String(result.count);
                }
                const background = resolveBackground(common, project.preview?.background ?? {}); // 補助グリッドと同じ表示規則
                if (background.grid) drawHierarchyGrid(canvas.current!, project, time, current.selection.active ?? undefined, current.space, current.interval, active.view, background.gridOpacity);
                const layer = project.layers.find((item) => item.id === current.selection.active); // 選択対象のワールド位置
                const width = canvas.current!.width, height = canvas.current!.height; // 内部描画解像度
                overlay.current!.setAttribute("viewBox", `0 0 ${width} ${height}`);
                const group = overlay.current!.querySelector<SVGGElement>("g")!; // 編集ハンドル全体
                group.style.display = layer && current.tool !== "select" && !isLayerLocked(project, layer.id) ? "" : "none";
                if (layer) {
                    const matrix = hierarchyAt(project, layer.id, time).matrix; // アニメーション評価を含む
                    const origin = [matrix[3]!, matrix[7]!, matrix[11]!] as const; // 行列の平行移動
                    const parent = current.space === "parent" && layer.parentId ? hierarchyAt(project, layer.parentId, time).matrix : IDENTITY_MATRIX;
                    const unit = project.mode === "2d" ? 70 : Math.max(0.05, active.view.camera.position.distanceTo(new Vector3(...origin)) * 0.12); // 操作しやすい画面長
                    const projectPoint = (point: readonly number[]): [number, number] => { // 射影は描画器と同じカメラ
                        if (project.mode === "2d") return [point[0]!, point[1]!];
                        const ndc = new Vector3(point[0], point[1], point[2]).project(active.view.camera);
                        return [(ndc.x + 1) * width / 2, (1 - ndc.y) * height / 2];
                    };
                    const start = projectPoint(origin), ends = [0, 1, 2].map((axis) => {
                        const direction = new Vector3(parent[axis], parent[axis + 4], parent[axis + 8]).normalize().multiplyScalar(unit); // 親軸の尺度は操作量へ混ぜない
                        return projectPoint([origin[0] + direction.x, origin[1] + direction.y, origin[2] + direction.z]);
                    });
                    points.current = { origin: start, ends, unit };
                    group.querySelectorAll<SVGGElement>("g").forEach((handle, axis) => {
                        const end = ends[axis]!, line = handle.querySelector("line")!, circle = handle.querySelector("circle")!; // 軸ごとの表示
                        handle.style.display = project.mode === "2d" && axis === 2 && current.tool !== "rotate" ? "none" : "";
                        const finish = project.mode === "2d" && current.tool === "rotate" ? [start[0] + 55, start[1] - 55] : end;
                        line.setAttribute("x1", String(start[0])); line.setAttribute("y1", String(start[1]));
                        line.setAttribute("x2", String(finish[0])); line.setAttribute("y2", String(finish[1]));
                        circle.setAttribute("cx", String(finish[0])); circle.setAttribute("cy", String(finish[1]));
                    });
                }
                if (stats.current && now - lastReport > 250) {
                    stats.current.textContent = `${project.mode.toUpperCase()}／粒子 ${result.count}／CPU ${(result.simulationMs + result.sortMs + result.prepareMs + result.bodyMs + result.bloomMs).toFixed(2)} ms／${current.light ? "軽量" : "正確"}／GL ${active.glError}／更新 ${measuredFps === null ? "計測中" : measuredFps + " FPS"}`;
                    lastReport = now;
                }
            } catch (error) { latest.current.report(error); }
            frame = requestAnimationFrame(render);
        }
        frame = requestAnimationFrame(render);
        return () => {
            disposed = true; cancelAnimationFrame(frame); detach(); actions.current = null; renderer.current = null;
            if (drag.current) { latest.current.flow.history.cancelContinuousEdit(drag.current.token); drag.current = null; }
            active.dispose(); for (const image of images.values()) image.close();
        };
    }, [editor.flow, actions]);

    ////////////////////
    // ギズモは開始時の値から絶対差分を計算し、取消時に全体を戻す。
    function finish(cancel: boolean) {
        if (!drag.current) return;
        const token = drag.current.token; // 現在のギズモ操作
        if (cancel) editor.flow.history.cancelContinuousEdit(token);
        else if (!editor.flow.history.commitContinuousEdit(token)) {
            try { editor.flow.history.cancelContinuousEdit(token); } catch { /* 無変更時は既に確定済み */ }
        }
        drag.current = null; editor.refresh();
    }
    return <><div className="preview-surface">
        <canvas ref={canvas} aria-label="エフェクトプレビュー" />
        <svg ref={overlay} className="gizmo-overlay" aria-label="Transformギズモ"><g>
            {["X", "Y", "Z"].map((name, axis) => <g key={name} role="button" aria-label={"ギズモ " + name} tabIndex={0}
                stroke={["#ff747e", "#74ef9e", "#82aaff"][axis]} fill={["#ff747e", "#74ef9e", "#82aaff"][axis]}
                onPointerDown={(event) => {
                    event.preventDefault(); event.stopPropagation();
                    event.currentTarget.focus(); // Escapeをドラッグ中のハンドルへ届ける
                    const layer = editor.flow.history.preview.layers.find((item) => item.id === editor.selection.active), p = points.current; // ドラッグ基準
                    if (!layer || !p) return;
                    try {
                        const rect = overlay.current!.getBoundingClientRect(), end = p.ends[axis]!; // CSS表示倍率も考慮
                        const scale = Math.min(rect.width / canvas.current!.width, rect.height / canvas.current!.height); // meet射影の余白で操作量が変化しない
                        const dx = (end[0] - p.origin[0]) * scale, dy = (end[1] - p.origin[1]) * scale;
                        drag.current = { token: editor.flow.history.beginContinuousEdit(), x: event.clientX, y: event.clientY, axis,
                            values: displayedTransform(editor.flow.history.preview, layer, editor.time.current, editor.space),
                            project: editor.flow.history.preview, length: p.unit, dx, dy, time: editor.time.current };
                        event.currentTarget.setPointerCapture(event.pointerId);
                    } catch (error) { editor.report(error); }
                }} onPointerMove={(event) => {
                    const active = drag.current; // 基準文書は更新のたびに変えない
                    if (!active) return;
                    const layer = active.project.layers.find((item) => item.id === editor.selection.active)!;
                    const delta = ((event.clientX - active.x) * active.dx + (event.clientY - active.y) * active.dy) / Math.max(1, active.dx ** 2 + active.dy ** 2); // 軸への射影
                    const property = editor.tool === "rotate" ? "rotation" : editor.tool === "scale" ? "size" : "position";
                    let value = active.values[property]; // 選択ツールごとの候補
                    if (property === "rotation") {
                        const angle = (event.clientX - active.x - event.clientY + active.y) * Math.PI / 180; // 画面1pxを1度として連続入力
                        value = typeof active.values.rotation === "number" ? active.values.rotation + angle * 180 / Math.PI
                            : new Quaternion().setFromAxisAngle(new Vector3(...([0, 1, 2].map((index) => index === axis ? 1 : 0) as [number, number, number])), angle)
                                .multiply(new Quaternion(...active.values.rotation)).normalize().toArray();
                    } else {
                        const original = active.values[property]; // 2Dと3Dの型を保つ
                        value = original.map((part, index) => index === axis ? property === "position" ? part + delta * active.length : part * Math.max(0.001, 1 + delta) : part) as never;
                    }
                    try { editor.flow.history.updateContinuousEdit(active.token, transformCommand(active.project, layer, active.time, editor.space, property, value, editor.autoKey,
                        editor.snap ? editor.interval : undefined)); editor.refresh(); } catch (error) { editor.report(error); }
                }} onPointerUp={() => finish(false)} onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)} onKeyDown={(event) => { if (event.key === "Escape") finish(true); }}>
                <line strokeWidth={3} /><circle r={9} strokeWidth={4} />
            </g>)}
        </g></svg>
    </div><output ref={stats} aria-label="描画状態" /><p className="hint">視点：左ドラッグでOrbit、右ドラッグでPan、ホイールでZoom。色付きハンドルをドラッグして編集。</p></>;
}
