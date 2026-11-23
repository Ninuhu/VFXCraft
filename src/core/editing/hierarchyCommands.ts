import type { Layer, LayerValues, Mode, Project, Vec2, Vec3 } from "../document/model.ts";
import { layerValuesAt, tracksFor } from "../document/animation.ts";
import { composeTransform, decomposeTransform, hierarchyAt, hierarchyIndex, hierarchyRows, IDENTITY_MATRIX,
    inverseMatrix, multiplyMatrix, snapPosition, transformPosition } from "../document/hierarchy.ts";
import { isNonNegativeSafeInteger } from "../document/time.ts";

export type TransformValues = Pick<LayerValues<Mode>, "position" | "rotation" | "size">;
export type HierarchyCommand =
    | { kind: "hierarchy.add"; parentId: string | null; isGroup?: boolean }
    | { kind: "hierarchy.duplicate"; layerId: string }
    | { kind: "hierarchy.reorder"; layerId: string; direction: -1 | 1 }
    | { kind: "layer.transform"; layerId: string; timeUs: number; space: "world" | "parent";
        values: Partial<TransformValues>; snapInterval?: number };

////////////////////
// 既存キーがある項目は現在時刻の一つだけを更新し、キーがなければ基準値を変更する
export function writeTransform(project: Project, layer: Layer, timeUs: number, transform: TransformValues): unknown {
    if (!isNonNegativeSafeInteger(timeUs) || timeUs > project.durationUs) throw new RangeError("編集時刻が制作尺の範囲外です。");
    let values = { ...layer.values }; // 基準値の候補
    const tracks: unknown[] = [...project.tracks]; // 必要なTrackだけ差し替える
    const current = layerValuesAt(project, layer, timeUs); // 無変更の項目のキーは作らない
    for (const property of ["position", "rotation", "size"] as const) {
        if (JSON.stringify(current[property]) === JSON.stringify(transform[property])) continue;
        const track = tracksFor(project, layer.id)?.get(property); // 対象のトラック
        if (!track?.keys.length) { values = { ...values, [property]: transform[property] }; continue; }
        if (timeUs < layer.startUs) throw new RangeError("開始前のアニメーションを保ったまま変換できません。開始以降で編集してください。");
        const offsetUs = timeUs - layer.startUs; // 子自身の開始時刻からの位置
        const existing = track.keys.find((key) => key.offsetUs === offsetUs); // 現在時刻と一致するキー
        const left = [...track.keys].reverse().find((key) => key.offsetUs < offsetUs); // 分割前の区間方式を引き継ぐ
        const key = { ...(existing ?? { interpolation: left?.interpolation ?? track.interpolation }),
            offsetUs, value: transform[property] }; // 既存キー自身の区間方式は省略も含めて保つ
        const keys = [...track.keys.filter((item) => item.offsetUs !== offsetUs), key].sort((a, b) => a.offsetUs - b.offsetUs);
        tracks[project.tracks.indexOf(track as never)] = { ...track, keys };
    }
    return { ...project, tracks, layers: project.layers.map((item) => item === layer ? { ...layer, values } : item) };
}

////////////////////
// 新しい親の逆変換からローカルTRSを求め、現在時刻のワールド行列を保つ
export function reparentLayer(project: Project, layerId: string, parentId: string | null, timeUs: number): unknown {
    if ((parentId !== null && typeof parentId !== "string") || !isNonNegativeSafeInteger(timeUs) || timeUs > project.durationUs) {
        throw new RangeError("再親子化の親IDまたは現在時刻が不正です。");
    }
    const index = hierarchyIndex(project), layer = index.layers.get(layerId.toLowerCase()); // 検証対象
    if (!layer) throw new RangeError("レイヤーが存在しません。");
    if (layer.parentId?.toLowerCase() === parentId?.toLowerCase()) return project;
    if (parentId !== null) {
        if (!index.layers.has(parentId.toLowerCase())) throw new RangeError("親レイヤーが存在しません。");
        if (hierarchyRows(project, layer.id).some((entry) => entry.layer.id.toLowerCase() === parentId.toLowerCase())) {
            throw new RangeError("自分または子孫を親にはできません。");
        }
    }
    const previous = hierarchyAt(project, layer.id, timeUs).matrix; // 変更前のワールド変換
    const parent = parentId === null ? IDENTITY_MATRIX : hierarchyAt(project, parentId, timeUs).matrix;
    const local = multiplyMatrix(inverseMatrix(parent), previous); // 新親の空間へ変換する
    const transform = decomposeTransform(local, project.mode); // Shearなどを拒否する
    const candidate = writeTransform(project, layer, timeUs, transform) as Project; // 外側で文書全体を検証する
    return { ...candidate, layers: candidate.layers.map((item) => item.id === layer.id ? { ...item, parentId } : item) };
}

////////////////////
// Worldは行列、Parent Localは保存TRSを編集する。ルートは両方ともワールド基準
export function editLayerTransform(project: Project, command: Extract<HierarchyCommand, { kind: "layer.transform" }>): unknown {
    const layer = hierarchyIndex(project).layers.get(command.layerId.toLowerCase());
    if (!layer) throw new RangeError("レイヤーが存在しません。");
    if (!["world", "parent"].includes(command.space)) throw new RangeError("編集空間が不正です。");
    if (Object.keys(command.values).some((key) => !["position", "rotation", "size"].includes(key))) throw new RangeError("未対応の変換項目です。");
    for (const [property, value] of Object.entries(command.values)) {
        if (property === "rotation" && project.mode === "2d") {
            if (typeof value !== "number" || !Number.isFinite(value)) throw new RangeError("2D回転角が不正です。");
        } else {
            const dimensions = property === "rotation" ? 4 : project.mode === "2d" ? 2 : 3; // 境界でモードと次元を確認
            if (!Array.isArray(value) || value.length !== dimensions || !value.every((component: unknown) =>
                typeof component === "number" && Number.isFinite(component) && (property !== "size" || component >= 0))) {
                throw new RangeError("Transformの値型・次元・数値範囲が不正です。");
            }
        }
    }
    const parent = layer.parentId === null ? IDENTITY_MATRIX : hierarchyAt(project, layer.parentId, command.timeUs).matrix;
    if (command.space === "world" && Object.keys(command.values).length === 1 && command.values.position !== undefined) {
        const position = command.snapInterval === undefined ? command.values.position : snapPosition(command.values.position, command.snapInterval);
        const localPosition = transformPosition(inverseMatrix(parent), position); // 位置だけならShearの分解は不要
        return writeTransform(project, layer, command.timeUs, { ...layerValuesAt(project, layer, command.timeUs),
            position: project.mode === "2d" ? [localPosition[0], localPosition[1]] : localPosition });
    }
    const current = command.space === "world" ? decomposeTransform(hierarchyAt(project, layer.id, command.timeUs).matrix, project.mode)
        : layerValuesAt(project, layer, command.timeUs);
    const requested = { position: current.position, rotation: current.rotation, size: current.size, ...command.values }; // UI空間での候補
    if (command.snapInterval !== undefined && command.values.position !== undefined) {
        requested.position = snapPosition(requested.position, command.snapInterval) as unknown as Vec2 | Vec3;
    }
    const local = command.space === "world" ? decomposeTransform(multiplyMatrix(inverseMatrix(parent),
        composeTransform({ ...requested, color: [1, 1, 1], opacity: 1 })), project.mode) : requested;
    return writeTransform(project, layer, command.timeUs, local);
}

////////////////////
// 階層全体を削除し、他のレイヤーが共有する発生器・材質・画像は保持する
export function removeHierarchy(project: Project, layerId: string, descendants: boolean): unknown {
    const rows = hierarchyRows(project, layerId); // 確認済みの削除範囲
    if (rows.length > 1 && !descendants) throw new RangeError("子孫を含む削除には確認が必要です。");
    const ids = new Set(rows.map((entry) => entry.layer.id.toLowerCase()));
    const layers = project.layers.filter((item) => !ids.has(item.id.toLowerCase()));
    const affectedEmitters = new Set(rows.flatMap(({ layer }) => layer.content.kind === "emitter" ? [layer.content.emitterId.toLowerCase()] : []));
    const retainedEmitters = new Set(layers.flatMap((layer) => layer.content.kind === "emitter" ? [layer.content.emitterId.toLowerCase()] : []));
    const emitters = project.emitters.filter((item) => !affectedEmitters.has(item.id.toLowerCase()) || retainedEmitters.has(item.id.toLowerCase()));
    const affectedMaterials = new Set(project.emitters.filter((item) => affectedEmitters.has(item.id.toLowerCase())).map((item) => item.materialId.toLowerCase()));
    const retainedMaterials = new Set(emitters.map((item) => item.materialId.toLowerCase()));
    const materials = project.materials.filter((item) => !affectedMaterials.has(item.id.toLowerCase()) || retainedMaterials.has(item.id.toLowerCase()));
    return { ...project, layers, emitters, materials, tracks: project.tracks.filter((item) => !ids.has(item.layerId.toLowerCase())) };
}

////////////////////
// 設定とキーを独立複製し、画像IDだけは外部のBlobストアと共有する
function duplicateHierarchy(project: Project, rootId: string): unknown {
    const rows = hierarchyRows(project, rootId); // 複製元の順序
    const layerIds = new Map(rows.map(({ layer }) => [layer.id.toLowerCase(), crypto.randomUUID()]));
    const emitterIds = new Map<string, string>(), materialIds = new Map<string, string>(); // 階層内部の共有は維持
    for (const { layer } of rows) if (layer.content.kind === "emitter") {
        const id = layer.content.emitterId.toLowerCase();
        const emitter = project.emitters.find((item) => item.id.toLowerCase() === id)!;
        emitterIds.set(id, emitterIds.get(id) ?? crypto.randomUUID());
        const materialId = emitter.materialId.toLowerCase();
        materialIds.set(materialId, materialIds.get(materialId) ?? crypto.randomUUID());
    }
    const order = project.layers.reduce((maximum, layer) => Math.max(maximum, layer.order), -1) + 1; // 深い階層でも引数上限に依存しない
    const layers = rows.map(({ layer }, index) => ({ ...structuredClone(layer), id: layerIds.get(layer.id.toLowerCase())!,
        name: layer.name + " コピー", order: order + index,
        parentId: layer.parentId === null ? null : layerIds.get(layer.parentId.toLowerCase()) ?? layer.parentId,
        content: layer.content.kind === "group" ? { kind: "group" } : { kind: "emitter", emitterId: emitterIds.get(layer.content.emitterId.toLowerCase())! } }));
    const emitters = project.emitters.filter((item) => emitterIds.has(item.id.toLowerCase())).map((item) =>
        ({ ...structuredClone(item), id: emitterIds.get(item.id.toLowerCase())!, materialId: materialIds.get(item.materialId.toLowerCase())! }));
    const materials = project.materials.filter((item) => materialIds.has(item.id.toLowerCase())).map((item) =>
        ({ ...structuredClone(item), id: materialIds.get(item.id.toLowerCase())! }));
    const tracks = project.tracks.filter((track) => layerIds.has(track.layerId.toLowerCase())).map((track) =>
        ({ ...structuredClone(track), layerId: layerIds.get(track.layerId.toLowerCase())! }));
    return { ...project, layers: [...project.layers, ...layers], emitters: [...project.emitters, ...emitters],
        materials: [...project.materials, ...materials], tracks: [...project.tracks, ...tracks] };
}

////////////////////
// 履歴に流す候補を作り、文書検証とロック検証は共通の入口で行う
export function editHierarchy(project: Project, command: HierarchyCommand): unknown {
    if (command.kind === "layer.transform") return editLayerTransform(project, command);
    if (command.kind === "hierarchy.duplicate") return duplicateHierarchy(project, command.layerId);
    if (command.kind === "hierarchy.reorder") {
        if (command.direction !== -1 && command.direction !== 1) throw new RangeError("並び替え方向が不正です。");
        const layer = hierarchyIndex(project).layers.get(command.layerId.toLowerCase());
        if (!layer) throw new RangeError("レイヤーが存在しません。");
        const siblings = hierarchyIndex(project).children.get(layer.parentId?.toLowerCase() ?? null)!;
        const next = siblings[siblings.indexOf(layer) + command.direction];
        if (!next) return project;
        if (layer.order === next.order) throw new RangeError("同じ描画順の兄弟は、先に描画順の数値を変更してください。");
        return { ...project, layers: project.layers.map((entry) => entry === layer ? { ...entry, order: next.order }
            : entry === next ? { ...entry, order: layer.order } : entry) };
    }
    if (command.parentId !== null && !hierarchyIndex(project).layers.has(command.parentId.toLowerCase())) throw new RangeError("親が存在しません。");
    const id = crypto.randomUUID(), emitterId = crypto.randomUUID(), materialId = crypto.randomUUID(); // 新しい固有参照
    const is2D = project.mode === "2d";
    const origin = is2D ? [0, 0] : [0, 0, 0];
    const layer = { id, parentId: command.parentId, name: command.isGroup ? "新しいグループ" : "新しい粒子", order: project.layers.reduce((max, item) =>
        Math.max(max, item.order), -1) + 1, isVisible: true, isLocked: false, startUs: 0,
        values: { position: origin, rotation: is2D ? 0 : [0, 0, 0, 1], size: is2D ? [1, 1] : [1, 1, 1], color: [1, 1, 1], opacity: 1 },
        content: command.isGroup ? { kind: "group" } : { kind: "emitter", emitterId } };
    if (command.isGroup) return { ...project, layers: [...project.layers, layer] };
    const emitter = { id: emitterId, materialId, lifetimeUs: 2_000_000, emission: { kind: "continuous", ratePerSecond: 30 },
        ...(is2D ? { particle2d: { speed: 15, directionDegrees: 270, acceleration: [0, 0], space: "local", seed: 1, shape: { kind: "point" } } }
            : { particle3d: { speed: 0.2, direction: [0, 1, 0], acceleration: [0, 0, 0], space: "local", seed: 1, shape: "point", billboard: "camera" } }) };
    const material = { id: materialId, textureAssetId: null, blend: "alpha", color: [1, 1, 1], hasBloom: false, gradient: [] };
    return { ...project, layers: [...project.layers, layer], emitters: [...project.emitters, emitter], materials: [...project.materials, material] };
}
