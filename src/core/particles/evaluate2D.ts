import type { Project, Vec2 } from "../document/model.ts";
import { activeBirths } from "./animatedEmission.ts";
import { layerValuesAt, tracksFor } from "../document/animation.ts";
import { evaluateTrack } from "../document/evaluateTrack.ts";
import { isNonNegativeSafeInteger, MICROS_PER_SECOND } from "../document/time.ts";

export type Project2D = Extract<Project, { mode: "2d" }>;
export type Matrix2D = readonly [number, number, number, number, number, number];
export type ParticleSample = { readonly id: number; readonly position: Vec2; readonly age: number; readonly size?: number };
export type TransformAt = (timeUs: number) => Matrix2D;
const IDENTITY: Matrix2D = [1, 0, 0, 1, 0, 0]; // 親のない座標の単位行列


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
        const values = layerValuesAt(project, item, timeUs); // 指定時刻の変換
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
    const tracks = tracksFor(project, layer.id); // 発生時に使うトラック
    const current = settings.space === "local" ? transformAt(timeUs) : IDENTITY; // ローカル粒子だけ現在の変換に追従
    const samples: ParticleSample[] = []; // 同じ時刻では同じ配列内容を返す
    for (const { index, birth: birthUs, age: ageUs, lifetime } of activeBirths(emitter, layer, elapsed, tracks)) {
        const offset = Math.round(birthUs); // キー評価は発生時の整数µs
        const radians = (evaluateTrack(tracks?.get("direction"), offset, settings.directionDegrees) as number) * Math.PI / 180;
        const speed = evaluateTrack(tracks?.get("speed"), offset, settings.speed) as number;
        const acceleration = evaluateTrack(tracks?.get("acceleration"), offset, settings.acceleration) as Vec2;
        const velocity: Vec2 = [Math.cos(radians) * speed, Math.sin(radians) * speed]; // 発生時の初速
        const u = random(settings.seed, index, 1), v = random(settings.seed, index, 2); // 形状内の一様サンプル
        let origin: Vec2 = [0, 0]; // 点発生の初期座標
        if (settings.shape.kind === "circle") {
            const radius = Math.sqrt(u)*settings.shape.radius; // 円の面積に対して一様にする
            origin = [Math.cos(v*Math.PI*2)*radius, Math.sin(v*Math.PI*2)*radius];
        } else if (settings.shape.kind === "rectangle") {
            origin = [(u-0.5)*settings.shape.width, (v-0.5)*settings.shape.height];
        }
        const seconds = ageUs / MICROS_PER_SECOND; // 運動式の秒単位
        const local: Vec2 = [origin[0]+velocity[0]*seconds+0.5*acceleration[0]*seconds**2,
            origin[1]+velocity[1]*seconds+0.5*acceleration[1]*seconds**2]; // 発生時に固定した加速度の解析解
        const position = transformPoint(settings.space === "world" ? transformAt(Math.round(layer.startUs+birthUs)) : current, local); // 発生時の基底か現在基底
        if (!position.every(Number.isFinite)) throw new RangeError("粒子座標が数値範囲を超えました。");
        const size = tracks?.get("particleSize"); // 粒子自身の倍率
        samples.push({ id: index, position, age: ageUs / lifetime,
            ...(size ? { size: evaluateTrack(size, offset, 1) as number } : {}) });
    }
    return samples;
}
