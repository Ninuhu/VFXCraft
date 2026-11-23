import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";

test("正式エディタの2D・3D再生と連続編集のCPU・フレーム間隔を測定する", async ({ page, browser }, info) => {
    const records = []; // 比較条件ごとの観測値
    page.on("dialog", (dialog) => void dialog.accept());
    for (const mode of ["2d", "3d"]) for (const rate of [100, 2500]) {
        await page.goto("/");
        const bytes = await page.evaluate(async ({ mode, rate }) => {
            const { newEditorProject } = await import("/src/app/editor/" + "projectFactory.ts");
            const { applyEditCommand } = await import("/src/core/editing/" + "command.ts");
            const { writeVcr, REVIEW_VCR_LIMITS } = await import("/src/core/persistence/" + "vcrArchive.ts");
            let project = newEditorProject(mode, "sample", "性能 " + mode);
            for (let index = 0; index < 2; index++) project = applyEditCommand(project, { kind: "hierarchy.duplicate", layerId: project.layers[0].id });
            for (const emitter of project.emitters) project = applyEditCommand(project, { kind: "emitter.update", emitterId: emitter.id, settings: { lifetimeUs: 2e6, emission: { kind: "continuous", ratePerSecond: rate } } });
            for (const layer of project.layers) for (let index = 0; index < 20; index++) project = applyEditCommand(project, { kind: "key.add", layerId: layer.id,
                property: "opacity", key: { offsetUs: index * 200000, value: 1 - (index % 4) / 10 } });
            const file = await writeVcr({ project, images: new Map() }, REVIEW_VCR_LIMITS, async () => {}, "test");
            return [...new Uint8Array(await file.arrayBuffer())];
        }, { mode, rate });
        await page.getByLabel("プロジェクトファイル", { exact: true }).setInputFiles({ name: "performance.vcr", mimeType: "application/zip", buffer: Buffer.from(bytes) });
        await expect(page.getByLabel("エフェクトプレビュー")).toBeVisible();
        await page.getByLabel("シーク時刻", { exact: true }).fill("2"); await page.getByLabel("シーク時刻", { exact: true }).press("Enter");
        await page.getByRole("button", { name: "再生", exact: true }).click();
        const measurement = await page.evaluate(async () => {
            const intervals: number[] = [], cpu: number[] = [], particles: number[] = []; // GPU時間ではない
            let previous = performance.now(); // 壁時計のフレーム間隔
            await new Promise<void>((resolve) => {
                const sample = (now: number) => {
                    if (intervals.length > 5) { // 起動直後を除くウォームアップ
                        const output = document.querySelector<HTMLOutputElement>('output[aria-label="描画状態"]');
                        cpu.push(Number(output?.dataset.cpuMs ?? 0)); particles.push(Number(output?.dataset.particles ?? 0));
                    }
                    intervals.push(now - previous); previous = now;
                    if (intervals.length >= 65) resolve(); else requestAnimationFrame(sample);
                };
                requestAnimationFrame(sample);
            });
            const summarize = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return { n: sorted.length, median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * .95)] }; };
            return { frames: summarize(intervals.slice(6)), cpu: summarize(cpu), particleMax: Math.max(...particles),
                memory: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null };
        });
        await page.getByRole("button", { name: "一時停止", exact: true }).click();
        await page.getByRole("treeitem").first().getByRole("button", { name: /✦/ }).click();
        const input = page.getByLabel("初速度", { exact: true });
        const start = performance.now(); await input.fill("2"); await input.press("Enter");
        records.push({ mode, rate, layers: 4, materials: 4, keys: 80, bloom: 1.5, preview: "accurate", canvas: "640x360", ...measurement,
            automationEditElapsedMs: performance.now() - start });
    }
    const result = { browser: browser.version(), viewport: page.viewportSize(), records, gpuTime: "未測定", reactCommits: "未測定" };
    console.log("T10_METRICS " + JSON.stringify(result));
    await writeFile(info.outputPath("performance.json"), JSON.stringify(result, null, 2));
    await info.attach("t10-performance.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
});
