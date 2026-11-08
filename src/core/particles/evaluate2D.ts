import type { LayerValues, Project, Vec2 } from "../document/model.ts";
import { evaluateLayerTrack } from "../document/evaluateTrack.ts";
import { isNonNegativeSafeInteger, MICROS_PER_SECOND } from "../document/time.ts";

export type Project2D = Extract<Project, { mode: "2d" }>;
export type Matrix2D = readonly [number, number, number, number, number, number];
export type ParticleSample = { readonly id: number; readonly position: Vec2; readonly age: number };
export type TransformAt = (timeUs: number) => Matrix2D;
const IDENTITY: Matrix2D = [1, 0, 0, 1, 0, 0]; // 親のない座標の単位行列
const MAX_EVALUATED_PARTICLES = 200_000; // 応答停止を避ける評価時の防御上限

////////////////////
// 座標を2Dアフィン行列で変換する
export function transformPoint(matrix: Matrix2D, point: Vec2): Vec2 {
    return [matrix[0] * point[0] + matrix[2] * point[1] + matrix[4],
        matrix[1] * point[0] + matrix[3] * point[1] + matrix[5]];
}

////////////////////
// 親ローカルの変換をワールド座標へ合成する
function multiply(a: Matrix2D, b: Matrix2D): Matrix2D {
    return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
        a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
        a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
}

////////////////////
// 時間評価済みの位置・回転・サイズから親を含む変換を求める
export function layerTransform(project: Project2D, layerId: string, timeUs: number): Matrix2D {
    const chain = []; // 子から親へたどるレイヤー
    let layer = project.layers.find((item) => item.id.toLowerCase() === layerId.toLowerCase()); // 評価対象
    if (!layer) throw new Error("レイヤーが存在しません。");
    while (layer) {
        chain.push(layer);
        layer = layer.parentId === null ? undefined
            : project.layers.find((item) => item.id.toLowerCase() === layer!.parentId!.toLowerCase());
    }
    let result = IDENTITY; // ワールド変換
    for (const item of chain.reverse()) {
        const values: LayerValues<"2d"> = { ...item.values }; // 基準値から開始する変換
        for (const track of project.tracks.filter((entry) => entry.layerId.toLowerCase() === item.id.toLowerCase())) {
            const value = evaluateLayerTrack(item, track, timeUs); // 指定時刻のアニメーション
            if (value !== undefined) Object.assign(values, { [track.property]: value });
        }
        const angle = values.rotation * Math.PI / 180; // 時計回りの度数をラジアンへ変換
        const cosine = Math.cos(angle), sine = Math.sin(angle); // 正のYが下を向く画面の基底
        result = multiply(result, [cosine*values.size[0], sine*values.size[0], -sine*values.size[1],
            cosine*values.size[1], values.position[0], values.position[1]]);
    }
    return result;
}

////////////////////
// 粒子番号とシードから独立した乱数を作り、シーク順の影響を除く
function random(seed: number, index: number, channel: number): number {
    let value = (seed ^ Math.imul(index >>> 0, 0x9e3779b9) ^ Math.imul(Math.floor(index / 2 ** 32), 0x85ebca6b) ^ channel) >>> 0; // 粒子固有キー
    value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
    value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
    return ((value ^ (value >>> 15)) >>> 0) / 2 ** 32;
}

////////////////////
// 有効な文書を絶対時刻から評価し、再生やシークで状態を蓄積しない
export function evaluateParticles2D(project: Project2D, layerId: string, timeUs: number,
    transformAt: TransformAt = (time) => layerTransform(project, layerId, time)): ParticleSample[] {
    if (!isNonNegativeSafeInteger(timeUs)) throw new RangeError("評価時刻が不正です。");
    const layer = project.layers.find((item) => item.id.toLowerCase() === layerId.toLowerCase()); // 粒子レイヤー
    if (!layer || layer.content.kind !== "emitter") return [];
    const emitterId = layer.content.emitterId; // コンテンツの参照
    const emitter = project.emitters.find((item) => item.id.toLowerCase() === emitterId.toLowerCase()); // 発生設定
    if (!emitter?.particle2d) throw new Error("検証済みの2D設定が必要です。");
    const elapsed = timeUs - layer.startUs; // レイヤー開始からの時刻
    if (elapsed < 0) return [];
    const settings = emitter.particle2d; // 2D運動と発生空間
    const rate = emitter.emission.kind === "continuous" ? emitter.emission.ratePerSecond : 0; // 秒あたりの発生数
    if (emitter.emission.kind === "continuous" && rate === 0) return [];
    const first = emitter.emission.kind === "burst" ? 0 : Math.max(0, Math.floor((elapsed - emitter.lifetimeUs) / MICROS_PER_SECOND * rate) + 1); // 寿命境界は除外
    const last = emitter.emission.kind === "burst" ? emitter.emission.count - 1 : Math.floor(elapsed / MICROS_PER_SECOND * rate); // 時刻0の粒子を含む
    if (!Number.isSafeInteger(last) || !Number.isSafeInteger(first) || last-first+1 > MAX_EVALUATED_PARTICLES) {
        throw new RangeError("粒子数が検証用の安全上限を超えています。");
    }
    const current = settings.space === "local" ? transformAt(timeUs) : IDENTITY; // ローカル粒子だけ現在の変換に追従
    const radians = settings.directionDegrees * Math.PI / 180; // X正方向が0度、時計回り
    const velocity: Vec2 = [Math.cos(radians)*settings.speed, Math.sin(radians)*settings.speed]; // 初速
    const samples: ParticleSample[] = []; // 同じ時刻では同じ配列内容を返す
    for (let index = first; index <= last; index++) {
        const birthUs = emitter.emission.kind === "burst" ? 0 : index / rate * MICROS_PER_SECOND; // 絶対番号から算出
        const ageUs = elapsed - birthUs; // 粒子寿命内の時刻
        if (ageUs < 0 || ageUs >= emitter.lifetimeUs) continue;
        const u = random(settings.seed, index, 1), v = random(settings.seed, index, 2); // 形状内の一様サンプル
        let origin: Vec2 = [0, 0]; // 点発生の初期座標
        if (settings.shape.kind === "circle") {
            const radius = Math.sqrt(u)*settings.shape.radius; // 円の面積に対して一様にする
            origin = [Math.cos(v*Math.PI*2)*radius, Math.sin(v*Math.PI*2)*radius];
        } else if (settings.shape.kind === "rectangle") {
            origin = [(u-0.5)*settings.shape.width, (v-0.5)*settings.shape.height];
        }
        const seconds = ageUs / MICROS_PER_SECOND; // 運動式の秒単位
        const local: Vec2 = [origin[0]+velocity[0]*seconds+0.5*settings.acceleration[0]*seconds**2,
            origin[1]+velocity[1]*seconds+0.5*settings.acceleration[1]*seconds**2]; // 一定加速度の解析解
        const position = transformPoint(settings.space === "world" ? transformAt(Math.round(layer.startUs+birthUs)) : current, local); // 発生時の基底か現在基底
        if (!position.every(Number.isFinite)) throw new RangeError("粒子座標が数値範囲を超えました。");
        samples.push({ id: index, position, age: ageUs / emitter.lifetimeUs });
    }
    return samples;
}
