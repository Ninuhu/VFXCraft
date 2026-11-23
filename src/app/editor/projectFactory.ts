import { createProject } from "../../core/document/createProject.ts";
import { validateProject } from "../../core/document/validateDocument.ts";
import { applyEditCommand } from "../../core/editing/command.ts";
import type { Mode, Project } from "../../core/document/model.ts";
import { DEFAULT_APPEARANCE } from "../../core/materials/materialEvaluation.ts";

export type ProjectTemplate = "empty" | "basic" | "sample";

////////////////////
// テンプレートから独立した編集文書を生成する。画像・外部素材を収録しない。
export function newEditorProject(mode: Mode, template: ProjectTemplate, name: string): Project {
    let project = createProject({ id: crypto.randomUUID(), name, durationUs: 4_000_000,
        ...(mode === "2d" ? { mode, drawing: "normal", canvasWidth: 640, canvasHeight: 360 } as const : { mode }) }); // 毎回独立したID
    if (template === "empty") return project;
    project = applyEditCommand(project, { kind: "hierarchy.add", parentId: null });
    const layer = project.layers[0]!; // 基本の一発生器
    project = validateProject({ ...project, layers: [{ ...layer, values: { ...layer.values,
        position: mode === "2d" ? [320, 260] : [0, 0, 0] } }],
        emitters: project.emitters.map((item) => ({ ...item,
            particle2d: mode === "2d" ? { speed: 80, directionDegrees: 270, acceleration: [0, 40], space: "local", seed: 1,
                shape: { kind: "circle", radius: 24 } } : undefined,
            particle3d: mode === "3d" ? { speed: 1.5, direction: [0, 1, 0], acceleration: [0, -0.5, 0], space: "local", seed: 1,
                shape: "point", billboard: "camera" } : undefined })),
    });
    if (template === "basic") return project;
    project = applyEditCommand(project, { kind: "hierarchy.duplicate", layerId: layer.id });
    return validateProject({ ...project, materials: project.materials.map((item, index) => ({ ...item,
        color: index === 0 ? [0.2, 0.4, 1] : [1, 0.15, 0.4],
        appearance: { ...DEFAULT_APPEARANCE, bloomStrength: 1.5,
            lifetime: { colors: [{ offset: 0, value: [1, 1, 1] }, { offset: 1, value: [0.2, 0.2, 1] }],
                alphas: [{ offset: 0, value: 1 }, { offset: 1, value: 0 }] } } })),
        layers: project.layers.map((item, index) => ({ ...item, name: index === 0 ? "光の粒子" : "広がる粒子",
            values: { ...item.values, position: mode === "2d" ? [280 + 80 * index, 260] : [index * 0.5, 0, 0] } })),
    });
}
