import type { Emitter, Asset, Layer, LayerValues, Mode, Project, Track, TrackValue } from "../document/model.ts";
import { DocumentValidationError, validateProject } from "../document/validateDocument.ts";
import { shareValidatedProject } from "./snapshot.ts";

type LayerPatch = Partial<Pick<Layer, "name" | "order" | "isVisible" | "isLocked" | "startUs">>
    & { readonly values?: Partial<LayerValues<Mode>> };
type TrackTarget = Pick<Track, "layerId" | "property">;
type Keyframe = { readonly offsetUs: number; readonly value: TrackValue };

export type EditCommand =
    | { readonly kind: "emitter.update"; readonly emitterId: string; readonly settings: Pick<Emitter, "emission" | "lifetimeUs" | "particle2d"> }
    | { readonly kind: "drawing.update"; readonly drawing: "normal" | "pixel"; readonly pixelScale: number }
    | { readonly kind: "layer.add"; readonly layer: Layer }
    | { readonly kind: "layer.remove"; readonly layerId: string }
    | { readonly kind: "layer.update"; readonly layerId: string; readonly patch: LayerPatch }
    | { readonly kind: "layer.reparent"; readonly layerId: string; readonly parentId: string | null }
    | ({ readonly kind: "key.add"; readonly key: Keyframe; readonly interpolation?: Track["interpolation"] } & TrackTarget)
    | ({ readonly kind: "key.update"; readonly offsetUs: number; readonly key: Keyframe } & TrackTarget)
    | ({ readonly kind: "key.remove"; readonly offsetUs: number } & TrackTarget)
    | { readonly kind: "asset.add"; readonly asset: Asset }
    | { readonly kind: "asset.remove"; readonly assetId: string }
    | { readonly kind: "material.setTexture"; readonly materialId: string; readonly assetId: string | null };

const LAYER_PATCH_FIELDS = new Set(["name", "order", "isVisible", "isLocked", "startUs", "values"]); // 更新を許可する項目

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
    if (command.kind === "key.add") {
        keys.push(command.key);
    } else {
        const index = keys.findIndex((key) => key.offsetUs === command.offsetUs); // 変更または削除するキー
        if (index === -1) throw new DocumentValidationError("command.offsetUs", "編集対象のキーが存在しません。");
        if (command.kind === "key.update") keys[index] = command.key;
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
// 元の文書を変更せずに編集候補を組み立てる
function createCandidate(project: Project, command: EditCommand): unknown {
    switch (command.kind) {
        case "emitter.update": {
            const emitter = findEntity(project.emitters, command.emitterId, "command.emitterId"); // 設定変更対象
            if (Object.keys(command.settings).some((key) => !["emission", "lifetimeUs", "particle2d"].includes(key))) {
                throw new DocumentValidationError("command.settings", "未対応の発生器設定です。");
            }
            return { ...project, emitters: project.emitters.map((item) => item === emitter ? { ...item, ...command.settings } : item) };
        }
        case "drawing.update":
            if (project.mode !== "2d") throw new DocumentValidationError("command", "2D専用の描画設定です。");
            return { ...project, drawing: command.drawing, pixelScale: command.pixelScale };
        case "layer.add":
            return { ...project, layers: [...project.layers, command.layer] };
        case "layer.remove": {
            const layer = findEntity<Layer>(project.layers, command.layerId, "command.layerId"); // 削除対象
            return { ...project, layers: project.layers.filter((item) => item !== layer),
                tracks: project.tracks.filter((item) => !sameId(item.layerId, layer.id)) };
        }
        case "layer.update":
        case "layer.reparent": {
            const layer = findEntity<Layer>(project.layers, command.layerId, "command.layerId"); // 変更対象
            if (command.kind === "layer.update" && Object.keys(command.patch).some((key) => !LAYER_PATCH_FIELDS.has(key))) {
                throw new DocumentValidationError("command.patch", "変更できないレイヤー項目です。");
            }
            const changed = command.kind === "layer.update"
                ? { ...layer, ...command.patch, values: { ...layer.values, ...command.patch.values } }
                : { ...layer, parentId: layer.parentId !== null && command.parentId !== null
                    && sameId(layer.parentId, command.parentId) ? layer.parentId : command.parentId }; // ローカル値は保持する
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
    const validated = validateProject(createCandidate(project, command)); // 参照を含めて検証済みの候補
    return shareValidatedProject(project, validated);
}
