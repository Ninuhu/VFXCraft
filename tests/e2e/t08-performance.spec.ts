import { expect, test } from "@playwright/test";

////////////////////
// 本番と同じ評価器を実ブラウザで動かし、少数と多数の条件を測る
test("T08のキー探索・発生・シーク・ループ性能を計測する", async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(async () => {
        const { MaterialPreview } = await import("/src/rendering/" + "MaterialPreview.ts");
        const { createParticleExample } = await import("/src/app/particles/" + "ParticleReview.tsx");
        const { create3DExample } = await import("/src/app/particles3d/" + "Particle3DReview.tsx");
        const { evaluateTrack } = await import("/src/core/document/" + "evaluateTrack.ts");
        const { playbackPosition } = await import("/src/core/document/" + "playback.ts");
        const { tracksFor } = await import("/src/core/document/" + "animation.ts");
        const { activeBirths } = await import("/src/core/particles/" + "animatedEmission.ts");
        const { validateProject } = await import("/src/core/document/" + "validateDocument.ts");
        const { EditingHistory } = await import("/src/core/editing/" + "history.ts");
        const { DEFAULT_BACKGROUND } = await import("/src/core/materials/" + "materialEvaluation.ts");
        const cases = []; // 条件ごとの集計結果
        for (const mode of ["2d", "3d"]) {
            for (const heavy of [false, true]) {
                const source = mode === "2d" ? createParticleExample() : create3DExample();
                const renderer = new MaterialPreview(document.createElement("canvas")); // 固定サイズの描画先
                try {
                    const layerIds = source.layers.map((layer: { id: string }) => layer.id); // モード固有のレイヤー
                    const properties = heavy ? ["rate", "speed", "lifetimeUs", "particleSize", "opacity", "materialOpacity", "bloomStrength"] : ["rate"];
                    const keyCount = heavy ? 201 : 2;
                    const tracks = layerIds.flatMap((layerId: string) => properties.map((property) => ({
                        layerId, property, interpolation: "linear",
                        keys: Array.from({ length: keyCount }, (_, index) => ({
                            offsetUs: index * 3_000_000 / (keyCount - 1),
                            value: property === "rate" ? (heavy ? 4000 : 100) * (index % 2 ? 0.75 : 1)
                                : property === "lifetimeUs" ? 1_000_000 + (index % 2) * 300_000
                                    : property === "bloomStrength" ? 0 : index % 2 ? 0.5 : 1,
                        })),
                    })));
                    const project = validateProject({ ...source, tracks });
                    const options = { images: new Map(), light: false, background: DEFAULT_BACKGROUND };
                    const layer = project.layers[0], emitter = project.emitters[0]; // 単一レイヤーの発生区間
                    const history = new EditingHistory(project); // ドラッグ確定の検証と履歴の費用
                    const rows: Record<string, number>[] = []; // 区間別のCPU実測
                    for (let index = -3; index < 21; index++) {
                        const now = performance.now(); // シーク、ループと再生を異なる時刻で評価
                        const seek = (index * 1_671_997 + 9_000_000) % project.durationUs;
                        const playing = playbackPosition(0, 3_600_000 + (index + 3) * 100_000, project.durationUs, true);
                        const searchStart = performance.now();
                        for (let repeat = 0; repeat < 100; repeat++) for (const track of project.tracks) evaluateTrack(track, seek, 0);
                        const searched = performance.now(); // 100回分を平均する
                        let candidateCount = 0;
                        for (const _birth of activeBirths(emitter, layer, seek, tracksFor(project, layer.id))) candidateCount++;
                        const born = performance.now(); // 発生候補の探索と寿命判定
                        const draw = renderer.draw(project, seek, options);
                        const drawn = performance.now(); // 任意シークの評価と描画指示
                        renderer.draw(project, playing, options);
                        const replayed = performance.now(); // ループを含む連続時刻の評価と描画指示
                        history.execute({ kind: "key.update", layerId: layer.id, property: "rate", offsetUs: 0,
                            key: { offsetUs: 1, value: tracks[0].keys[0].value } });
                        history.undo();
                        const end = performance.now(); // キー移動確定とUndo
                        if (index >= 0) rows.push({ clock: searchStart - now, track: (searched - searchStart) / 100, births: born - searched,
                            simulation: draw.simulationMs, body: draw.bodyMs, seek: drawn - born, replay: replayed - drawn,
                            commitUndo: end - replayed, count: draw.count, candidateCount, bytes: draw.bufferBytes });
                    }
                    const fields = Object.keys(rows[0]!); // 測定区間と粒子・バッファ量
                    const stats = Object.fromEntries(fields.map((field) => {
                        const values = rows.map((row) => row[field]!).sort((a, b) => a - b);
                        return [field, [values[10], values[19]]];
                    }));
                    cases.push({ mode, heavy, tracks: tracks.length, keys: tracks.length * keyCount, stats, gl: renderer.glError });
                } finally { renderer.dispose(); }
            }
        }
        return { browser: navigator.userAgent, width: 640, height: 360, samples: 21, cases };
    });
    expect(result.cases.every((entry) => entry.gl === 0)).toBe(true);
    console.log("T08_METRICS " + JSON.stringify(result));
});
