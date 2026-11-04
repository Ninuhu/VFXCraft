import {
    DOCUMENT_SCHEMA_VERSION, type Asset, type Emitter, type Layer, type LinearRgb,
    type Material, type Mode, type Preset, type Project, type Quaternion, type Track,
    type TrackProperty, type TrackValue, type Vec2, type Vec3,
} from "./model.ts";
import { normalizeQuaternion } from "./rotation.ts";
import { isNonNegativeSafeInteger, isProductionFps } from "./time.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i; // UUIDの版とvariant
const PROPERTIES = ["position", "rotation", "size", "color", "opacity"] as const; // 基本キーの対象
const PROJECT_FIELDS = ["schemaVersion", "mode", "id", "name", "durationUs", "productionFps", "layers",
    "emitters", "materials", "tracks", "assets"]; // 両モードに共通する項目

type EntityKind = "project" | "layer" | "emitter" | "material" | "asset";

/** 外部入力の不正箇所と理由を伝えるドメインエラー。 */
export class DocumentValidationError extends Error {
    public readonly path: string; // 不正な項目の文書内パス

    ////////////////////
    // 読み込んだ文書内の位置をエラーに付ける
    constructor(path: string, reason: string) {
        super(`${path}: ${reason}`);
        this.name = "DocumentValidationError";
        this.path = path;
    }
}

////////////////////
// 不正な入力を文書内の位置付きで拒否する
function fail(path: string, reason: string): never {
    throw new DocumentValidationError(path, reason);
}

////////////////////
// JSONオブジェクトの形を調べ、解釈できない項目を拒否する
function record(value: unknown, path: string, fields: readonly string[]): Record<string, unknown> {
    if (typeof value !== "object" || value === null ||
        (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
        fail(path, "オブジェクトが必要です。");
    }
    for (const key of Object.keys(value)) {
        if (!fields.includes(key)) fail(`${path}.${key}`, "未対応の項目です。");
    }
    return value as Record<string, unknown>;
}

////////////////////
// 配列の要素を順に検証し、入力と独立した配列を作る
function list<T>(value: unknown, path: string, read: (item: unknown, path: string) => T): T[] {
    if (!Array.isArray(value)) fail(path, "配列が必要です。");
    return Array.from(value, (item: unknown, index) => read(item, `${path}[${index}]`));
}

////////////////////
// 空白だけではない文字列を読み込む
function name(value: unknown, path: string): string {
    if (typeof value !== "string" || value.trim() === "") fail(path, "空でない文字列が必要です。");
    return value;
}

////////////////////
// UUID v4の文字列を検証し、元の綴りを保持する
function id(value: unknown, path: string): string {
    if (typeof value !== "string" || !UUID_V4.test(value)) fail(path, "UUID v4が必要です。");
    return value;
}

////////////////////
// 有限で指定範囲内の数値を読み込む
function number(value: unknown, path: string, min = -Infinity, max = Infinity): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
        fail(path, "許容範囲内の有限数が必要です。");
    }
    return value;
}

////////////////////
// 範囲内の安全整数を読み込む
function integer(value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
    if (!isNonNegativeSafeInteger(value) || value < min || value > max) {
        fail(path, "許容範囲内の安全整数が必要です。");
    }
    return value;
}

////////////////////
// 真偽値を読み込む
function flag(value: unknown, path: string): boolean {
    if (typeof value !== "boolean") fail(path, "真偽値が必要です。");
    return value;
}

////////////////////
// 定義済みの文字列だけを許可する
function choice<T extends string>(value: unknown, path: string, values: readonly T[]): T {
    const match = values.find((item) => item === value); // 一致した選択肢
    if (match === undefined) fail(path, `使用可能な値は ${values.join(", ")} です。`);
    return match;
}

////////////////////
// 指定成分数の有限ベクトルを読み込む
function components(value: unknown, path: string, length: number, min?: number, max?: number): number[] {
    if (!Array.isArray(value) || value.length !== length) fail(path, `${length}成分が必要です。`);
    return list(value, path, (item, itemPath) => number(item, itemPath, min, max));
}

////////////////////
// 非乗算のLinear sRGBを読み込む
function color(value: unknown, path: string): LinearRgb {
    return components(value, path, 3, 0, 1) as unknown as LinearRgb;
}

////////////////////
// モードとプロパティに対応する値を検証する
function trackValue(value: unknown, path: string, mode: Mode, property: TrackProperty): TrackValue {
    switch (property) {
        case "opacity": return number(value, path, 0, 1);
        case "color": return color(value, path);
        case "rotation": {
            if (mode === "2d") return number(value, path);
            const quaternion = components(value, path, 4) as unknown as Quaternion; // 有限の四成分
            if (quaternion.every((component) => component === 0)) fail(path, "ゼロ長Quaternionです。");
            return normalizeQuaternion(quaternion);
        }
        case "position":
        case "size":
            return components(value, path, mode === "2d" ? 2 : 3,
                property === "size" ? 0 : undefined) as unknown as Vec2 | Vec3;
    }
}

////////////////////
// レイヤーの階層情報とモード別の基準値を読み込む
function readLayer(value: unknown, path: string, mode: Mode, durationUs: number): Layer {
    const layer = record(value, path, ["id", "name", "parentId", "order", "isVisible", "isLocked", "startUs", "values", "content"]); // レイヤー候補
    const values = record(layer.values, `${path}.values`, PROPERTIES); // 基準値の候補
    const contentPath = `${path}.content`; // コンテンツ種別の位置
    const content = record(layer.content, contentPath, ["kind", "emitterId"]); // コンテンツ候補
    const kind = choice(content.kind, `${contentPath}.kind`, ["group", "emitter"]); // 内容の種別
    if (kind === "group" && Object.hasOwn(content, "emitterId")) fail(contentPath, "グループに発生器は指定できません。");
    return {
        id: id(layer.id, `${path}.id`), name: name(layer.name, `${path}.name`),
        parentId: layer.parentId === null ? null : id(layer.parentId, `${path}.parentId`),
        order: integer(layer.order, `${path}.order`),
        isVisible: flag(layer.isVisible, `${path}.isVisible`), isLocked: flag(layer.isLocked, `${path}.isLocked`),
        startUs: integer(layer.startUs, `${path}.startUs`, 0, durationUs - 1),
        values: {
            position: trackValue(values.position, `${path}.values.position`, mode, "position") as Vec2 | Vec3,
            rotation: trackValue(values.rotation, `${path}.values.rotation`, mode, "rotation") as number | Quaternion,
            size: trackValue(values.size, `${path}.values.size`, mode, "size") as Vec2 | Vec3,
            color: color(values.color, `${path}.values.color`),
            opacity: number(values.opacity, `${path}.values.opacity`, 0, 1),
        },
        content: kind === "group" ? { kind } : { kind, emitterId: id(content.emitterId, `${contentPath}.emitterId`) },
    };
}

////////////////////
// 発生方式と材質参照を読み込む
function readEmitter(value: unknown, path: string): Emitter {
    const emitter = record(value, path, ["id", "materialId", "lifetimeUs", "emission"]); // 発生器候補
    const emissionPath = `${path}.emission`; // 発生設定の位置
    const emission = record(emitter.emission, emissionPath, ["kind", "ratePerSecond", "count"]); // 発生設定候補
    const kind = choice(emission.kind, `${emissionPath}.kind`, ["continuous", "burst"]); // 発生方式
    if (Object.hasOwn(emission, kind === "continuous" ? "count" : "ratePerSecond")) {
        fail(emissionPath, "発生方式と設定が一致しません。");
    }
    return {
        id: id(emitter.id, `${path}.id`), materialId: id(emitter.materialId, `${path}.materialId`),
        lifetimeUs: integer(emitter.lifetimeUs, `${path}.lifetimeUs`, 1),
        emission: kind === "continuous"
            ? { kind, ratePerSecond: number(emission.ratePerSecond, `${emissionPath}.ratePerSecond`, 0) }
            : { kind, count: integer(emission.count, `${emissionPath}.count`, 1) },
    };
}

////////////////////
// 素材参照と基本的な描画設定を読み込む
function readMaterial(value: unknown, path: string): Material {
    const material = record(value, path, ["id", "textureAssetId", "blend", "color", "hasBloom", "gradient"]); // 材質候補
    return {
        id: id(material.id, `${path}.id`),
        textureAssetId: material.textureAssetId === null ? null : id(material.textureAssetId, `${path}.textureAssetId`),
        blend: choice(material.blend, `${path}.blend`, ["alpha", "additive"]),
        color: color(material.color, `${path}.color`),
        hasBloom: flag(material.hasBloom, `${path}.hasBloom`),
        gradient: list(material.gradient, `${path}.gradient`, (item, itemPath) => {
            const stop = record(item, itemPath, ["offset", "color"]); // グラデーションの色点
            return { offset: number(stop.offset, `${itemPath}.offset`, 0, 1), color: color(stop.color, `${itemPath}.color`) };
        }),
    };
}

////////////////////
// 素材本体を解決するためのメタデータを読み込む
function readAsset(value: unknown, path: string): Asset {
    const asset = record(value, path, ["id", "name", "mediaType", "width", "height"]); // 素材候補
    return {
        id: id(asset.id, `${path}.id`), name: name(asset.name, `${path}.name`),
        mediaType: choice(asset.mediaType, `${path}.mediaType`, ["image/png", "image/jpeg", "image/webp"]),
        width: integer(asset.width, `${path}.width`, 1), height: integer(asset.height, `${path}.height`, 1),
    };
}

////////////////////
// 型付きキー列を読み込み、時刻の昇順と一意性を検証する
function readTrack(value: unknown, path: string, mode: Mode): Track {
    const track = record(value, path, ["layerId", "property", "interpolation", "keys"]); // Track候補
    const property = choice(track.property, `${path}.property`, PROPERTIES); // 値型を決めるプロパティ
    let previous = -1; // 直前の相対時刻（µs）
    const keys = list(track.keys, `${path}.keys`, (item, itemPath) => {
        const key = record(item, itemPath, ["offsetUs", "value"]); // キー候補
        const offsetUs = integer(key.offsetUs, `${itemPath}.offsetUs`); // レイヤー開始からの時刻
        if (offsetUs <= previous) fail(`${itemPath}.offsetUs`, "キー時刻は重複なしの昇順にしてください。");
        previous = offsetUs;
        return { offsetUs, value: trackValue(key.value, `${itemPath}.value`, mode, property) };
    }); // 同じプロパティ型で検証済みのキー列
    return {
        layerId: id(track.layerId, `${path}.layerId`), property,
        interpolation: choice(track.interpolation, `${path}.interpolation`, ["step", "linear"]), keys,
    } as Track;
}

////////////////////
// 文書内のIDを種類付きで登録し、階層・参照・キーの範囲を検証する
function validateReferences(project: Project, path: string): void {
    const registry = new Map<string, EntityKind>(); // UUIDの照合表
    const layers = new Map<string, Layer>(); // レイヤーの親と時刻を引く表

    ////////////////////
    // UUIDは大文字小文字を区別せず、文書内で一意にする
    function register(value: string, kind: EntityKind, location: string): void {
        const key = value.toLowerCase(); // 参照と同じUUID比較キー
        if (registry.has(key)) fail(location, "文書内でIDが重複しています。");
        registry.set(key, kind);
    }

    ////////////////////
    // 同じ文書内に期待した種類の参照先があるか確認する
    function reference(value: string, kind: EntityKind, location: string): void {
        const actual = registry.get(value.toLowerCase()); // 参照先の種類
        if (actual !== kind) fail(location, actual ? "参照先の種類が不正です。" : "参照先が存在しません。");
    }

    register(project.id, "project", `${path}.id`);
    project.layers.forEach((layer, index) => {
        register(layer.id, "layer", `${path}.layers[${index}].id`);
        layers.set(layer.id.toLowerCase(), layer);
    });
    project.emitters.forEach((item, index) => register(item.id, "emitter", `${path}.emitters[${index}].id`));
    project.materials.forEach((item, index) => register(item.id, "material", `${path}.materials[${index}].id`));
    project.assets.forEach((item, index) => register(item.id, "asset", `${path}.assets[${index}].id`));

    project.layers.forEach((layer, index) => {
        const location = `${path}.layers[${index}]`; // 現在のレイヤーの位置
        if (layer.parentId !== null) reference(layer.parentId, "layer", `${location}.parentId`);
        if (layer.content.kind === "emitter") reference(layer.content.emitterId, "emitter", `${location}.content.emitterId`);
    });
    project.emitters.forEach((item, index) => reference(item.materialId, "material", `${path}.emitters[${index}].materialId`));
    project.materials.forEach((item, index) => {
        if (item.textureAssetId !== null) reference(item.textureAssetId, "asset", `${path}.materials[${index}].textureAssetId`);
    });

    const checked = new Set<string>(); // 親をたどって循環がないと確認したID
    project.layers.forEach((layer, index) => {
        const chain = new Set<string>(); // 今回たどった親子経路
        let current: string | undefined = layer.id.toLowerCase(); // 検証中のレイヤーID
        while (current !== undefined && !checked.has(current)) {
            if (chain.has(current)) fail(`${path}.layers[${index}].parentId`, "自己親または循環があります。");
            chain.add(current);
            current = layers.get(current)?.parentId?.toLowerCase();
        }
        for (const key of chain) checked.add(key);
    });

    const tracks = new Set<string>(); // レイヤーとプロパティの組
    project.tracks.forEach((track, index) => {
        const location = `${path}.tracks[${index}]`; // 現在のTrackの位置
        reference(track.layerId, "layer", `${location}.layerId`);
        const layer = layers.get(track.layerId.toLowerCase())!; // 参照済みのレイヤー
        const key = `${layer.id.toLowerCase()}:${track.property}`; // Trackの複合識別子
        if (tracks.has(key)) fail(location, "同じレイヤーとプロパティのTrackが重複しています。");
        tracks.add(key);
        const maxOffsetUs = project.durationUs - layer.startUs; // 加算であふれないよう差で求める許容範囲
        track.keys.forEach((item, keyIndex) => {
            if (item.offsetUs > maxOffsetUs) fail(`${location}.keys[${keyIndex}].offsetUs`, "キーが制作尺の範囲外です。");
        });
    });
}

////////////////////
// 外部入力を検証し、独立した編集文書を返す
export function validateProject(value: unknown, path = "project"): Project {
    const input = record(value, path, [...PROJECT_FIELDS, "drawing", "canvasWidth", "canvasHeight"]); // 文書候補
    if (input.schemaVersion !== DOCUMENT_SCHEMA_VERSION) fail(`${path}.schemaVersion`, "未対応のスキーマ版です。");
    const mode = choice(input.mode, `${path}.mode`, ["2d", "3d"]); // 文書の編集モード
    if (!isProductionFps(input.productionFps)) fail(`${path}.productionFps`, "制作FPSが不正です。");
    const durationUs = integer(input.durationUs, `${path}.durationUs`, 1); // 制作尺（µs）
    const common = {
        schemaVersion: DOCUMENT_SCHEMA_VERSION, mode, durationUs, productionFps: input.productionFps,
        id: id(input.id, `${path}.id`), name: name(input.name, `${path}.name`),
        layers: list(input.layers, `${path}.layers`, (item, location) => readLayer(item, location, mode, durationUs)),
        emitters: list(input.emitters, `${path}.emitters`, readEmitter),
        materials: list(input.materials, `${path}.materials`, readMaterial),
        tracks: list(input.tracks, `${path}.tracks`, (item, location) => readTrack(item, location, mode)),
        assets: list(input.assets, `${path}.assets`, readAsset),
    } as const; // 指定モードで読み込んだ共通項目
    if (mode === "3d" && ["drawing", "canvasWidth", "canvasHeight"].some((field) => Object.hasOwn(input, field))) {
        fail(path, "3D文書に2D描画設定は指定できません。");
    }
    // レイヤーとキーは共通のmodeを用いて読み込んだため、モードと値型は一致している。
    const project = (mode === "3d" ? common : {
        ...common,
        drawing: choice(input.drawing, `${path}.drawing`, ["normal", "pixel"]),
        canvasWidth: integer(input.canvasWidth, `${path}.canvasWidth`, 1),
        canvasHeight: integer(input.canvasHeight, `${path}.canvasHeight`, 1),
    }) as Project; // 構造を検証した文書
    validateReferences(project, path);
    return project;
}

////////////////////
// 独立したテンプレート文書を読み、必要素材の宣言が内部で解決できることを確認する
export function validatePreset(value: unknown): Preset {
    const input = record(value, "preset", ["schemaVersion", "id", "name", "template", "requiredAssetIds"]); // プリセット候補
    if (input.schemaVersion !== DOCUMENT_SCHEMA_VERSION) fail("preset.schemaVersion", "未対応のスキーマ版です。");
    const template = validateProject(input.template, "preset.template"); // 独立した参照スコープ
    const assets = new Set(template.assets.map((asset) => asset.id.toLowerCase())); // テンプレートの素材ID
    const declared = new Set<string>(); // すでに宣言した必要素材
    const requiredAssetIds = list(input.requiredAssetIds, "preset.requiredAssetIds", (item, path) => {
        const assetId = id(item, path); // 検証済みの素材参照
        const key = assetId.toLowerCase(); // UUID比較キー
        if (!assets.has(key)) fail(path, "テンプレート内に素材がありません。");
        if (declared.has(key)) fail(path, "必要素材が重複しています。");
        declared.add(key);
        return assetId;
    }); // 素材の解決に必要な宣言
    return { schemaVersion: DOCUMENT_SCHEMA_VERSION, id: id(input.id, "preset.id"),
        name: name(input.name, "preset.name"), template, requiredAssetIds };
}
