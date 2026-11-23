import type { Project } from "../../core/document/model.ts";
import type { EditCommand } from "../../core/editing/command.ts";

////////////////////
// アクティブな一階層を恒等グループで包み、子の発生期間・キーを変更しない。
export function groupLayerCommand(project: Project, layerId: string, timeUs: number): { groupId: string; command: EditCommand } {
    const layer = project.layers.find((item) => item.id === layerId); // ユーザーが選択した一層
    if (!layer) throw new Error("グループ化するレイヤーが存在しません。");
    const groupId = crypto.randomUUID(); // 複製元の固有参照を共有しない
    return { groupId, command: { kind: "edit.batch", commands: [
        { kind: "layer.add", layer: { id: groupId, name: "グループ", parentId: layer.parentId, order: layer.order,
            startUs: 0, isVisible: true, isLocked: false, content: { kind: "group" },
            values: { position: project.mode === "2d" ? [0, 0] : [0, 0, 0], rotation: project.mode === "2d" ? 0 : [0, 0, 0, 1],
                size: project.mode === "2d" ? [1, 1] : [1, 1, 1], color: [1, 1, 1], opacity: 1 } } },
        { kind: "layer.reparent", layerId, parentId: groupId, timeUs },
    ] } };
}

////////////////////
// 子を一段上へ外してから空グループを取り除き、一回のUndoで戻せるようにする。
export function ungroupLayerCommand(project: Project, layerId: string, timeUs: number): EditCommand {
    const group = project.layers.find((item) => item.id === layerId); // 通常粒子の削除とは区別
    if (!group || group.content.kind !== "group") throw new Error("グループを選択してください。");
    return { kind: "edit.batch", commands: [
        ...project.layers.filter((item) => item.parentId === layerId).map((item): EditCommand => ({ kind: "layer.reparent", layerId: item.id, parentId: group.parentId, timeUs })),
        { kind: "layer.remove", layerId },
    ] };
}
