import { validateProject } from "../../core/document/validateDocument.ts";
import type { Mode } from "../../core/document/model.ts";
import { DEFAULT_APPEARANCE } from "../../core/materials/materialEvaluation.ts";
import { createParticleExample } from "../particles/ParticleReview.tsx";
import { create3DExample } from "../particles3d/Particle3DReview.tsx";

////////////////////
// 通常粒子を親にし、親子のアニメーションと独立した発生時刻を持つ見本を作る
export function createHierarchyExample(mode: Mode) {
    const source = mode === "2d" ? createParticleExample() : create3DExample(30); // 既存の正常な見本
    const first = source.layers[0]!, emitter = source.emitters[0]!, material = source.materials[0]!;
    const parentId = first.id, childId = crypto.randomUUID(), otherId = crypto.randomUUID();
    const childEmitterId = crypto.randomUUID(), childMaterialId = crypto.randomUUID(); // 子は独立した設定
    const origin = mode === "2d" ? [320, 180] : [0, 0, 0];
    const offset = mode === "2d" ? [45, 0] : [0.8, 0, 0];
    return validateProject({ ...source, name: "T09 " + mode.toUpperCase(),
        layers: [
            { ...first, name: "親の粒子", values: { ...first.values, position: origin }, emissionEndUs: 1_000_000 },
            { ...first, id: childId, name: "子の粒子", parentId, order: 1, startUs: 500_000,
                values: { ...first.values, position: offset }, content: { kind: "emitter", emitterId: childEmitterId } },
            { ...first, id: otherId, name: "別の親", parentId: null, order: 2,
                values: { ...first.values, position: mode === "2d" ? [180, 150] : [-1, 0, 0] }, content: { kind: "group" } },
        ],
        emitters: [{ ...emitter }, { ...emitter, id: childEmitterId, materialId: childMaterialId }],
        materials: [{ ...material, appearance: { ...DEFAULT_APPEARANCE }, color: [0.25, 0.6, 1] },
            { ...material, id: childMaterialId, appearance: { ...DEFAULT_APPEARANCE }, color: [1, 0.3, 0.1] }],
        tracks: [{ layerId: parentId, property: "position", interpolation: "linear", keys: [
            { offsetUs: 0, value: origin },
            { offsetUs: 2_000_000, value: mode === "2d" ? [360, 180] : [0.5, 0, 0] },
        ] }],
    });
}
