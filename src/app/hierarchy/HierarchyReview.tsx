import { useEffect, useRef, useState } from "react";
import type { LayerValues, Mode, Project, TrackValue } from "../../core/document/model.ts";
import { layerValuesAt } from "../../core/document/animation.ts";
import { decomposeTransform, hierarchyAt, hierarchyIndex, hierarchyRows, isLayerLocked, snapPosition } from "../../core/document/hierarchy.ts";
import { eulerXyzDegreesFromQuaternion, quaternionFromEulerXyzDegrees } from "../../core/document/rotation.ts";
import type { EditCommand } from "../../core/editing/command.ts";
import { DEFAULT_BACKGROUND, DEFAULT_PREVIEW, resolveBackground } from "../../core/materials/materialEvaluation.ts";
import { REVIEW_VCR_LIMITS } from "../../core/persistence/vcrArchive.ts";
import { MaterialPreview } from "../../rendering/MaterialPreview.ts";
import { attachCameraInput } from "../../rendering/cameraInput3D.ts";
import { drawHierarchyGrid } from "../../rendering/hierarchyGrid.ts";
import { ProjectFileFlow } from "../projectFiles/projectFileFlow.ts";
import { verifyBrowserImage } from "../projectFiles/browserProjectFiles.ts";
import { VcrReview } from "../projectFiles/VcrReview.tsx";
import { TimelineReview } from "../timeline/TimelineReview.tsx";
import { TimelineDialog, TimelineNumber } from "../timeline/timelineControls.tsx";
import { colorHex, fromHex } from "../materials/GradientControls.tsx";
import { createHierarchyExample } from "./hierarchyExample.ts";
import "./hierarchy.css";

const SNAP_STORAGE = "vfxcraft.editor.positionSnap"; // 利用者共通の2D・3D設定

////////////////////
// 保存した間隔を検証し、壊れた環境設定では既定値に戻る
function readIntervals(): Record<Mode, number> {
    try {
        const value: unknown = JSON.parse(localStorage.getItem(SNAP_STORAGE) ?? "null");
        if (value && typeof value === "object" && "2d" in value && "3d" in value
            && typeof value["2d"] === "number" && typeof value["3d"] === "number") {
            snapPosition([0], value["2d"]); snapPosition([0], value["3d"]);
            return { "2d": value["2d"], "3d": value["3d"] };
        }
    } catch { /* 環境設定の不正値は文書に混入させない */ }
    return { "2d": 16, "3d": 0.5 };
}

////////////////////
// 階層操作とT08のタイムラインを同じセッションで確認する開発用画面
export function HierarchyReview() {
    const [sessions] = useState(() => ({
        "2d": new ProjectFileFlow(createHierarchyExample("2d"), REVIEW_VCR_LIMITS, verifyBrowserImage, "0.0.0"),
        "3d": new ProjectFileFlow(createHierarchyExample("3d"), REVIEW_VCR_LIMITS, verifyBrowserImage, "0.0.0"),
    }));
    const [mode, setMode] = useState<Mode>("2d"), [selected, select] = useState("");
    const [folded, setFolded] = useState<ReadonlySet<string>>(new Set()); // 表示だけの展開状態
    const [space, setSpace] = useState<"world" | "parent">("parent");
    const [intervals, setIntervals] = useState(readIntervals);
    const [snap, setSnap] = useState(false);
    const [drop, setDrop] = useState<{ id: string; valid: boolean }>();
    const [dragged, setDragged] = useState<string>();
    const [message, setMessage] = useState("");
    const [deleting, setDeleting] = useState<{ id: string; project: Project }>();
    const [, render] = useState(0);
    const time = useRef(0); // T08と共有するプロジェクト時刻
    const canvas = useRef<HTMLCanvasElement>(null), stats = useRef<HTMLParagraphElement>(null);
    const transformDrag = useRef<{ token: symbol; x: number; timeUs: number; initial: readonly number[] } | undefined>(undefined); // 位置ドラッグ全体を一履歴にする
    const flow = sessions[mode], project = flow.history.preview;
    const layer = project.layers.find((item) => item.id === selected) ?? project.layers[0];
    const options = useRef({ space, intervals, snap, selected: layer?.id });
    options.current = { space, intervals, snap, selected: layer?.id };
    const rows = hierarchyRows(project);
    const hidden = new Set<string>(); // 折りたたまれた祖先の下の行
    const locked = layer ? isLayerLocked(project, layer.id) : false;
    let transform: Pick<LayerValues<Mode>, "position" | "rotation" | "size"> | undefined;
    let transformError = ""; // WorldがShearを持つ場合の説明
    if (layer) {
        try {
            transform = space === "world" ? decomposeTransform(hierarchyAt(project, layer.id, time.current).matrix, project.mode)
                : layerValuesAt(project, layer, time.current);
        } catch (error) { transformError = String(error); }
    }

    ////////////////////
    // 編集直後とタイムラインの操作後に階層の表示を更新する
    function refresh() { render((value) => value + 1); }

    ////////////////////
    // 共通コマンドの検証に成功した編集だけ確定する
    function execute(command: EditCommand) {
        try { const changed = flow.history.execute(command); setMessage(""); refresh(); return changed; }
        catch (error) { setMessage(String(error)); return false; }
    }

    ////////////////////
    // モーダルや他の操作前にドラッグ候補を必ず取り消す
    function cancelDrag() {
        const active = transformDrag.current;
        if (active) {
            try { flow.history.cancelContinuousEdit(active.token); } catch { /* ファイル切替済みなら古い候補は既に無効 */ }
            transformDrag.current = undefined; refresh();
        }
    }

    ////////////////////
    // 現在の座標モードでTransformを一項目変更する
    function changeTransform(property: "position" | "rotation" | "size", value: TrackValue) {
        if (!layer) return;
        execute({ kind: "layer.transform", layerId: layer.id, timeUs: time.current, space,
            values: { [property]: value }, ...(property === "position" && snap ? { snapInterval: intervals[project.mode] } : {}) });
    }

    ////////////////////
    // 表示用の3D角度はADR-003と同じXYZ、保存はQuaternionへ戻す
    function transformInputs(property: "position" | "rotation" | "size", label: string) {
        if (!transform) return null;
        const value = property === "rotation" && typeof transform.rotation !== "number"
            ? eulerXyzDegreesFromQuaternion(transform.rotation) : transform[property];
        const components = typeof value === "number" ? [value] : value;
        return <fieldset disabled={locked}><legend>{label}</legend>{components.map((component, index) => <TimelineNumber
            key={index} label={label + " " + ["X", "Y", "Z"][index]} value={component} onCommit={(input) => {
                const next = components.map((entry, axis) => axis === index ? input.trim() ? Number(input) : NaN : entry);
                try {
                    const values = property === "rotation" ? project.mode === "2d" ? next[0]!
                        : quaternionFromEulerXyzDegrees([next[0]!, next[1]!, next[2]!]) : next;
                    changeTransform(property, values as TrackValue);
                } catch (error) { setMessage(String(error)); }
            }} />)}</fieldset>;
    }

    ////////////////////
    // ツリーのドロップ候補を数値や構造を変更せずに判定する
    function canDrop(id: string, parentId: string | null): boolean {
        if (isLayerLocked(project, id) || (parentId && isLayerLocked(project, parentId))) return false;
        const descendants = hierarchyRows(project, id); // 自分自身や子孫への循環を防ぐ
        return !parentId || !descendants.some((item) => item.layer.id === parentId);
    }

    ////////////////////
    // 保存とUndo/Redoで差し替わる文書を描き、GPUと画像の所有期間を揃える
    useEffect(() => {
        let view: MaterialPreview;
        try { view = new MaterialPreview(canvas.current!); }
        catch (error) { setMessage(String(error)); return; }
        const images = new Map<string, ImageBitmap>(), blobs = new Map<string, Blob>(); // デコード済み画像
        const detach = attachCameraInput(canvas.current!, view.view, (error) => setMessage(String(error)));
        let disposed = false, handle = 0, imageVersion = 0, oldVersion = -1, previous: Project | undefined, oldKey = "";
        ////////////////////
        // ドメインは再生経路に依存せず、画面は毎フレームReactを更新しない
        function draw() {
            const current = flow.history.preview; // 有効なドラッグ候補も描画
            if (previous !== current) {
                const ids = new Set(current.assets.map((asset) => asset.id.toLowerCase()));
                for (const [id] of blobs) if (!ids.has(id)) { blobs.delete(id); images.get(id)?.close(); images.delete(id); }
                for (const id of ids) {
                    const blob = flow.getImage(id);
                    if (!blob || blobs.get(id) === blob) continue;
                    blobs.set(id, blob); images.get(id)?.close(); images.delete(id);
                    void createImageBitmap(blob, { premultiplyAlpha: "none" }).then((image) => {
                        if (disposed || blobs.get(id) !== blob) image.close(); else { images.set(id, image); imageVersion++; }
                    }).catch((error: unknown) => { if (!disposed) setMessage(String(error)); });
                }
            }
            const settings = options.current; // 表示だけの座標と間隔
            const key = JSON.stringify([time.current, settings, current.mode === "3d" && view.view.basis()]);
            if (key !== oldKey || previous !== current || oldVersion !== imageVersion) {
                try {
                    const preview = current.preview ?? DEFAULT_PREVIEW; // T07の設定を利用する
                    const background = resolveBackground(DEFAULT_BACKGROUND, preview.background);
                    const withoutGrid = { ...current, preview: { ...preview, background: { ...preview.background, grid: false } } } as Project;
                    // グリッドは編集座標に合わせて最後に描き、発光対象から外す。
                    const count = view.draw(withoutGrid, time.current, { images, light: false, background: { ...background, grid: false } });
                    if (background.grid) drawHierarchyGrid(canvas.current!, current, time.current, settings.selected, settings.space,
                        settings.intervals[current.mode], view.view, background.gridOpacity);
                    if (stats.current) stats.current.textContent = "時刻 " + (time.current / 1e6).toFixed(3) + " 秒 / 粒子 " + count.count + " / GL " + view.glError;
                } catch (error) { setMessage(String(error)); }
                previous = current; oldKey = key; oldVersion = imageVersion;
            }
            handle = requestAnimationFrame(draw);
        }
        handle = requestAnimationFrame(draw);
        return () => {
            disposed = true; cancelAnimationFrame(handle); detach(); view.dispose();
            for (const image of images.values()) image.close();
        };
    }, [flow]);

    return <div className="hierarchy-review" onKeyDown={(event) => { if (event.key === "Escape") cancelDrag(); }}>
        <h1>T09 レイヤー階層・親子関係・編集制御</h1>
        <label>サンプル<select aria-label="階層サンプル" value={mode} onChange={(event) => {
            cancelDrag(); setMode(event.currentTarget.value as Mode); time.current = 0; select(""); setFolded(new Set());
        }}><option value="2d">2D</option><option value="3d">3D</option></select></label>
        <div className="hierarchy-layout">
            <section>
                <div className="hierarchy-toolbar">
                    <button onClick={() => execute({ kind: "hierarchy.add", parentId: null })}>ルート粒子を追加</button>
                    <button onClick={() => execute({ kind: "hierarchy.add", parentId: null, isGroup: true })}>グループを追加</button>
                </div>
                <ul className="hierarchy-tree" aria-label="レイヤー階層">
                    {rows.map(({ layer: item, depth }) => {
                        if (item.parentId && (hidden.has(item.parentId) || folded.has(item.parentId))) { hidden.add(item.id); return null; }
                        const inheritedLock = isLayerLocked(project, item.id); // 祖先と自身を別々に示す
                        const state = hierarchyAt(project, item.id, time.current);
                        const children = hierarchyIndex(project).children.has(item.id.toLowerCase());
                        return <li key={item.id} style={{ paddingLeft: Math.min(depth, 30) * 12 }}
                            data-selected={layer?.id === item.id} data-drop={drop?.id === item.id ? drop.valid ? "valid" : "invalid" : undefined}
                            draggable={!inheritedLock} onDragStart={(event) => {
                                event.dataTransfer.setData("application/x-vfxcraft-layer", item.id); setDragged(item.id);
                            }} onDragEnd={() => { setDragged(undefined); setDrop(undefined); }}
                            onDragOver={(event) => { event.preventDefault(); if (dragged) setDrop({ id: item.id, valid: canDrop(dragged, item.id) }); }}
                            onDrop={(event) => {
                                event.preventDefault(); setDrop(undefined);
                                const id = event.dataTransfer.getData("application/x-vfxcraft-layer");
                                if (id && hierarchyIndex(project).layers.has(id)) execute({ kind: "layer.reparent", layerId: id, parentId: item.id, timeUs: time.current });
                            }}>
                            <button disabled={!children} aria-label={item.name + " 展開切替"} onClick={() => setFolded((old) => {
                                const next = new Set(old); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next;
                            })}>{children ? folded.has(item.id) ? "▸" : "▾" : "·"}</button>
                            <button aria-label={item.name + "を選択"} onClick={() => { cancelDrag(); select(item.id); }}>{item.name}</button>
                            <span title={item.isLocked ? "自身のロック" : inheritedLock ? "祖先のロックを継承" : "編集可能"}>
                                {item.isLocked ? "🔒" : inheritedLock ? "親🔒" : ""}{state.visible ? "" : " 非表示"}</span>
                        </li>;
                    })}
                </ul>
            </section>
            <section>
                <canvas ref={canvas} aria-label="階層プレビュー" />
                <p ref={stats} aria-label="階層描画状態" />
                {layer && <output aria-label="ワールド位置">
                    {hierarchyAt(project, layer.id, time.current).matrix.filter((_, index) => [3, 7, ...(project.mode === "3d" ? [11] : [])].includes(index))
                        .map((value) => Number(value.toFixed(6))).join(", ")}
                </output>}
                <label>編集座標<select aria-label="編集座標" value={space} onChange={(event) => { cancelDrag(); setSpace(event.currentTarget.value as "world" | "parent"); }}>
                    <option value="parent">Parent Local</option><option value="world">World</option>
                </select></label>
                <label><input type="checkbox" checked={snap} onChange={(event) => setSnap(event.currentTarget.checked)} />位置スナップ</label>
                {(["2d", "3d"] as const).map((item) => <TimelineNumber key={item} label={item.toUpperCase() + " スナップ間隔"} value={intervals[item]}
                    onCommit={(input) => {
                        try {
                            const value = input.trim() ? Number(input) : NaN; snapPosition([0], value);
                            const next = { ...intervals, [item]: value };
                            localStorage.setItem(SNAP_STORAGE, JSON.stringify(next)); setIntervals(next); setMessage("");
                        } catch (error) { setMessage(String(error)); }
                    }} />)}
                <label><input type="checkbox" checked={resolveBackground(DEFAULT_BACKGROUND, project.preview?.background ?? {}).grid}
                    onChange={(event) => execute({ kind: "project.preview", preview: { ...(project.preview ?? DEFAULT_PREVIEW),
                        background: { ...project.preview?.background, grid: event.currentTarget.checked } } })} />編集グリッド</label>
                <p>3DグリッドはY上のXZ平面。親ローカルでは選択レイヤーの親を基準にします。</p>
            </section>
        </div>
        {layer && <fieldset className="hierarchy-inspector"><legend>{layer.name} の編集</legend>
            <label>名前<input aria-label="レイヤー名" key={layer.name} defaultValue={layer.name} disabled={locked}
                onBlur={(event) => { if (event.currentTarget.value !== layer.name) execute({ kind: "layer.update", layerId: layer.id, patch: { name: event.currentTarget.value } }); }} /></label>
            <label><input type="checkbox" checked={layer.isVisible} onChange={(event) => execute({ kind: "layer.update", layerId: layer.id,
                patch: { isVisible: event.currentTarget.checked } })} />自身を表示</label>
            <label><input type="checkbox" checked={layer.isLocked} onChange={(event) => execute({ kind: "layer.update", layerId: layer.id,
                patch: { isLocked: event.currentTarget.checked } })} />自身をロック</label>
            {locked && <p role="note">自身または祖先のロックを継承しています。選択・表示切替・自身の解除ができます。</p>}
            <button disabled={locked} onClick={() => execute({ kind: "hierarchy.add", parentId: layer.id })}>子粒子を追加</button>
            <label>親<select aria-label="親を変更" value={layer.parentId ?? ""} onChange={(event) =>
                execute({ kind: "layer.reparent", layerId: layer.id, parentId: event.currentTarget.value || null, timeUs: time.current })}>
                <option value="">ルート</option>{project.layers.filter((item) => item.id !== layer.id).map((item) =>
                    <option key={item.id} value={item.id}>{item.name}{isLayerLocked(project, item.id) ? "（ロック）" : ""}</option>)}
            </select></label>
            <button disabled={locked || layer.parentId === null} onClick={() => execute({ kind: "layer.reparent", layerId: layer.id,
                parentId: layer.parentId ? hierarchyIndex(project).layers.get(layer.parentId.toLowerCase())!.parentId : null, timeUs: time.current })}>一段上へ親解除</button>
            <button disabled={locked} onClick={() => execute({ kind: "hierarchy.duplicate", layerId: layer.id })}>階層を複製</button>
            <button disabled={locked} onClick={() => setDeleting({ id: layer.id, project: flow.history.snapshot.project })}>階層を削除</button>
            <button disabled={locked} onClick={() => execute({ kind: "hierarchy.reorder", layerId: layer.id, direction: -1 })}>兄弟順を上へ</button>
            <button disabled={locked} onClick={() => execute({ kind: "hierarchy.reorder", layerId: layer.id, direction: 1 })}>兄弟順を下へ</button>
            <TimelineNumber label="描画順" value={layer.order} onCommit={(input) => execute({ kind: "layer.update", layerId: layer.id, patch: { order: Number(input) } })} />
            <label>レイヤー色<input aria-label="レイヤー色" type="color" key={colorHex(layer.values.color)} defaultValue={colorHex(layer.values.color)} disabled={locked}
                onBlur={(event) => { if (event.currentTarget.value !== colorHex(layer.values.color)) execute({ kind: "layer.update", layerId: layer.id,
                    patch: { values: { color: fromHex(event.currentTarget.value) } } }); }} /></label>
            <TimelineNumber label="レイヤー透明度" value={layer.values.opacity} onCommit={(input) => execute({ kind: "layer.update", layerId: layer.id,
                patch: { values: { opacity: input.trim() ? Number(input) : NaN } } })} />
            {transformError && <p role="note">{transformError} Parent Localで編集できます。</p>}
            {transformInputs("position", "位置")}{transformInputs("rotation", "回転")}{transformInputs("size", "スケール")}
            <button className="transform-drag" disabled={locked || !transform} onPointerDown={(event) => {
                if (!transform || event.button !== 0) return;
                try {
                    const token = flow.history.beginContinuousEdit(); // ドラッグ開始時の基準位置
                    transformDrag.current = { token, x: event.clientX, timeUs: time.current, initial: transform.position };
                    event.currentTarget.setPointerCapture(event.pointerId);
                } catch (error) { setMessage(String(error)); }
            }} onPointerMove={(event) => {
                const active = transformDrag.current;
                if (!active) return;
                const position = active.initial.map((entry, axis) => axis === 0 ? entry + (event.clientX - active.x) * (project.mode === "2d" ? 1 : 0.01) : entry);
                const valid = flow.history.updateContinuousEdit(active.token, { kind: "layer.transform", layerId: layer.id, timeUs: active.timeUs,
                    space, values: { position: position as unknown as LayerValues<Mode>["position"] }, ...(snap ? { snapInterval: intervals[project.mode] } : {}) });
                if (!valid) setMessage("この位置へは変換できません。確定値を維持します。");
            }} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag} onPointerUp={() => {
                const active = transformDrag.current;
                if (!active) return;
                try {
                    if (!flow.history.commitContinuousEdit(active.token)) flow.history.cancelContinuousEdit(active.token);
                } catch { /* 無変更時は既に確定終了している */ }
                transformDrag.current = undefined; refresh();
            }}>ドラッグでX方向へ移動</button>
        </fieldset>}
        <p role="alert">{message}</p>
        <VcrReview key={mode} session={flow} onChange={refresh} />
        <details><summary>共有タイムラインとキーフレーム</summary>
            <TimelineReview key={mode} session={flow} embedded sharedTime={time} onChange={refresh} />
        </details>
        {deleting && <TimelineDialog label="親と子孫を削除しますか" onCancel={() => setDeleting(undefined)}>
            <p>階層内の {hierarchyRows(deleting.project, deleting.id).length} レイヤーと関連するキーを削除します。</p>
            <button onClick={() => {
                setDeleting(undefined);
                if (flow.history.snapshot.project === deleting.project) execute({ kind: "layer.remove", layerId: deleting.id, descendants: true });
            }}>親と子孫を削除する</button>
        </TimelineDialog>}
    </div>;
}
