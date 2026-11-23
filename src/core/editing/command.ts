import type { Material, ProjectPreview, Emitter, Asset, Layer, LayerValues, Mode, Project, Track, Keyframe } from "../document/model.ts";
import { DocumentValidationError, validateProject } from "../document/validateDocument.ts";
import { shareValidatedProject } from "./snapshot.ts";
import { editHierarchy, reparentLayer, removeHierarchy, type HierarchyCommand } from "./hierarchyCommands.ts";
import { protectEditing } from "./protectEditing.ts";

type LayerPatch = Partial<Pick<Layer, "name" | "order" | "isVisible" | "isLocked" | "startUs" | "emissionEndUs">>
    & { readonly values?: Partial<LayerValues<Mode>> };
type TrackTarget = Pick<Track, "layerId" | "property">;

export type EditCommand =
    | { readonly kind: "edit.batch"; readonly commands: readonly EditCommand[] }
    | HierarchyCommand
    | { readonly kind: "timeline.duration"; readonly durationUs: number; readonly outside?: "keep" | "delete" }
    | { readonly kind: "timeline.fps"; readonly productionFps: number }
    | { readonly kind: "material.appearance"; readonly materialId: string; readonly appearance: NonNullable<Material["appearance"]>;
        readonly color: Material["color"]; readonly blend: Material["blend"]; readonly textureAssetId?: Material["textureAssetId"] }
    | { readonly kind: "project.preview"; readonly preview: ProjectPreview }
    | { readonly kind: "emitter.update"; readonly emitterId: string; readonly settings: Pick<Emitter, "emission" | "lifetimeUs" | "particle2d" | "particle3d"> }
    | { readonly kind: "drawing.update"; readonly drawing: "normal" | "pixel"; readonly pixelScale: number }
    | { readonly kind: "layer.add"; readonly layer: Layer }
    | { readonly kind: "layer.remove"; readonly layerId: string; readonly descendants?: true }
    | { readonly kind: "layer.update"; readonly layerId: string; readonly patch: LayerPatch }
    | { readonly kind: "layer.reparent"; readonly layerId: string; readonly parentId: string | null; readonly timeUs?: number }
    | ({ readonly kind: "key.add"; readonly key: Keyframe; readonly interpolation?: Track["interpolation"] } & TrackTarget)
    | ({ readonly kind: "key.update"; readonly offsetUs: number; readonly key: Keyframe; readonly overwrite?: true } & TrackTarget)
    | ({ readonly kind: "key.remove"; readonly offsetUs: number } & TrackTarget)
    | { readonly kind: "asset.add"; readonly asset: Asset }
    | { readonly kind: "asset.remove"; readonly assetId: string }
    | { readonly kind: "material.setTexture"; readonly materialId: string; readonly assetId: string | null };

const LAYER_PATCH_FIELDS = new Set(["name", "order", "isVisible", "isLocked", "startUs", "emissionEndUs", "values"]); // 更新を許可する項目

type KeyCommand = Extract<EditCommand, { kind: "key.add" | "key.update" | "key.remove" }>;

////////////////////
// T02と同じ規則でUUID参照を照合する
function sameId(left: string, right: string): boolean {
    return left.toLowerCase() === right.toLowerCase();
}

////////////////////
// 指定された編集対象を取得し、対象がなければ位置付きで拒否する
function findEntity<T extends { readonly id: string }>(items: readonly T[], id: string, path: string): T {
    const item = items.find((entry) => sameId(entry.id, id)); // 編集対象
    if (!item) throw new DocumentValidationError(path, "編集対象が存在しません。");
    return item;
}

////////////////////
// キー編集の候補を組み立て、時刻の一意性と値型の検証はT02に委ねる
function editKeys(project: Project, command: KeyCommand): unknown {
    const layer = findEntity<Layer>(project.layers, command.layerId, "command.layerId"); // Trackの対象
    const track = project.tracks.find((item) => sameId(item.layerId, layer.id) && item.property === command.property); // 既存Track
    const keys: Keyframe[] = [...(track?.keys ?? [])]; // 編集候補のキー列
    if (command.kind !== "key.remove" && (command.kind === "key.add" || command.offsetUs !== command.key.offsetUs)
        && command.key.offsetUs > project.durationUs - layer.startUs) {
        throw new DocumentValidationError("command.key.offsetUs", "移動先または追加先が制作尺の範囲外です。");
    }
    if (command.kind === "key.add") {
        keys.push(command.key);
    } else {
        const index = keys.findIndex((key) => key.offsetUs === command.offsetUs); // 変更または削除するキー
        if (index === -1) throw new DocumentValidationError("command.offsetUs", "編集対象のキーが存在しません。");
        if (command.kind === "key.update") {
            const collision = keys.findIndex((key, other) => other !== index && key.offsetUs === command.key.offsetUs); // 移動先のキー
            if (collision >= 0 && command.overwrite !== true) throw new DocumentValidationError("command.key.offsetUs", "移動先にキーがあります。");
            keys[index] = { ...keys[index]!, ...command.key };
            if (collision >= 0) keys.splice(collision, 1);
        }
        else keys.splice(index, 1);
    }
    if (track && keys.length === 0) {
        return { ...project, tracks: project.tracks.filter((item) => item !== track) };
    }
    keys.sort((left, right) => left.offsetUs - right.offsetUs);
    const changedTrack = track ? { ...track, keys } : {
        layerId: layer.id,
        property: command.property,
        interpolation: command.kind === "key.add" ? command.interpolation ?? "linear" : "linear",
        keys,
    }; // 既存Trackの補間設定は保持する
    return { ...project, tracks: track
        ? project.tracks.map((item) => item === track ? changedTrack : item)
        : [...project.tracks, changedTrack] };
}

////////////////////
// 尺の変更と確認済みの範囲外キー処理を一つの履歴にまとめる
function changeDuration(project: Project, command: Extract<EditCommand, { kind: "timeline.duration" }>): unknown {
    const starts = new Map(project.layers.map((layer) => [layer.id.toLowerCase(), layer.startUs])); // レイヤー開始時刻
    let outside = false; // 範囲外キーがあるか
    const tracks = (project.tracks as readonly Track[]).flatMap<unknown>((track) => {
        const maximum = command.durationUs - starts.get(track.layerId.toLowerCase())!; // 相対キーの上限
        const keys = track.keys.filter((key) => key.offsetUs <= maximum); // 残すキー
        if (keys.length === track.keys.length) return [track];
        outside = true;
        if (command.outside !== "delete") return [track];
        return keys.length ? [{ ...track, keys }] : [];
    });
    if (outside && !command.outside && !(project.allowOutsideKeys && command.durationUs >= project.durationUs)) {
        throw new DocumentValidationError("command.durationUs", "制作尺外のキーの処理を選んでください。");
    }
    const { allowOutsideKeys: _old, ...current } = project; // 延長後は不要な保持指定を除く
    const keep = (outside && command.outside !== "delete") || project.layers.some((layer) => layer.startUs >= command.durationUs);
    return { ...current, durationUs: command.durationUs, tracks, ...(keep ? { allowOutsideKeys: true } : {}) };
}

////////////////////
// 元の文書を変更せずに編集候補を組み立てる
function createCandidate(project: Project, command: EditCommand): unknown {
    switch (command.kind) {
        case "edit.batch":
            // 各候補にもロック・参照検証を適用し、失敗時は呼出元の文書を変更しない。
            if (command.commands.some((item) => item.kind === "layer.update" && item.patch.isLocked === false)) {
                throw new RangeError("ロック解除は個別に実行してください。複合編集でロック保護を回避できません。");
            }
            return command.commands.reduce((candidate, item) => applyEditCommand(candidate, item), project);
        case "layer.transform":
        case "hierarchy.add":
        case "hierarchy.duplicate":
        case "hierarchy.reorder":
            return editHierarchy(project, command);
        case "layer.reparent":
            return reparentLayer(project, command.layerId, command.parentId, command.timeUs ?? 0);
        case "timeline.duration":
            return changeDuration(project, command);
        case "timeline.fps":
            return { ...project, productionFps: command.productionFps };
        case "project.preview":
            return { ...project, preview: command.preview };
        case "material.appearance": {
            const material = findEntity(project.materials, command.materialId, "command.materialId"); // 更新対象
            return { ...project, materials: project.materials.map((entry) => entry === material
                ? { ...entry, color: command.color, blend: command.blend, appearance: command.appearance,
                    textureAssetId: command.textureAssetId === undefined ? entry.textureAssetId : command.textureAssetId } : entry) };
        }
        case "emitter.update": {
            const emitter = findEntity(project.emitters, command.emitterId, "command.emitterId"); // 設定変更対象
            if (Object.keys(command.settings).some((key) => !["emission", "lifetimeUs", "particle2d", "particle3d"].includes(key))) {
                throw new DocumentValidationError("command.settings", "未対応の発生器設定です。");
            }
            return { ...project, emitters: project.emitters.map((item) => item === emitter ? { ...item, ...command.settings } : item) };
        }
        case "drawing.update":
            if (project.mode !== "2d") throw new DocumentValidationError("command", "2D専用の描画設定です。");
            return { ...project, drawing: command.drawing, pixelScale: command.pixelScale };
        case "layer.add":
            return { ...project, layers: [...project.layers, command.layer] };
        case "layer.remove":
            return removeHierarchy(project, command.layerId, command.descendants === true);
        case "layer.update": {
            const layer = findEntity<Layer>(project.layers, command.layerId, "command.layerId"); // 変更対象
            if (command.kind === "layer.update" && Object.keys(command.patch).some((key) => !LAYER_PATCH_FIELDS.has(key))) {
                throw new DocumentValidationError("command.patch", "変更できないレイヤー項目です。");
            }
            if (command.kind === "layer.update" && command.patch.startUs !== undefined && command.patch.startUs >= project.durationUs) {
                throw new DocumentValidationError("command.patch.startUs", "レイヤー開始が制作尺の範囲外です。");
            }
            const changed = { ...layer, ...command.patch, values: { ...layer.values, ...command.patch.values } }; // 親の変更は専用コマンドへ
            return { ...project, layers: project.layers.map((item) => item === layer ? changed : item) };
        }
        case "key.add":
        case "key.update":
        case "key.remove":
            return editKeys(project, command);
        case "asset.add":
            return { ...project, assets: [...project.assets, command.asset] };
        case "asset.remove": {
            const asset = findEntity(project.assets, command.assetId, "command.assetId"); // 削除対象の素材
            return { ...project, assets: project.assets.filter((item) => item !== asset),
                materials: project.materials.map((item) => item.textureAssetId !== null
                    && sameId(item.textureAssetId, asset.id) ? { ...item, textureAssetId: null } : item) };
        }
        case "material.setTexture": {
            const material = findEntity(project.materials, command.materialId, "command.materialId"); // 参照を変更する材質
            const textureAssetId = command.assetId === null ? null
                : findEntity(project.assets, command.assetId, "command.assetId").id; // 文書中の素材ID
            if (textureAssetId !== null && material.textureAssetId !== null && sameId(textureAssetId, material.textureAssetId)) {
                return project;
            }
            return { ...project, materials: project.materials.map((item) => item === material
                ? { ...item, textureAssetId } : item) };
        }
        default:
            throw new DocumentValidationError("command.kind", "未対応の編集コマンドです。");
    }
}

////////////////////
// 候補をT02で検証し、変更のない部分を共有する確定可能な文書を返す
export function applyEditCommand(project: Project, command: EditCommand): Project {
    try {
        protectEditing(project, command);
        const validated = validateProject(createCandidate(project, command)); // 参照を含めて検証済みの候補
        return shareValidatedProject(project, validated);
    } catch (error) {
        if (error instanceof RangeError) throw new DocumentValidationError("command", error.message);
        throw error;
    }
}
