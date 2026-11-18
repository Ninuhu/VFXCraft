import type { Particle3D, Project, Vec3 } from "../document/model.ts";
import { evaluateTrack } from "../document/evaluateTrack.ts";
import { materialValuesAt, tracksFor } from "../document/animation.ts";
import { isNonNegativeSafeInteger, MICROS_PER_SECOND } from "../document/time.ts";
import { activeBirths } from "./animatedEmission.ts";
import { hierarchyAt, transformPosition } from "../document/hierarchy.ts";

export type Project3D = Extract<Project, { mode: "3d" }>;
export type ParticleSample3D = {
    readonly key: string;
    readonly position: Vec3;
    readonly width: number;
    readonly height: number;
    readonly color: Vec3;
    readonly opacity: number;
    readonly billboard: Particle3D["billboard"];
    readonly materialId: string; // 描画時に使う材質の参照
    readonly age: number; // 正規化した粒子寿命
    readonly materialOpacity?: number; // アニメーション時だけ基準値を上書き
    readonly bloomStrength?: number; // マテリアルを共有してもレイヤー固有に評価
    readonly basis2d?: { right: Vec3; up: Vec3 }; // 2D階層の描画用基底
};
export type Transform3D = (point: Vec3) => Vec3;

////////////////////
// 共通の階層行列を閉じ込め、粒子ごとの親探索を避ける
export function layerTransform3D(project: Project3D, layerId: string, timeUs: number): Transform3D {
    const matrix = hierarchyAt(project, layerId, timeUs).matrix; // 指定時刻のワールド変換
    return (point) => transformPosition(matrix, point);
}
////////////////////
// 方向を安全に単位化する。大きな有限成分でも二乗であふれさせない
function unitDirection(direction: Vec3): Vec3 {
    const scale = Math.max(...direction.map(Math.abs)); // オーバーフロー回避の基準
    const scaled = direction.map((value) => value / scale); // 縮小した方向
    const length = Math.hypot(...scaled); // 縮小後の長さ
    return [scaled[0]! / length, scaled[1]! / length, scaled[2]! / length];
}

////////////////////
// 指定時刻の生存粒子を解析的に計算する。点発生では乱数を消費しない
export function evaluateParticles3D(project: Project3D, timeUs: number): ParticleSample3D[] {
    if (!isNonNegativeSafeInteger(timeUs)) throw new RangeError("評価時刻が不正です。");
    const output: ParticleSample3D[] = []; // 全発生器をまたぐ粒子集合
    for (const layer of project.layers) {
        if (layer.content.kind !== "emitter" || timeUs < layer.startUs || !hierarchyAt(project, layer.id, timeUs).visible) continue;
        const emitterId = layer.content.emitterId; // 参照する発生器
        const emitter = project.emitters.find((entry) => entry.id.toLowerCase() === emitterId.toLowerCase())!; // 検証済みモデル
        const settings = emitter.particle3d; // 3D固有設定
        if (!settings) throw new Error("検証済みの3D設定が必要です。");
        const elapsed = timeUs - layer.startUs; // 発生開始からの時刻
        const tracks = tracksFor(project, layer.id); // 発生時と現在時のトラック
        const baseDirection = unitDirection(settings.direction); // キーがない場合とゼロ方向の代替
        const current = layerTransform3D(project, layer.id, timeUs); // ローカル空間の共通変換
        const material = project.materials.find((entry) => entry.id.toLowerCase() === emitter.materialId.toLowerCase())!; // 基本色と透明度の描画用
        const layerValues = hierarchyAt(project, layer.id, timeUs); // 現在時刻の色と透明度
        const appearance = materialValuesAt(project, layer, material, timeUs); // 現在時刻の材質
        for (const { index, birth, age, lifetime } of activeBirths(emitter, layer, elapsed, tracks)) {
            if (output.length >= 200_000) throw new RangeError("全体の粒子数が安全上限を超えています。");
            const offset = Math.round(birth); // キー評価は発生時の整数µs
            const directionTrack = tracks?.get("direction"); // 発生方向の指定
            const vector = evaluateTrack(directionTrack, offset, settings.direction) as Vec3;
            const direction = directionTrack && vector.some((component) => component !== 0) ? unitDirection(vector) : baseDirection;
            const speed = evaluateTrack(tracks?.get("speed"), offset, settings.speed) as number;
            const acceleration = evaluateTrack(tracks?.get("acceleration"), offset, settings.acceleration) as Vec3;
            const size = evaluateTrack(tracks?.get("particleSize"), offset, 1) as number;
            const seconds = age / MICROS_PER_SECOND; // 運動式の秒
            const local: Vec3 = [0, 1, 2].map((axis) => direction[axis]! * speed * seconds
                + 0.5 * acceleration[axis]! * seconds * seconds) as unknown as Vec3; // 発生時の一定加速度
            const transform = settings.space === "world"
                ? layerTransform3D(project, layer.id, Math.round(layer.startUs + birth)) : current; // 発生時または現在の基底
            const origin = transform([0, 0, 0]); // 寸法計算用の原点
            const axisX = transform([1, 0, 0]), axisY = transform([0, 1, 0]); // 親回転・非一様スケールを含む軸
            const width = size * 0.2 * Math.hypot(...axisX.map((value, axis) => value - origin[axis]!)); // 板の幅
            const height = size * 0.2 * Math.hypot(...axisY.map((value, axis) => value - origin[axis]!)); // 板の高さ
            if (![width, height].every(Number.isFinite)) throw new RangeError("粒子の寸法が不正です。");
            output.push({ key: layer.id.toLowerCase() + ":" + index, position: transform(local), width, height,
                color: [appearance.color[0] * layerValues.color[0], appearance.color[1] * layerValues.color[1],
                    appearance.color[2] * layerValues.color[2]], opacity: layerValues.opacity,
                billboard: settings.billboard, materialId: material.id, age: age / lifetime,
                ...(appearance.opacity === undefined ? {} : { materialOpacity: appearance.opacity }),
                ...(appearance.bloom === undefined ? {} : { bloomStrength: appearance.bloom }) });
        }
    }
    return output;
}
