import { expect, test } from "@playwright/test";

test("T05の発生・ピクセル表示・品質を切り替え、描画時間を測定する", async ({ page, browserName }) => {
    await page.goto("/?particles-review");
    await expect(page.getByRole("heading", { name: "T05 2Dパーティクル検証" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("status").first()).toContainText("粒子 1");
    await page.getByLabel("発生方式", { exact: true }).selectOption("burst");
    await page.getByLabel("一括個数").fill("10000");
    await page.getByLabel("描画", { exact: true }).selectOption("pixel:4");
    await page.getByLabel("品質", { exact: true }).selectOption("light");
    await expect(page.getByRole("status").first()).toContainText("描画 1000");
    await page.getByLabel("品質", { exact: true }).selectOption("accurate");
    await expect(page.getByRole("status").first()).toContainText("描画 10000");
    await page.getByLabel("シミュレーション空間", { exact: true }).selectOption("world");
    await page.getByLabel("発生形状", { exact: true }).selectOption("rectangle");
    const results = await page.evaluate(async () => {
        const rendererPath = "/src/rendering/ParticleCanvas2D.ts"; // Vite上の実モジュール
        const examplePath = "/src/app/particles/ParticleReview.tsx"; // 同じ設定で負荷を比較する基準文書
        const { ParticleCanvas2D } = await import(rendererPath);
        const { createParticleExample } = await import(examplePath);
        const canvas = document.createElement("canvas"); // 計測専用Canvas
        const renderer = new ParticleCanvas2D(canvas); // 実際の描画実装
        const samples = []; // 負荷別の参考値
        try {
            for (const count of [100,1000,10000]) {
                const project = createParticleExample(); // 独立した計測用文書
                const doc = { ...project, emitters: [{ ...project.emitters[0], emission: {kind:"burst",count} }] };
                renderer.draw(doc,0,"accurate");
                const values = []; // 評価＋Canvas描画のCPU時間
                for (let iteration=0; iteration<15; iteration++) {
                    const start=performance.now();
                    renderer.draw(doc,500000,"accurate");
                    values.push(performance.now()-start);
                }
                values.sort((a,b)=>a-b);
                samples.push({count,medianMs:values[7],p95Ms:values[14]});
            }
            const doc = createParticleExample(); // ピクセル倍率と品質の独立性を確認
            const pixels = {...doc,drawing:"pixel",pixelScale:8};
            const before=JSON.stringify(pixels);
            renderer.draw(pixels,500000,"light");
            if (JSON.stringify(pixels)!==before) throw new Error("プレビューが保存値を変更しました。");
            const context=canvas.getContext("2d")!;
            if(context.imageSmoothingEnabled) throw new Error("Nearest-neighborが無効です。");
            return {userAgent:navigator.userAgent,samples};
        } finally {renderer.dispose();}
    });
    console.log(JSON.stringify({browserName,...results}));
});
