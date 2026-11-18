import type { Material, Project } from "../core/document/model.ts";
import { evaluateGradient, multiplyRgba } from "../core/materials/materialEvaluation.ts";
import { layerValuesAt, materialValuesAt, tracksFor } from "../core/document/animation.ts";
import { hierarchyAt } from "../core/document/hierarchy.ts";
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
        if (layer.content.kind !== "emitter") continue;
        const inherited = hierarchyAt(project, layer.id, timeUs); // 現在時刻の表示と外観の継承
        if (!inherited.visible) continue;
        const emitter = emitters.get(layer.content.emitterId.toLowerCase())!; // 検証済み参照
        const material = materials.get(emitter.materialId.toLowerCase())!; // 検証済み参照
        const size = material.textureAssetId ? 8 : 6; // T05の論理ピクセル径
        const values = layerValuesAt(project, layer, timeUs); // 現在時刻のレイヤー値
        const appearance = materialValuesAt(project, layer, material, timeUs); // 現在時刻の材質値
        const tracks = tracksFor(project, layer.id); // 旧2Dの静的な見た目を判断する
        const [scaleX, scaleY] = material.appearance || tracks?.has("size") ? values.size : [1, 1];
        const color = material.appearance || tracks?.has("color") || tracks?.has("materialColor") || layer.parentId !== null
            ? appearance.color.map((value, axis) => value * inherited.color[axis]!) : [1, 1, 1]; // 旧2Dのルートの既定は白
        const samples = evaluateParticles2D(project, layer.id, timeUs); // 既存の決定的な評価結果
        if (output.length + samples.length > MAX_PREVIEW_PARTICLES) throw new RangeError("全体の粒子数が安全上限を超えています。");
        for (const sample of samples) {
            const matrix = sample.transform; // ワールド粒子では発生時、ローカルでは現在の階層変換
            const width = matrix ? Math.hypot(matrix[0], matrix[1]) : scaleX;
            const height = matrix ? Math.hypot(matrix[2], matrix[3]) : scaleY;
            const basis2d = matrix ? { right: [matrix[0] / (width || 1), matrix[1] / (width || 1), 0] as const,
                up: [-matrix[2] / (height || 1), -matrix[3] / (height || 1), 0] as const } : undefined;
            output.push({ key: layer.id + ":" + sample.id, position: [...sample.position, 0],
                width: size * width * (sample.size ?? 1), height: size * height * (sample.size ?? 1),
                billboard: "camera", color: [color[0]!, color[1]!, color[2]!],
                ...(basis2d ? { basis2d } : {}),
                opacity: inherited.opacity, materialId: material.id, age: sample.age,
                ...(appearance.opacity === undefined ? {} : { materialOpacity: appearance.opacity }),
                ...(appearance.bloom === undefined ? {} : { bloomStrength: appearance.bloom }) });
        }
    }
    return output;
}

////////////////////
// 順序を保ったまま寿命方向の色と透明度を頂点値へ反映する
export function tintMaterialParticles(samples: readonly ParticleSample3D[], materials: ReadonlyMap<string, Material>): ParticleSample3D[] {
    return samples.map((sample) => {
        const appearance = materials.get(sample.materialId.toLowerCase())!.appearance; // 発生器が使用する材質
        const strength = sample.bloomStrength ?? appearance?.bloomStrength ?? 0; // 現在のレイヤー固有の発光
        const opacity = sample.opacity * (sample.materialOpacity ?? appearance?.opacity ?? 1);
        const rgba = appearance ? multiplyRgba([...sample.color, opacity], evaluateGradient(appearance.lifetime, sample.age))
            : [...sample.color, opacity] as const;
        return { ...sample, color: [rgba[0], rgba[1], rgba[2]], opacity: rgba[3], bloomStrength: strength };
    });
}
