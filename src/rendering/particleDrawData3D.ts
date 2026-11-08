import type { Vec3 } from "../core/document/model.ts";
import type { ParticleSample3D } from "../core/particles/evaluate3D.ts";

export type CameraBasis = { readonly position: Vec3; readonly forward: Vec3; readonly right: Vec3; readonly up: Vec3 };
const POLE_EPSILON = 1e-10; // 真上・真下で方向が一意にならない範囲

////////////////////
// 全レイヤーを横断して視線方向の深度を降順に並べ、同深度は識別子で安定化する
export function sortParticles3D(samples: readonly ParticleSample3D[], camera: CameraBasis): ParticleSample3D[] {
    const depths = samples.map((sample) => {
        const depth = sample.position.reduce((value, component, axis) =>
            value + (component - camera.position[axis]!) * camera.forward[axis]!, 0); // カメラ空間の前方距離
        if (!Number.isFinite(depth)) throw new RangeError("深度が不正です。");
        return { sample, depth };
    }); // ソート中の深度再計算を避ける
    depths.sort((a, b) => b.depth - a.depth || (a.sample.key < b.sample.key ? -1 : a.sample.key > b.sample.key ? 1 : 0));
    return depths.map((item) => item.sample);
}

////////////////////
// ビルボードの幅・高さ方向をワールド空間で求める
export function billboardBasis(sample: ParticleSample3D, camera: CameraBasis): { right: Vec3; up: Vec3 } {
    if (sample.billboard === "camera") return { right: camera.right, up: camera.up };
    const dx = camera.position[0] - sample.position[0], dz = camera.position[2] - sample.position[2]; // 水平視線
    const length = Math.hypot(dx, dz); // 極付近の退化を検出
    if (length > POLE_EPSILON) return { right: [dz / length, 0, -dx / length], up: [0, 1, 0] };
    const fallback = Math.hypot(camera.right[0], camera.right[2]); // カメラの水平右方向
    return { right: fallback > POLE_EPSILON ? [camera.right[0] / fallback, 0, camera.right[2] / fallback] : [1, 0, 0],
        up: [0, 1, 0] };
}

const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]] as const; // 二つの三角形の頂点

////////////////////
// 深度順の粒子を再利用バッファへ詰め、GPUに渡す前に有限性を確認する
export function fillParticleVertices(samples: readonly ParticleSample3D[], camera: CameraBasis,
    positions: Float32Array, colors: Float32Array): void {
    if (positions.length < samples.length * 18 || colors.length < samples.length * 24) throw new Error("描画バッファが不足しています。");
    for (let index = 0; index < samples.length; index++) {
        const sample = samples[index]!; // 描画する粒子
        const basis = billboardBasis(sample, camera); // 向きの基底
        for (let vertex = 0; vertex < CORNERS.length; vertex++) {
            const [x, y] = CORNERS[vertex]!; // 板の角
            for (let axis = 0; axis < 3; axis++) {
                const value = sample.position[axis]! + basis.right[axis]! * x * sample.width / 2 + basis.up[axis]! * y * sample.height / 2; // ワールド頂点
                if (!Number.isFinite(value) || Math.abs(value) > 3e37) throw new RangeError("頂点がGPU数値範囲を超えています。");
                positions[index * 18 + vertex * 3 + axis] = value;
                colors[index * 24 + vertex * 4 + axis] = sample.color[axis]!;
            }
            colors[index * 24 + vertex * 4 + 3] = sample.opacity;
        }
    }
}
