import type { Material, Project } from "../core/document/model.ts";
import { evaluateGradient, multiplyRgba } from "../core/materials/materialEvaluation.ts";
import { evaluateParticles2D } from "../core/particles/evaluate2D.ts";
import { evaluateParticles3D, type ParticleSample3D } from "../core/particles/evaluate3D.ts";
import type { CameraBasis } from "./particleDrawData3D.ts";

export const SCREEN_BASIS: CameraBasis = { position: [0, 0, 1], forward: [0, 0, -1], right: [1, 0, 0], up: [0, -1, 0] }; // 左上原点の画面基底
const MAX_PREVIEW_PARTICLES = 200_000; // T06と同じ全体の描画安全上限

////////////////////
// シミュレーションは既存APIを使い、2Dの順序と3Dの寿命情報を保って描画用に変換する
export function collectMaterialParticles(project: Project, timeUs: number): ParticleSample3D[] {
    if (project.mode === "3d") return evaluateParticles3D(project, timeUs);
    const emitters = new Map(project.emitters.map((item) => [item.id.toLowerCase(), item])); // 発生器の参照表
    const materials = new Map(project.materials.map((item) => [item.id.toLowerCase(), item])); // 材質の参照表
    const output: ParticleSample3D[] = []; // レイヤー順の粒子列
    for (const layer of [...project.layers].sort((a, b) => a.order - b.order)) {
        if (!layer.isVisible || layer.content.kind !== "emitter") continue;
        const emitter = emitters.get(layer.content.emitterId.toLowerCase())!; // 検証済み参照
        const material = materials.get(emitter.materialId.toLowerCase())!; // 検証済み参照
        const size = material.textureAssetId ? 8 : 6; // T05の論理ピクセル径
        const [scaleX, scaleY] = material.appearance ? layer.values.size : [1, 1]; // 新しい材質ではレイヤーの寸法を反映
        const color = material.appearance ? material.color.map((value, axis) => value * layer.values.color[axis]!) : [1, 1, 1]; // 旧2Dは白で描画
        const samples = evaluateParticles2D(project, layer.id, timeUs); // 既存の決定的な評価結果
        if (output.length + samples.length > MAX_PREVIEW_PARTICLES) throw new RangeError("全体の粒子数が安全上限を超えています。");
        for (const sample of samples) {
            output.push({ key: layer.id + ":" + sample.id, position: [...sample.position, 0],
                width: size * scaleX, height: size * scaleY, billboard: "camera", color: [color[0]!, color[1]!, color[2]!],
                opacity: layer.values.opacity, materialId: material.id, age: sample.age });
        }
    }
    return output;
}

////////////////////
// 順序を保ったまま寿命方向の色と透明度を頂点値へ反映する
export function tintMaterialParticles(samples: readonly ParticleSample3D[], materials: ReadonlyMap<string, Material>): ParticleSample3D[] {
    return samples.map((sample) => {
        const appearance = materials.get(sample.materialId.toLowerCase())!.appearance; // 発生器が使用する材質
        if (!appearance) return sample;
        const rgba = multiplyRgba([...sample.color, sample.opacity * appearance.opacity],
            evaluateGradient(appearance.lifetime, sample.age)); // 空間方向とテクスチャはピクセル単位で合成する
        return { ...sample, color: [rgba[0], rgba[1], rgba[2]], opacity: rgba[3] };
    });
}
