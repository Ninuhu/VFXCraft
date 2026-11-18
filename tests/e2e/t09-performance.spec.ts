import { expect, test } from "@playwright/test";

test("階層・アニメーション・粒子と再親子化のCPU性能を測る", async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(async () => {
        const { createHierarchyExample } = await import("/src/app/hierarchy/" + "hierarchyExample.ts");
        const { hierarchyAt, hierarchyRows } = await import("/src/core/document/" + "hierarchy.ts");
        const { layerValuesAt } = await import("/src/core/document/" + "animation.ts");
        const { MaterialPreview } = await import("/src/rendering/" + "MaterialPreview.ts");
        const { collectMaterialParticles } = await import("/src/rendering/" + "materialParticleData.ts");
        const { validateProject } = await import("/src/core/document/" + "validateDocument.ts");
        const { EditingHistory } = await import("/src/core/editing/" + "history.ts");
        const { DEFAULT_BACKGROUND } = await import("/src/core/materials/" + "materialEvaluation.ts");
        const results = []; // 独立した反復測定の結果
        const dimensions = [{ layers: 1, depth: 0, keys: 2, count: 100 }, { layers: 4, depth: 1, keys: 2, count: 100 },
            { layers: 32, depth: 16, keys: 101, count: 50 }, { layers: 128, depth: 8, keys: 21, count: 50 }];
        for (const mode of ["2d", "3d"]) for (const condition of dimensions) {
            const sample = createHierarchyExample(mode), source = sample.layers[0], emitter = sample.emitters[0];
            const layers = Array.from({ length: condition.layers }, (_, index) => ({ ...source, id: crypto.randomUUID(),
                name: "L" + index, parentId: null, order: index, startUs: 0,
                values: { ...source.values, position: mode === "2d" ? [index ? 0.2 : 200, index ? 0.1 : 180] : [index ? 0.01 : 0, 0, 0] },
                content: { kind: "emitter", emitterId: emitter.id } }));
            for (let index = 1; index < layers.length; index++) {
                const parent = index % (condition.depth + 1) === 0 ? -1 : index - 1;
                if (parent >= 0) layers[index].parentId = layers[parent].id;
            }
            const tracks = layers.map((layer: { id: string }) => ({ layerId: layer.id, property: "opacity", interpolation: "linear",
                keys: Array.from({ length: condition.keys }, (_, index) => ({ offsetUs: index * 2_000_000 / (condition.keys - 1),
                    value: index % 2 ? 0.5 : 1 })) }));
            const project = validateProject({ ...sample, layers, tracks, emitters: [{ ...emitter,
                emission: { kind: "burst", count: condition.count } }], materials: [sample.materials[0]] });
            const renderer = new MaterialPreview(document.createElement("canvas"));
            const target = layers[layers.length - 1].id;
            const measurements: Record<string, number>[] = []; // 全項目はCPU時間
            try {
                for (let index = -3; index < 21; index++) {
                    const time = ((index + 4) * 1_670_003) % 1_000_000; // 毎回異なる時刻へシークする
                    const began = performance.now();
                    for (const layer of project.layers) hierarchyAt(project, layer.id, time);
                    const hierarchy = performance.now();
                    for (const layer of project.layers) layerValuesAt(project, layer, time);
                    const animated = performance.now();
                    const particles = collectMaterialParticles(project, time);
                    const simulated = performance.now();
                    const frame = renderer.draw(project, time, { background: DEFAULT_BACKGROUND, images: new Map(), light: false });
                    const submitted = performance.now();
                    const edit = new EditingHistory(project);
                    const editStart = performance.now();
                    if (layers.length > 1) edit.execute({ kind: "layer.reparent", layerId: target, parentId: null, timeUs: time });
                    const reparented = performance.now();
                    edit.execute({ kind: "hierarchy.duplicate", layerId: layers[0].id });
                    const duplicated = performance.now();
                    if (index >= 0) measurements.push({
                        hierarchyMs: hierarchy - began, animationMs: animated - hierarchy, particlesMs: simulated - animated,
                        seekDrawMs: submitted - simulated, reparentMs: reparented - editStart, duplicateMs: duplicated - reparented,
                        totalMs: submitted - began, particles: particles.length, bufferBytes: frame.bufferBytes, calls: frame.calls,
                        duplicatedLayers: edit.preview.layers.length - project.layers.length,
                    });
                }
                const stats = Object.fromEntries(Object.keys(measurements[0]!).map((field) => {
                    const values = measurements.map((entry) => entry[field]!).sort((a, b) => a - b);
                    return [field, [values[10], values[19]]];
                }));
                results.push({ mode, ...condition, depthObserved: Math.max(...hierarchyRows(project).map((item: { depth: number }) => item.depth)),
                    trackCount: tracks.length, keyCount: tracks.length * condition.keys, gl: renderer.glError, stats });
            } finally { renderer.dispose(); }
        }
        return { browser: navigator.userAgent, samples: 21, width: 640, height: 360, results };
    });
    expect(result.results).toHaveLength(8);
    expect(result.results.every((entry) => entry.gl === 0)).toBe(true);
    console.log("T09_METRICS " + JSON.stringify(result));
});
