import type { Layer, LayerValues, Particle3D, Project, Vec3 } from "../document/model.ts";
import { evaluateLayerTrack } from "../document/evaluateTrack.ts";
import { isNonNegativeSafeInteger, MICROS_PER_SECOND } from "../document/time.ts";
import { emissionWindow } from "./emission.ts";

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
};
export type Transform3D = (point: Vec3) => Vec3;

////////////////////
// 正規化済みQuaternionでベクトルを回転する
function applyValues(point: Vec3, values: LayerValues<"3d">): Vec3 {
    const [qx, qy, qz, qw] = values.rotation; // 姿勢
    const x = point[0] * values.size[0], y = point[1] * values.size[1], z = point[2] * values.size[2]; // 拡大した座標
    const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x); // 回転の外積
    return [x + qw * tx + qy * tz - qz * ty + values.position[0],
        y + qw * ty + qz * tx - qx * tz + values.position[1],
        z + qw * tz + qx * ty - qy * tx + values.position[2]];
}

////////////////////
// 子から親へ変換する評価済み関数を作り、各粒子の変換でモデルを再検索しない
export function layerTransform3D(project: Project3D, layerId: string, timeUs: number): Transform3D {
    const chain: LayerValues<"3d">[] = []; // 子から親の順の変換
    let layer: Layer<"3d"> | undefined = project.layers.find((entry) => entry.id.toLowerCase() === layerId.toLowerCase()); // 対象
    if (!layer) throw new Error("レイヤーが存在しません。");
    while (layer) {
        const current: Layer<"3d"> = layer; // 型の絞り込みを維持する
        const values: LayerValues<"3d"> = { ...current.values }; // 基準値
        for (const track of project.tracks.filter((item) => item.layerId.toLowerCase() === current.id.toLowerCase())) {
            const value = evaluateLayerTrack(current, track, timeUs); // 保存されたキーの評価
            if (value !== undefined) Object.assign(values, { [track.property]: value });
        }
        chain.push(values);
        layer = current.parentId === null ? undefined
            : project.layers.find((item) => item.id.toLowerCase() === current.parentId!.toLowerCase());
    }
    return (point) => {
        let result = point; // ワールドへ向けて合成する座標
        for (const values of chain) result = applyValues(result, values);
        if (!result.every(Number.isFinite)) throw new RangeError("変換結果が有限数ではありません。");
        return result;
    };
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
        if (!layer.isVisible || layer.content.kind !== "emitter" || timeUs < layer.startUs) continue;
        const emitterId = layer.content.emitterId; // 参照する発生器
        const emitter = project.emitters.find((entry) => entry.id.toLowerCase() === emitterId.toLowerCase())!; // 検証済みモデル
        const settings = emitter.particle3d; // 3D固有設定
        if (!settings) throw new Error("検証済みの3D設定が必要です。");
        const elapsed = timeUs - layer.startUs; // 発生開始からの時刻
        const { first, last, rate } = emissionWindow(emitter, elapsed); // 2Dと共有した発生境界
        if (output.length + Math.max(0, last - first + 1) > 200_000) throw new RangeError("全体の粒子数が安全上限を超えています。");
        const direction = unitDirection(settings.direction); // 初速の単位方向
        const current = layerTransform3D(project, layer.id, timeUs); // ローカル空間の共通変換
        const material = project.materials.find((entry) => entry.id.toLowerCase() === emitter.materialId.toLowerCase())!; // 基本色と透明度の描画用
        for (let index = first; index <= last; index++) {
            const birth = emitter.emission.kind === "burst" ? 0 : index / rate * MICROS_PER_SECOND; // 絶対番号から得る発生時刻
            const age = elapsed - birth; // 粒子の経過時間
            if (age < 0 || age >= emitter.lifetimeUs) continue;
            const seconds = age / MICROS_PER_SECOND; // 運動式の秒
            const local: Vec3 = [0, 1, 2].map((axis) => direction[axis]! * settings.speed * seconds
                + 0.5 * settings.acceleration[axis]! * seconds * seconds) as unknown as Vec3; // 一定加速度の解析解
            const transform = settings.space === "world"
                ? layerTransform3D(project, layer.id, Math.round(layer.startUs + birth)) : current; // 発生時または現在の基底
            const origin = transform([0, 0, 0]); // 寸法計算用の原点
            const axisX = transform([1, 0, 0]), axisY = transform([0, 1, 0]); // 親回転・非一様スケールを含む軸
            const width = 0.2 * Math.hypot(...axisX.map((value, axis) => value - origin[axis]!)); // 板の幅
            const height = 0.2 * Math.hypot(...axisY.map((value, axis) => value - origin[axis]!)); // 板の高さ
            if (![width, height].every(Number.isFinite)) throw new RangeError("粒子の寸法が不正です。");
            output.push({ key: layer.id.toLowerCase() + ":" + index, position: transform(local), width, height,
                color: [material.color[0] * layer.values.color[0], material.color[1] * layer.values.color[1],
                    material.color[2] * layer.values.color[2]], opacity: layer.values.opacity,
                billboard: settings.billboard, materialId: material.id, age: age / emitter.lifetimeUs });
        }
    }
    return output;
}
