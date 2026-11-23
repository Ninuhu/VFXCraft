import { useEffect, useRef, useState } from "react";
import type { Gradient, Material } from "../../core/document/model.ts";
import { DEFAULT_APPEARANCE, evaluateGradient } from "../../core/materials/materialEvaluation.ts";
import { colorHex, GradientControls } from "../materials/GradientControls.tsx";
import { useEditor } from "./EditorContext.tsx";
import { EditColor } from "./EditColor.tsx";

////////////////////
// グラデーションの計算はT07を再利用し、制御点のドラッグだけを一履歴へ集約する。
export function GradientEditor({ name, gradient, material, field }: { name: string; gradient: Gradient; material: Material; field: "lifetime" | "spatial" }) {
    const editor = useEditor(), bar = useRef<HTMLDivElement>(null); // 位置の基準
    const [selected, setSelected] = useState(""); // 制御点選択は文書と分離
    const drag = useRef<{ token: symbol; gradient: Gradient; type: "colors" | "alphas"; index: number } | null>(null); // 開始時の点を識別
    useEffect(() => () => { if (drag.current) { try { editor.flow.history.cancelContinuousEdit(drag.current.token); } catch { /* 切替済み */ } } }, [editor.flow]);
    ////////////////////
    // 制御点候補は既存のマテリアルコマンドで検証する。
    function command(next: Gradient) {
        return { kind: "material.appearance" as const, materialId: material.id, color: material.color, blend: material.blend,
            appearance: { ...(material.appearance ?? DEFAULT_APPEARANCE), [field]: next } };
    }
    const stops = Array.from({ length: 17 }, (_, index) => {
        const sample = evaluateGradient(gradient, index / 16); // 独自の色補間をUIへ作らない
        return colorHex([sample[0], sample[1], sample[2]]) + " " + index / 16 * 100 + "%";
    });
    return <details><summary>{name}グラデーション</summary>
        <div className="gradient-bar" ref={bar} style={{ background: "linear-gradient(to right," + stops.join(",") + ")" }}>
            {(["colors", "alphas"] as const).flatMap((type) => gradient[type].map((stop, index) => <button key={type + index}
                aria-label={name + (type === "colors" ? " 色" : " Alpha") + "制御点 " + (index + 1)}
                aria-pressed={selected === type + index} title="ドラッグで位置変更。Escapeで取消。正確な位置は下の入力欄で編集。"
                style={{ left: stop.offset * 100 + "%", top: type === "colors" ? -10 : 20 }} className="gradient-handle"
                onPointerDown={(event) => {
                    event.preventDefault(); setSelected(type + index);
                    try { drag.current = { token: editor.flow.history.beginContinuousEdit(), gradient, type, index }; event.currentTarget.setPointerCapture(event.pointerId); }
                    catch (error) { editor.report(error); }
                }} onPointerMove={(event) => {
                    const active = drag.current, rect = bar.current?.getBoundingClientRect(); // ドラッグ開始時の配列の識別を維持
                    if (!active || !rect) return;
                    const offset = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))); // 位置は0〜1
                    const next = { ...active.gradient, [active.type]: active.gradient[active.type].map((item, position) => position === active.index ? { ...item, offset } : item) };
                    try { editor.flow.history.updateContinuousEdit(active.token, command(next)); editor.refresh(); } catch (error) { editor.report(error); }
                }} onPointerUp={() => {
                    if (!drag.current) return;
                    const token = drag.current.token; // 不正な重複位置では開始前へ戻す
                    if (!editor.flow.history.commitContinuousEdit(token)) {
                        try { editor.flow.history.cancelContinuousEdit(token); } catch { /* 無変更で正常終了した場合 */ }
                    }
                    drag.current = null; editor.refresh();
                }} onPointerCancel={() => { if (drag.current) editor.flow.history.cancelContinuousEdit(drag.current.token); drag.current = null; editor.refresh(); }}
                onKeyDown={(event) => { if (event.key === "Escape" && drag.current) { editor.flow.history.cancelContinuousEdit(drag.current.token); drag.current = null; editor.refresh(); } }}>◆</button>))}
        </div>
        <GradientControls name={name} gradient={gradient} onChange={(next) => editor.execute(command(next))}
            renderColor={(label, value, replace) => <EditColor label={label} value={value} command={(next) => command(replace(next))} />} />
    </details>;
}
