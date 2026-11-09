import { expect, test } from "@playwright/test";

test("T07検証画面で2D・3D、制御点、品質、履歴と保存を操作する", async ({ page }, info) => {
    const errors: string[] = []; // 描画とReactの実行エラー
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
        if (message.type() === "error" && !message.location().url.endsWith("/favicon.ico")) errors.push(message.text());
    });
    await page.goto("/?materials-review");
    const canvas = page.getByLabel("マテリアルプレビュー"); // 実際の描画結果
    await expect(page.getByRole("heading", { name: "T07 マテリアル・合成・背景・基本Bloom" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/粒子 2 \/ 描画呼出し/)).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("シーク").fill("800000");
    await expect(page.getByText(/0.80秒/)).toBeVisible();
    await canvas.screenshot({ path: info.outputPath("2d-dark.png") });
    const lifetime = page.getByRole("group", { name: "寿命グラデーション" }); // 独立制御点の入力欄
    await lifetime.getByRole("button", { name: "色を追加" }).click();
    await lifetime.getByRole("button", { name: "透明度を追加" }).click();
    await lifetime.getByRole("button", { name: "透明度を追加" }).click();
    const alpha = lifetime.getByLabel("寿命グラデーション 透明度 1", { exact: true });
    const beforeGradient = await canvas.screenshot();
    await alpha.fill("0.1");
    await alpha.press("Enter");
    await expect(alpha).toHaveValue("0.1");
    await expect.poll(async () => (await canvas.screenshot()).equals(beforeGradient)).toBe(false);
    await lifetime.getByLabel("寿命グラデーション 色位置 1", { exact: true }).fill("0.9");
    await lifetime.getByLabel("寿命グラデーション 色位置 1", { exact: true }).press("Enter");
    await expect(lifetime.getByLabel("寿命グラデーション 色位置 1", { exact: true })).toHaveValue("0.9");
    await lifetime.getByRole("button", { name: "色 1 を削除" }).click();
    await expect(lifetime.getByLabel("寿命グラデーション 色位置 1", { exact: true })).toHaveCount(0);
    await page.getByLabel("背景色").fill("#dddddd");
    await page.getByLabel("背景色").blur();
    await canvas.screenshot({ path: info.outputPath("2d-light.png") });
    const blend = page.getByRole("combobox", { name: "合成", exact: true }); // ラベル内の選択肢を除いたアクセシブル名
    await blend.selectOption("multiply");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(blend).toHaveValue("alpha");
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(blend).toHaveValue("multiply");
    await page.getByLabel("背景色").fill("#252430");
    await page.getByLabel("背景色").blur();
    await page.getByLabel("Bloom強度", { exact: true }).fill("4");
    await page.getByLabel("Bloom強度", { exact: true }).press("Enter");
    await page.getByLabel("2D描画").selectOption("4");
    const pixel = await canvas.screenshot({ path: info.outputPath("2d-pixel-bloom.png") });
    await page.getByLabel("ピクセル時のBloom").selectOption("smooth");
    await expect.poll(async () => (await canvas.screenshot()).equals(pixel)).toBe(false);
    await canvas.screenshot({ path: info.outputPath("2d-smooth-bloom.png") });
    await page.getByLabel("品質").selectOption("light");
    await expect(page.getByLabel("品質")).toHaveValue("light");
    await page.getByLabel("ダウンロード方式").check();
    const download = page.waitForEvent("download"); // 実際に生成した.vcr
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "ダウンロードして保存", exact: true }).click();
    const file = await (await download).path();
    await blend.selectOption("alpha");
    await page.getByLabel("ファイルから開く").setInputFiles(file!);
    await page.getByRole("button", { name: "保存せずに開く", exact: true }).click();
    await expect(blend).toHaveValue("multiply");
    await expect(page.getByLabel("ピクセル時のBloom")).toHaveValue("smooth");
    await page.getByLabel("設定先").selectOption("common");
    await page.getByLabel("チェッカー", { exact: true }).check();
    await expect(page.getByText("T07 2D（2d） / 保存済み")).toBeVisible();
    await page.getByLabel("設定先").selectOption("project");
    await expect(page.getByLabel("チェッカー", { exact: true })).toBeChecked();
    await page.getByLabel("チェッカー", { exact: true }).uncheck();
    await page.getByRole("button", { name: "チェッカーを継承" }).click();
    await expect(page.getByLabel("チェッカー", { exact: true })).toBeChecked();
    await page.getByLabel("サンプル").selectOption("3d");
    await expect(page.getByText(/0.00秒 \/ 粒子 2/)).toBeVisible();
    await page.getByLabel("シーク").fill("800000");
    await expect(page.getByText(/0.80秒/)).toBeVisible();
    await page.getByRole("button", { name: "全体表示" }).click();
    const before = await canvas.screenshot({ path: info.outputPath("3d-dark.png") });
    const spatial = page.getByRole("group", { name: "空間グラデーション" });
    const edge = spatial.getByLabel("空間グラデーション 透明度 2", { exact: true });
    await edge.fill("0.8");
    await edge.press("Enter");
    await expect.poll(async () => (await canvas.screenshot()).equals(before)).toBe(false);
    await page.getByLabel("背景色").fill("#dedede");
    await page.getByLabel("背景色").blur();
    await canvas.screenshot({ path: info.outputPath("3d-light.png") });
    await page.setViewportSize({ width: 900, height: 700 });
    await expect(canvas).toBeVisible();
    await expect(page.getByRole("alert")).toHaveText("");
    expect(errors).toEqual([]);
});

test("2D・3Dの半透明合成、発光源、テクスチャと深度順を実画素で検証する", async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(async () => {
        const { MaterialPreview } = await import("/src/rendering/" + "MaterialPreview.ts");
        const { createParticleExample } = await import("/src/app/particles/" + "ParticleReview.tsx");
        const { create3DExample } = await import("/src/app/particles3d/" + "Particle3DReview.tsx");
        const { DEFAULT_PREVIEW, DEFAULT_APPEARANCE, DEFAULT_BACKGROUND } = await import("/src/core/materials/" + "materialEvaluation.ts");
        const output = document.createElement("canvas"); // 読み戻し対象
        const renderer = new MaterialPreview(output);
        const images = new Map(); // 実テクスチャを後で登録する
        const background = { ...DEFAULT_BACKGROUND, color: [0.21586, 0.21586, 0.21586] };
        const options = { background, light: false, images };
        const pixel = (x = 320, y = 180) => [...output.getContext("2d")!.getImageData(x, y, 1, 1).data]; // Straight RGBA
        const red = { ...DEFAULT_APPEARANCE, opacity: 0.5 }; // 50%の赤
        const modes = [];
        let bitmap: ImageBitmap | undefined; // テストが所有する画像
        try {
            for (const mode of ["2d", "3d"]) {
                const original = mode === "2d" ? createParticleExample() : create3DExample();
                const base = { ...original, layers: [{ ...original.layers[0], values: { ...original.layers[0].values,
                    opacity: 1, ...(mode === "2d" ? { size: [4, 4] } : {}) } }],
                    emitters: [{ ...original.emitters[0], emission: { kind: "burst", count: 1 },
                        particle2d: { ...original.emitters[0].particle2d, shape: { kind: "point" } } }] };
                renderer.view.camera.position.set(0, 0, 5);
                const material = { ...original.materials[0], color: [1, 0, 0], appearance: red };
                const doc = { ...base, materials: [material], preview: { ...DEFAULT_PREVIEW, bloom: { radius: 12, threshold: 0.1 } } };
                const blends = [];
                for (const blend of ["alpha", "additive", "multiply"]) {
                    renderer.draw({ ...doc, materials: [{ ...material, blend }] }, 0, options);
                    blends.push(pixel());
                }
                renderer.draw(doc, 0, options);
                const off = pixel(338);
                const strengths = [];
                for (const bloomStrength of [0.5, 4]) {
                    renderer.draw({ ...doc, materials: [{ ...material, appearance: { ...red, bloomStrength } }] }, 0, options);
                    strengths.push(pixel(338));
                }
                const glowing = { ...doc, materials: [{ ...material, appearance: { ...red, bloomStrength: 4 } }] }; // 同一粒子でしきい値と半径を変える
                renderer.draw({ ...glowing, preview: { ...doc.preview, bloom: { radius: 12, threshold: 1 } } }, 0, options);
                const aboveThreshold = pixel(338);
                renderer.draw({ ...glowing, preview: { ...doc.preview, bloom: { radius: 0, threshold: 0.1 } } }, 0, options);
                const zeroRadius = pixel(338);
                renderer.draw(glowing, 0, { images, light: false });
                const halo = pixel(338);
                const png = await new Promise<Blob>((resolve, reject) => output.toBlob((blob) =>
                    blob ? resolve(blob) : reject(new Error("PNGの画素確認に失敗しました。")), "image/png")); // 本実装とは別の一枚検証
                const decoded = await createImageBitmap(png, { premultiplyAlpha: "none" });
                const readback = document.createElement("canvas"); // PNGのStraight Alphaを再確認する
                readback.width = output.width; readback.height = output.height;
                const readbackContext = readback.getContext("2d")!;
                readbackContext.drawImage(decoded, 0, 0); decoded.close();
                const pngHalo = [...readbackContext.getImageData(338, 180, 1, 1).data];
                renderer.draw(doc, 0, { images, light: false });
                const transparent = { center: pixel(), corner: pixel(0, 0) };
                const bright = { ...options, background: { ...background, color: [1, 1, 1], grid: true } }; // 背景が発光マスクへ入らない
                renderer.draw(doc, 0, bright);
                const backgroundWithoutBloom = pixel(0, 0);
                renderer.draw(glowing, 0, bright);
                const backgroundWithBloom = pixel(0, 0);
                modes.push({ blends, off, strengths, aboveThreshold, zeroRadius, halo, pngHalo, transparent,
                    backgroundWithoutBloom, backgroundWithBloom });
                if (mode === "2d") {
                    const source = document.createElement("canvas"); // 半透明の緑を使う
                    source.width = source.height = 1;
                    const context = source.getContext("2d")!;
                    context.fillStyle = "rgba(0,255,0,0.5)"; context.fillRect(0, 0, 1, 1);
                    bitmap = await createImageBitmap(source, { premultiplyAlpha: "none" });
                    images.set("texture", bitmap);
                    renderer.draw({ ...doc, materials: [{ ...material, color: [1, 1, 1], textureAssetId: "texture" }] }, 0, { images, light: false });
                    Object.assign(modes[0]!, { texture: pixel() });
                }
            }
            const example = create3DExample(); // レイヤー順と深度順が異なる二粒子
            const depthDoc = { ...example,
                layers: example.layers.map((layer: { values: object }, index: number) => ({ ...layer, values: { ...layer.values,
                    position: [0, 0, index ? 1 : -1], size: [4, 4, 4], opacity: 0.5 } })),
                emitters: example.emitters.map((emitter: object) => ({ ...emitter, emission: { kind: "burst", count: 1 } })),
                materials: example.materials.map((material: object, index: number) => ({ ...material, appearance: DEFAULT_APPEARANCE,
                    color: index ? [1, 0, 0] : [0, 0, 1] })) };
            renderer.view.camera.position.set(0, 0, 5);
            renderer.draw(depthDoc, 0, options);
            const front = pixel();
            renderer.view.camera.position.set(0, 0, -5);
            renderer.draw(depthDoc, 0, options);
            return { modes, front, back: pixel() };
        } finally { renderer.dispose(); bitmap?.close(); }
    });
    for (const mode of result.modes) {
        const [normal, additive, multiply] = mode.blends;
        expect(additive![0]).toBeGreaterThan(normal![0]!);
        expect(normal![0]).toBeGreaterThan(multiply![0]!);
        expect(additive![1]).toBeGreaterThan(multiply![1]!);
        expect(mode.strengths[0]![0]).toBeGreaterThan(mode.off[0]!);
        expect(mode.strengths[1]![0]).toBeGreaterThan(mode.strengths[0]![0]!);
        expect(mode.transparent.center[3]).toBeGreaterThan(100);
        expect(mode.transparent.center[3]).toBeLessThan(150);
        expect(mode.transparent.corner).toEqual([0, 0, 0, 0]);
        expect(mode.aboveThreshold).toEqual(mode.off);
        expect(mode.zeroRadius).toEqual(mode.off);
        expect(mode.halo[3]).toBeGreaterThan(0);
        expect(mode.pngHalo[3]).toBe(mode.halo[3]);
        expect(mode.backgroundWithBloom).toEqual(mode.backgroundWithoutBloom);
        expect(mode.backgroundWithBloom[0]).toBeLessThan(255);
    }
    const texture = (result.modes[0] as unknown as { texture: number[] }).texture;
    expect(texture[1]).toBeGreaterThan(240);
    expect(texture[3]).toBeGreaterThan(55);
    expect(texture[3]).toBeLessThan(75);
    expect(result.front[0]).toBeGreaterThan(result.front[2]!);
    expect(result.back[2]).toBeGreaterThan(result.back[0]!);
});

test("Bloomの有無・品質・粒子数別にブラウザのCPU時間を計測する", async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(async () => {
        const { MaterialPreview } = await import("/src/rendering/" + "MaterialPreview.ts");
        const { createParticleExample } = await import("/src/app/particles/" + "ParticleReview.tsx");
        const { create3DExample } = await import("/src/app/particles3d/" + "Particle3DReview.tsx");
        const { DEFAULT_PREVIEW, DEFAULT_APPEARANCE, DEFAULT_BACKGROUND } = await import("/src/core/materials/" + "materialEvaluation.ts");
        const renderer = new MaterialPreview(document.createElement("canvas")); // 計測用描画器
        const results = []; // 同一条件での比較行
        const metrics = ["simulationMs", "sortMs", "prepareMs", "bodyMs", "bloomMs", "totalMs"]; // CPU計測の内訳
        const start = performance.now(); // 全シナリオの実測所要時間
        try {
            for (const mode of ["2d", "3d"]) {
                const base = mode === "2d" ? createParticleExample() : create3DExample();
                for (const count of [100, 1000, 10000]) {
                    const cases = ["off", "accurate", "light", ...(count !== 1000 ? [] : mode === "2d"
                        ? ["pixel", "smooth", "additive", "multiply"] : ["shared-material"])];
                    for (const name of cases) {
                        const pixel = name === "pixel" || name === "smooth"; // 粒子本体の描画方式
                        const doc = { ...base, ...(pixel ? { drawing: "pixel", pixelScale: 4 } : {}),
                            emitters: base.emitters.map((emitter: object) => ({ ...emitter,
                                ...(name === "shared-material" ? { materialId: base.materials[0].id } : {}),
                                emission: { kind: "burst", count: count / base.emitters.length } })),
                            materials: (name === "shared-material" ? base.materials.slice(0, 1) : base.materials)
                                .map((material: object, index: number) => ({ ...material,
                                blend: name === "additive" ? "additive" : index || name === "multiply" ? "multiply" : "alpha",
                                appearance: { ...DEFAULT_APPEARANCE, bloomStrength: name === "off" || index ? 0 : 2 } })),
                            preview: { ...DEFAULT_PREVIEW, pixelBloom: name === "smooth" ? "smooth" : "pixel", bloom: { radius: 12, threshold: 0.1 } } };
                        const options = { background: DEFAULT_BACKGROUND, light: name === "light", images: new Map() };
                        renderer.draw(doc, 500000, options);
                        const frames = Array.from({ length: 5 }, () => {
                            const begin = performance.now(); // 画素の読戻しを含めないCPU側時間
                            const stats = renderer.draw(doc, 500000, options);
                            return { ...stats, totalMs: performance.now() - begin } as Record<string, number>;
                        });
                        const medians = Object.fromEntries(metrics.map((field) => [field, frames.map((frame) => frame[field]!)
                            .sort((a, b) => a - b)[2]]));
                        results.push({ mode, name, count: frames[4]!.count, materials: doc.materials.length, ...medians,
                            calls: frames[4]!.calls, bufferBytes: frames[4]!.bufferBytes, textures: frames[4]!.textures });
                    }
                }
            }
            return { userAgent: navigator.userAgent, width: 640, height: 360, frames: 5,
                elapsedMs: performance.now() - start, glError: renderer.glError, results };
        } finally { renderer.dispose(); }
    });
    expect(result.glError).toBe(0);
    expect(result.results).toHaveLength(23);
    expect(result.results.every((item) => [100, 1000, 10000].includes(item.count!))).toBe(true);
    console.log("T07_METRICS " + JSON.stringify(result));
});
