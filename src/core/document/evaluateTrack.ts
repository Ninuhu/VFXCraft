import type { Layer, Mode, Quaternion, Track, TrackValue, Vec2, Vec3 } from "./model.ts";
import { slerpQuaternion } from "./rotation.ts";
import { isNonNegativeSafeInteger } from "./time.ts";

////////////////////
// スカラーまたは同じ次元のベクトルを補間する
function interpolate(from: TrackValue, to: TrackValue, amount: number): TrackValue {
    if (typeof from === "number" && typeof to === "number") {
        return from * (1 - amount) + to * amount;
    }
    if (typeof from !== "number" && typeof to !== "number") {
        if (from.length === 4 && to.length === 4) return slerpQuaternion(from, to, amount);
        if (from.length === 2 && to.length === 2) return blendVector2(from, to, amount);
        if (from.length === 3 && to.length === 3) {
            const xy = blendVector2([from[0], from[1]], [to[0], to[1]], amount); // 補間したXY成分
            return [...xy, from[2] * (1 - amount) + to[2] * amount] satisfies Vec3;
        }
    }
    throw new RangeError("キーの値型が一致しません。");
}

////////////////////
// 二成分を線形補間する
function blendVector2(from: Vec2, to: Vec2, amount: number): Vec2 {
    return [from[0] * (1 - amount) + to[0] * amount, from[1] * (1 - amount) + to[1] * amount];
}

////////////////////
// 検証済みのTrackをプロジェクト時刻で評価し、開始前は非アクティブを返す
export function evaluateLayerTrack<M extends Mode>(
    layer: Layer<M>, track: Track<M>, timeUs: number,
): number | Vec2 | Vec3 | Quaternion | undefined {
    if (!isNonNegativeSafeInteger(timeUs)) throw new RangeError("評価時刻が不正です。");
    if (track.layerId.toLowerCase() !== layer.id.toLowerCase()) throw new RangeError("Trackの対象レイヤーが一致しません。");
    if (timeUs < layer.startUs) return undefined;

    const offset = timeUs - layer.startUs; // レイヤー開始からの相対時間（µs）
    const first = track.keys[0]; // 最初のキー
    if (!first || offset < first.offsetUs) return layer.values[track.property];

    let previous = first; // 評価時刻以前にある直近のキー
    for (let index = 1; index < track.keys.length; index++) {
        const next = track.keys[index]!; // 評価区間の終端候補
        if (offset < next.offsetUs) {
            if (track.interpolation === "step" || offset === previous.offsetUs) return previous.value;
            const amount = (offset - previous.offsetUs) / (next.offsetUs - previous.offsetUs); // 区間の進行率
            return interpolate(previous.value, next.value, amount);
        }
        previous = next;
    }
    return previous.value;
}
