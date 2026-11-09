import type { Emitter, Layer, LayerValues, Material, Mode, Project, Track, TrackProperty, TrackValue } from "./model.ts";
import { evaluateTrack } from "./evaluateTrack.ts";

const indices = new WeakMap<Project, Map<string, Map<TrackProperty, Track>>>(); // 不変の文書ごとの索引

////////////////////
// レイヤーと項目でキーを引き、粒子ごとに文書全体を走査しない
export function tracksFor(project: Project, layerId: string): ReadonlyMap<TrackProperty, Track> | undefined {
    let index = indices.get(project); // 文書が置き換わったときだけ構築する
    if (!index) {
        index = new Map();
        for (const track of project.tracks) {
            const id = track.layerId.toLowerCase(); // UUIDの照合キー
            let layer = index.get(id); // 一つのレイヤーのトラック
            if (!layer) { layer = new Map(); index.set(id, layer); }
            layer.set(track.property, track);
        }
        indices.set(project, index);
    }
    return index.get(layerId.toLowerCase());
}

////////////////////
// 保存済みの基本値を、タイムライン編集と評価で共有する
export function baseTrackValue(layer: Layer, emitter: Emitter | undefined, material: Material | undefined,
    property: TrackProperty): TrackValue | undefined {
    const settings = emitter?.particle2d ?? emitter?.particle3d; // 編集モード固有の運動
    switch (property) {
        case "rate": return emitter?.emission.kind === "continuous" ? emitter.emission.ratePerSecond : undefined;
        case "lifetimeUs": return emitter?.lifetimeUs;
        case "speed": return settings?.speed;
        case "direction": return settings && ("direction" in settings ? settings.direction : settings.directionDegrees);
        case "acceleration": return settings?.acceleration;
        case "particleSize": return emitter ? 1 : undefined;
        case "materialColor": return material?.color;
        case "materialOpacity": return material ? material.appearance?.opacity ?? 1 : undefined;
        case "bloomStrength": return material ? material.appearance?.bloomStrength ?? 0 : undefined;
        default: return layer.values[property];
    }
}

////////////////////
// 現在時刻のレイヤー変換と色を取得する。開始前の親は基準値を維持する
export function layerValuesAt<M extends Mode>(project: Project, layer: Layer<M>, timeUs: number): Readonly<LayerValues<M>> {
    const tracks = tracksFor(project, layer.id); // レイヤー固有の索引
    if (!tracks || timeUs < layer.startUs) return layer.values;
    const offset = timeUs - layer.startUs; // レイヤー相対時間
    const values = { ...layer.values }; // モード別の値を保つ
    for (const property of ["position", "rotation", "size", "color", "opacity"] as const) {
        Object.assign(values, { [property]: evaluateTrack(tracks.get(property), offset, layer.values[property]) });
    }
    return values;
}

////////////////////
// 画面に作用する材質値を現在時刻で評価する。発生時の運動値とは独立する
export function materialValuesAt(project: Project, layer: Layer, material: Material, timeUs: number) {
    const tracks = tracksFor(project, layer.id); // レイヤーごとに共有材質へ適用する値
    const offset = timeUs - layer.startUs; // レイヤー相対時間
    return {
        color: evaluateTrack(tracks?.get("materialColor"), offset, material.color) as Material["color"],
        opacity: tracks?.has("materialOpacity")
            ? evaluateTrack(tracks.get("materialOpacity"), offset, material.appearance?.opacity ?? 1) as number : undefined,
        bloom: tracks?.has("bloomStrength")
            ? evaluateTrack(tracks.get("bloomStrength"), offset, material.appearance?.bloomStrength ?? 0) as number : undefined,
    };
}
