import type { EditCommand } from "./command.ts";
import type { Project } from "../document/model.ts";
import { hierarchyIndex, hierarchyRows, isLayerLocked } from "../document/hierarchy.ts";

////////////////////
// 祖先ロックを含む編集制限を全コマンド経路で確認する
export function protectEditing(project: Project, command: EditCommand): void {
    const index = hierarchyIndex(project); // 対象と共有参照の索引
    ////////////////////
    // レイヤー自身と祖先が編集を許可する場合だけ継続する
    function requireEditable(id: string): void {
        if (isLayerLocked(project, id)) throw new RangeError("レイヤー自身または祖先がロックされています。先に手動で解除してください。");
    }
    ////////////////////
    // 共有する発生器・材質を使うロック済みレイヤーも保護する
    function protectShared(kind: "emitter" | "material" | "asset", id: string): void {
        const key = id.toLowerCase(); // UUID比較の基準
        const materials = new Set(project.materials.filter((item) => kind === "material" ? item.id.toLowerCase() === key
            : kind === "asset" && item.textureAssetId?.toLowerCase() === key).map((item) => item.id.toLowerCase()));
        const emitters = new Set(project.emitters.filter((item) => kind === "emitter" ? item.id.toLowerCase() === key
            : materials.has(item.materialId.toLowerCase())).map((item) => item.id.toLowerCase()));
        for (const layer of project.layers) if (layer.content.kind === "emitter" && emitters.has(layer.content.emitterId.toLowerCase())) requireEditable(layer.id);
    }
    if (command.kind === "layer.update") {
        const allowed = Object.entries(command.patch).every(([key, value]) => key === "isVisible" || (key === "isLocked" && value === false));
        if (!allowed) requireEditable(command.layerId);
        if (Object.hasOwn(command.patch, "order")) {
            const layer = index.layers.get(command.layerId.toLowerCase());
            if (layer?.parentId) requireEditable(layer.parentId);
        }
        return;
    }
    if (command.kind === "layer.add") {
        if (command.layer.parentId) requireEditable(command.layer.parentId);
        return;
    }
    if (command.kind === "hierarchy.add") {
        if (command.parentId) requireEditable(command.parentId);
        return;
    }
    if ("layerId" in command) {
        requireEditable(command.layerId);
        const layer = index.layers.get(command.layerId.toLowerCase()); // 移動元と複製先の親
        if (["hierarchy.duplicate", "hierarchy.reorder", "layer.reparent", "layer.remove"].includes(command.kind)) {
            for (const { layer: descendant } of hierarchyRows(project, command.layerId)) requireEditable(descendant.id);
            if (layer?.parentId) requireEditable(layer.parentId);
        }
        if (command.kind === "layer.reparent" && command.parentId) requireEditable(command.parentId);
        if (command.kind === "hierarchy.reorder" && layer) {
            const siblings = index.children.get(layer.parentId?.toLowerCase() ?? null)!; // 位置が入れ替わるもう一方
            const other = siblings[siblings.indexOf(layer) + command.direction];
            if (other) requireEditable(other.id);
        }
        return;
    }
    if (command.kind === "emitter.update") protectShared("emitter", command.emitterId);
    if (command.kind === "material.appearance" || command.kind === "material.setTexture") protectShared("material", command.materialId);
    if (command.kind === "asset.remove") protectShared("asset", command.assetId);
    if (command.kind === "timeline.duration" && command.outside === "delete") {
        for (const track of project.tracks) {
            const layer = index.layers.get(track.layerId.toLowerCase())!;
            if (track.keys.some((key) => key.offsetUs > command.durationUs - layer.startUs)) requireEditable(layer.id);
        }
    }
}
