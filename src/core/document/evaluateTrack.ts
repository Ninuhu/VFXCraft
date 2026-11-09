import type { Layer, LayerProperty, Mode, Track, TrackValue, Vec2, Vec3 } from "./model.ts";
import { slerpQuaternion } from "./rotation.ts";
import { isNonNegativeSafeInteger } from "./time.ts";

////////////////////
// スカラー・ベクトルは成分補間、3D姿勢は最短経路SLERPを使う
function interpolate(from: TrackValue, to: TrackValue, amount: number): TrackValue {
    if (typeof from === "number" && typeof to === "number") return from * (1 - amount) + to * amount;
    if (typeof from !== "number" && typeof to !== "number") {
        if (from.length === 4 && to.length === 4) return slerpQuaternion(from, to, amount);
        if (from.length === to.length) return from.map((component, index) =>
            component * (1 - amount) + to[index]! * amount) as unknown as Vec2 | Vec3;
    }
    throw new RangeError("キーの値型が一致しません。");
}

////////////////////
// 最後のoffset以下のキーを二分探索し、左キーが所有する区間を評価する
export function evaluateTrack(track: Track | undefined, offsetUs: number, base: TrackValue): TrackValue {
    const first = track?.keys[0]; // 新規トラックの開始側の保持値
    if (!track || !first) return base;
    if (offsetUs < first.offsetUs) return track.beforeFirst === "base" ? base : first.value;
    let low = 0, high = track.keys.length; // 直後のキーの探索範囲
    while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2); // 昇順キーの中央
        if (track.keys[middle]!.offsetUs <= offsetUs) low = middle; else high = middle;
    }
    const left = track.keys[low]!, right = track.keys[high]; // 区間の両端
    if (!right || offsetUs === left.offsetUs || (left.interpolation ?? track.interpolation) === "step") return left.value;
    return interpolate(left.value, right.value, (offsetUs - left.offsetUs) / (right.offsetUs - left.offsetUs));
}

////////////////////
// 既存のレイヤートラック評価APIを維持する
export function evaluateLayerTrack<M extends Mode>(layer: Layer<M>, track: Track<M>, timeUs: number): TrackValue | undefined {
    if (!isNonNegativeSafeInteger(timeUs)) throw new RangeError("評価時刻が不正です。");
    if (track.layerId.toLowerCase() !== layer.id.toLowerCase()) throw new RangeError("Trackの対象レイヤーが一致しません。");
    if (timeUs < layer.startUs) return undefined;
    const base = layer.values[track.property as LayerProperty]; // このAPIはレイヤー基準値を持つ対象用
    return base === undefined ? undefined : evaluateTrack(track, timeUs - layer.startUs, base);
}
