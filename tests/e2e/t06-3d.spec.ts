import { expect, test } from "@playwright/test";

test("3D描画・カメラ操作・ビルボード・保存往復を確認する", async ({ page }) => {
    const errors: string[] = []; // 重大なコンソールとページエラー
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
        // 既存サイトで未設定のfaviconの404だけは描画エラーから区別する。
        if (message.location().url.endsWith("/favicon.ico") && message.text().includes("404")) return;
        if (message.type() === "error") errors.push(message.text() + " " + message.location().url);
    });
    await page.goto("/?particles3d-review");
    await expect(page.getByRole("heading", { name: "T06 3Dパーティクル・カメラ検証" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("status").first()).toContainText("粒子 2");
    await expect(page.getByRole("status").first()).toContainText("GL 0");
    await page.getByLabel("ビルボード", { exact: true }).selectOption("world-y");
    const canvas = page.getByLabel("3Dプレビュー", { exact: true }); // カメラ入力対象
    const before = await canvas.screenshot(); // 操作前の画像
    const box = (await canvas.boundingBox())!; // 入力座標
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.65); await page.mouse.up();
    await page.mouse.wheel(0, 100);
    expect((await canvas.screenshot()).equals(before)).toBe(false);
    await page.keyboard.down("Shift");
    await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6); await page.mouse.up();
    await page.keyboard.up("Shift");
    await page.getByRole("button", { name: "視点リセット", exact: true }).click();
    await page.getByRole("button", { name: "全体表示", exact: true }).click();
    await page.setViewportSize({ width: 900, height: 700 });
    await expect(page.getByRole("status").first()).toContainText("GL 0");
    await page.getByLabel("ダウンロード方式").check();
    const download = page.waitForEvent("download"); // 保存する実ファイル
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "ダウンロードして保存", exact: true }).click();
    const file = await (await download).path(); // ダウンロードされた.vcr
    await expect(page.getByText("T06 sample（3d） / 保存済み")).toBeVisible();
    await page.getByLabel("ビルボード", { exact: true }).selectOption("camera");
    await page.getByLabel("ファイルから開く").setInputFiles(file!);
    await page.getByRole("button", { name: "保存せずに開く", exact: true }).click();
    await expect(page.getByLabel("ビルボード", { exact: true })).toHaveValue("world-y");
    await expect(page.getByText("T06 sample（3d） / 保存済み")).toBeVisible();
    expect(errors).toEqual([]);
});

test("粒子単位の透明合成と再利用バッファの性能・メモリ傾向を実測する", async ({ page }) => {
    await page.goto("/?particles3d-review");
    await expect(page.getByRole("heading", { name: "T06 3Dパーティクル・カメラ検証" })).toBeVisible({ timeout: 30_000 });
    const measured = await page.evaluate(async () => {
        const rendererPath = "/src/rendering/ParticleWebGL3D.ts"; // 実装本体
        const examplePath = "/src/app/particles3d/Particle3DReview.tsx"; // テストと同じ検証文書
        const { ParticleWebGL3D } = await import(rendererPath);
        const { create3DExample } = await import(examplePath);
        const canvas = document.createElement("canvas"); // 計測専用Canvas
        document.body.append(canvas);
        const renderer = new ParticleWebGL3D(canvas); // 実際のWebGL描画
        renderer.resize(640, 360);
        try {
            const base = create3DExample(); // 透明合成を観察する2レイヤー
            const doc = { ...base, layers: base.layers.map((layer: object, index: number) => ({ ...layer,
                values: { position: [0, 0, index === 0 ? -1 : 1], rotation: [0, 0, 0, 1], size: [4, 4, 4], color: [1, 1, 1], opacity: 0.5 } })),
                materials: base.materials.map((material: object, index: number) => ({ ...material, color: index === 0 ? [0, 0, 1] : [1, 0, 0] })),
                emitters: base.emitters.map((emitter: Record<string, unknown>) => ({ ...emitter, emission: { kind: "burst", count: 1 } })) };
            renderer.view.camera.position.set(0, 0, 10);
            renderer.draw(doc, 0);
            const fromFront = [...renderer.readCenterPixel()]; // 手前が赤い場合の実画素
            renderer.view.camera.position.set(0, 0, -10);
            renderer.draw(doc, 0);
            const fromBack = [...renderer.readCenterPixel()]; // カメラを反転すると手前は青
            if (!(fromFront[0]! > fromFront[2]! && fromBack[2]! > fromBack[0]!)) throw new Error("透明粒子の描画順が不正です。");
            const results = []; // 負荷別のCPU計測値
            for (const count of [100, 1000, 10000]) {
                const project = create3DExample(); // 同じサイズ・カメラで比較
                const measured = { ...project, emitters: project.emitters.map((emitter: Record<string, unknown>) => ({ ...emitter, emission: { kind: "burst", count: count / 2 } })) };
                renderer.draw(measured, 500000);
                const frames: Record<string, number>[] = []; // ウォームアップ後の15フレーム
                for (let index = 0; index < 15; index++) frames.push(renderer.draw(measured, 500000));
                const last = frames[frames.length - 1]!; // バッファとThree.js資源カウンター
                const fields = ["simulationMs", "sortMs", "buildMs", "submitMs"]; // CPU区間ごとに中央値を取る
                const medians = Object.fromEntries(fields.map((field) => [field, frames.map((frame) => frame[field]!).sort((a,b) => a-b)[7]]));
                results.push({ count, ...medians, bufferBytes: last.bufferBytes, geometries: last.geometries, textures: last.textures, calls: last.calls });
            }
            const glError = renderer.glError; // GLエラーの実測
            if (glError !== 0) throw new Error("WebGL error " + glError);
            return { userAgent: navigator.userAgent, fromFront, fromBack, results };
        } finally { renderer.dispose(); canvas.remove(); }
    });
    console.log(JSON.stringify(measured));
});
