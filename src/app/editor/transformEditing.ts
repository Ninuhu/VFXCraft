import type { Layer, LayerValues, Mode, Project } from "../../core/document/model.ts";
import { composeTransform, decomposeTransform, hierarchyAt, IDENTITY_MATRIX, inverseMatrix, multiplyMatrix, snapPosition, transformPosition } from "../../core/document/hierarchy.ts";
import { layerValuesAt } from "../../core/document/animation.ts";
import { propertyCommand } from "./propertyEditing.ts";
import type { EditCommand } from "../../core/editing/command.ts";

////////////////////
// 編集軸を表示値へ変換する。Simulation Spaceは読み書きしない。
export function displayedTransform(project: Project, layer: Layer, timeUs: number, space: "world" | "parent") {
    return space === "world" ? decomposeTransform(hierarchyAt(project, layer.id, timeUs).matrix, project.mode)
        : layerValuesAt(project, layer, timeUs);
}

////////////////////
// 選択した編集空間から保存ローカル値へ戻す。表現不能なShearは既存の検証で拒否する。
export function transformCommand(project: Project, layer: Layer, timeUs: number, space: "world" | "parent",
    property: "position" | "rotation" | "size", value: LayerValues<Mode>[typeof property], autoKey: boolean, interval?: number): EditCommand {
    const current = displayedTransform(project, layer, timeUs, space); // 現在時刻に表示される変換
    const next = { ...layerValuesAt(project, layer, timeUs), ...current, [property]: property === "position" && interval ? snapPosition(value as never, interval) : value }; // スナップは位置のみ
    if (space === "parent" || !layer.parentId) return propertyCommand(project, layer, property, next[property], timeUs, autoKey);
    const inverse = inverseMatrix(hierarchyAt(project, layer.parentId, timeUs).matrix); // 親ローカルへの変換
    if (property === "position") {
        const local = transformPosition(inverse, project.mode === "2d" ? [...next.position, 0] as [number, number, number] : next.position as [number, number, number]);
        return propertyCommand(project, layer, property, project.mode === "2d" ? [local[0]!, local[1]!] : local, timeUs, autoKey);
    }
    const local = decomposeTransform(multiplyMatrix(inverse, composeTransform(next)), project.mode); // TRSへ正確に分解できる場合だけ採用
    return { kind: "edit.batch", commands: (["position", "rotation", "size"] as const).map((key) => propertyCommand(project, layer, key, local[key], timeUs, autoKey)) };
}

export { IDENTITY_MATRIX };
