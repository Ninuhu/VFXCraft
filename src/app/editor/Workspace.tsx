import type { CSSProperties, ReactNode } from "react";
import { PANEL_IDS, parseLayout, type PanelId, type PanelLayout } from "./preferences.ts";

export const PANEL_LABELS: Record<PanelId, string> = { hierarchy: "レイヤー", properties: "インスペクター", preview: "プレビュー", timeline: "タイムライン" }; // 表示と設定を統一

////////////////////
// ドッキングはブラウザ内の四領域に制限し、初期配置と復旧操作を常に残す。
export function Workspace({ layout, onChange, panels }: { layout: PanelLayout; onChange: (layout: PanelLayout) => void; panels: Record<PanelId, ReactNode> }) {
    ////////////////////
    // ドラッグの差分を設定サイズへ反映する。画面の狭い場合はCSS側でも制約する。
    function resize(key: "leftWidth" | "rightWidth" | "bottomHeight", start: number, value: number) {
        return (coordinate: number) => onChange(parseLayout({ ...layout, [key]: value + (coordinate - start) * (key === "leftWidth" ? 1 : -1) }));
    }
    return <div className="editor-workspace" style={{ "--left": layout.leftWidth + "px", "--right": layout.rightWidth + "px", "--bottom": layout.bottomHeight + "px" } as CSSProperties}>
        {(["left", "center", "right", "bottom"] as const).map((region) => <section key={region} className={"workspace-region region-" + region} aria-label={region + " パネル領域"}
            onDragOver={(event) => { if (event.dataTransfer.types.includes("vfxcraft-panel")) event.preventDefault(); }} onDrop={(event) => {
                const id = event.dataTransfer.getData("vfxcraft-panel") as PanelId; // 許可されたパネル以外は移動しない
                if (PANEL_IDS.includes(id)) { event.preventDefault(); onChange({ ...layout, [id]: { ...layout[id], region } }); }
            }}>
            {PANEL_IDS.filter((id) => layout[id].visible && layout[id].region === region).map((id) => <section key={id} className={"editor-panel panel-" + id} aria-label={PANEL_LABELS[id] + "パネル"}>
                <header draggable onDragStart={(event) => event.dataTransfer.setData("vfxcraft-panel", id)}><strong>{PANEL_LABELS[id]}</strong>
                    <button aria-label={PANEL_LABELS[id] + "を非表示"} onClick={() => onChange({ ...layout, [id]: { ...layout[id], visible: false } })}>×</button></header>
                <div className="panel-content">{panels[id]}</div>
            </section>)}
        </section>)}
        {(["leftWidth", "rightWidth", "bottomHeight"] as const).map((key) => <div key={key} role="separator" aria-label={key + " サイズ変更"}
            tabIndex={0} aria-orientation={key === "bottomHeight" ? "horizontal" : "vertical"} className={"panel-resizer resizer-" + key}
            onPointerDown={(event) => {
                const start = key === "bottomHeight" ? event.clientY : event.clientX; // このドラッグだけがイベントを所有
                const apply = resize(key, start, layout[key]), owner = event.currentTarget; // 開始値を固定
                owner.setPointerCapture(event.pointerId);
                const move = (next: PointerEvent) => apply(key === "bottomHeight" ? next.clientY : next.clientX); // サイズの更新
                const finish = () => { owner.removeEventListener("pointermove", move); owner.removeEventListener("pointerup", finish); owner.removeEventListener("pointercancel", finish); }; // 購読解放
                owner.addEventListener("pointermove", move); owner.addEventListener("pointerup", finish); owner.addEventListener("pointercancel", finish);
            }} onKeyDown={(event) => {
                if (["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(event.key)) { event.preventDefault(); onChange(parseLayout({ ...layout, [key]: layout[key] + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -10 : 10) })); }
            }} />)}
    </div>;
}
