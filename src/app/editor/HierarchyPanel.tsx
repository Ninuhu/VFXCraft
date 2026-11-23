import { useState } from "react";
import { hierarchyRows, isLayerLocked } from "../../core/document/hierarchy.ts";
import { selectLayer } from "./selection.ts";
import { useEditor } from "./EditorContext.tsx";

////////////////////
// 階層の表示・選択は一時状態、変更はT09のロック検証を通るコマンドに委ねる。
export function HierarchyPanel() {
    const editor = useEditor(), project = editor.flow.history.preview; // 連続入力も表示に反映
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set()); // 折りたたみは文書に含めない
    const all = hierarchyRows(project), hidden = new Set<string>(); // 可視順と範囲選択の共通基準
    const rows = all.filter(({ layer }) => {
        if (layer.parentId && (collapsed.has(layer.parentId) || hidden.has(layer.parentId))) { hidden.add(layer.id); return false; }
        return true;
    });
    const active = project.layers.find((item) => item.id === editor.selection.active); // 複数選択でも編集は一層
    return <><div className="editor-actions">
        <button onClick={() => editor.execute({ kind: "hierarchy.add", parentId: null })}>＋ レイヤーを追加</button>
        <button disabled={!active} onClick={() => active && editor.execute({ kind: "hierarchy.add", parentId: active.id })}>子を追加</button>
        <button onClick={() => editor.execute({ kind: "hierarchy.add", parentId: null, isGroup: true })}>グループ追加</button>
    </div><div role="tree" aria-label="レイヤー階層" aria-multiselectable="true">
        {rows.map(({ layer, depth }) => <div key={layer.id} className={"layer-row " + (editor.selection.ids.includes(layer.id) ? "selected" : "")}
            style={{ paddingLeft: Math.min(depth, 20) * 14 }} role="treeitem" aria-selected={editor.selection.ids.includes(layer.id)} aria-level={depth + 1}
            draggable={!isLayerLocked(project, layer.id)} onDragStart={(event) => event.dataTransfer.setData("vfxcraft-layer", layer.id)}
            onDragOver={(event) => { if (!isLayerLocked(project, layer.id)) { event.preventDefault(); event.currentTarget.classList.add("drop-target"); } }}
            onDragLeave={(event) => event.currentTarget.classList.remove("drop-target")}
            onDrop={(event) => { event.preventDefault(); event.currentTarget.classList.remove("drop-target");
                const id = event.dataTransfer.getData("vfxcraft-layer"); // コマンド側で循環・ロック・Shearも再検証
                if (id) editor.execute({ kind: "layer.reparent", layerId: id, parentId: layer.id, timeUs: editor.time.current }); }}>
            <button aria-label={layer.name + " 展開切替"} onClick={() => { const next = new Set(collapsed); if (!next.delete(layer.id)) next.add(layer.id); setCollapsed(next); }}>{collapsed.has(layer.id) ? "▸" : "▾"}</button>
            <button className="layer-name" title={isLayerLocked(project, layer.id) ? "自身または祖先のロックを継承中。選択は可能です。" : "Ctrlで追加選択、Shiftで範囲選択"}
                onClick={(event) => editor.setSelection(selectLayer(editor.selection, layer.id, rows.map((item) => item.layer.id), event.ctrlKey, event.shiftKey))}>{layer.content.kind === "group" ? "▱ " : "✦ "}{layer.name}</button>
            <button aria-label={layer.name + " 表示"} onClick={() => editor.execute({ kind: "layer.update", layerId: layer.id, patch: { isVisible: !layer.isVisible } })}>{layer.isVisible ? "◉" : "○"}</button>
            <button aria-label={layer.name + " ロック"} title={isLayerLocked(project, layer.id) && !layer.isLocked ? "祖先のロックを継承中" : "自身のロック切替"}
                onClick={() => editor.execute({ kind: "layer.update", layerId: layer.id, patch: { isLocked: !layer.isLocked } })}>{layer.isLocked ? "🔒" : isLayerLocked(project, layer.id) ? "⛓" : "▫"}</button>
        </div>)}
    </div>{active && <><p>{editor.selection.ids.length}層選択／編集対象：{active.name}（一括編集なし）</p>
        <label>親<select aria-label="親レイヤー" value={active.parentId ?? ""} onChange={(event) => editor.execute({ kind: "layer.reparent", layerId: active.id, parentId: event.target.value || null, timeUs: editor.time.current })}>
            <option value="">ルート</option>{all.filter(({ layer }) => layer.id !== active.id).map(({ layer }) => <option key={layer.id} value={layer.id}>{layer.name}</option>)}
        </select></label><div className="editor-actions">
            {([-1, 1] as const).map((direction) => <button key={direction} onClick={() => editor.execute({ kind: "hierarchy.reorder", layerId: active.id, direction })}>{direction === -1 ? "↑" : "↓"}</button>)}
            <button title={editor.tip("duplicate", "選択した階層と設定・キーを独立複製")} onClick={() => editor.execute({ kind: "hierarchy.duplicate", layerId: active.id })}>複製</button>
            <button title={editor.tip("delete", "階層削除は確認後に実行")} onClick={() => void editor.confirm("選択したレイヤーと子孫を削除しますか。", ["親と子孫を削除"]).then((choice) => {
                if (choice === 0) editor.execute({ kind: "layer.remove", layerId: active.id, descendants: true });
            })}>削除</button>
        </div></>}
    </>;
}
