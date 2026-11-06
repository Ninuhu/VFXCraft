import { expect, test } from "@playwright/test";
import type { PreviewOptions } from "../../src/verification/WebGlPreview";

test("Chromeで描画負荷の参考値を測る", async ({ page, browser }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "一時停止" }).click();
    const measurements = await page.evaluate(async () => {
        const modulePath = "/src/verification/WebGlPreview.ts"; // Viteで読み込む検証用描画器
        const { WebGlPreview } = await import(modulePath) as typeof import("../../src/verification/WebGlPreview");
        const canvas = document.createElement("canvas"); // 本体画面と分離した測定面
        const samples = []; // 各負荷条件で取得した参考値
        const options: PreviewOptions = { mode: "3d", emission: "burst", isAdditive: true, hasBloom: true, isPlaying: false }; // 固定フレームの描画条件
        const warmupCount = 8; // 初期化の影響を除くためのフレーム数
        const sampleCount = 30; // 計測対象フレーム数
        for (const count of [100, 1000, 5000]) {
            const preview = new WebGlPreview(canvas, count); // 指定数のビルボードを所有する描画器
            try {
                const gl = canvas.getContext("webgl2")!; // 描画完了待ちと環境確認に使うGPU接続
                const debug = gl.getExtension("WEBGL_debug_renderer_info"); // GPUの識別情報
                const renderer = String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER)); // 実際のレンダラー
                const times: number[] = []; // GPU完了までを含む描画時間（ms）
                for (let index = 0; index < warmupCount + sampleCount; index++) {
                    const start = performance.now(); // フレーム計測開始（ms）
                    preview.render(0.65, options);
                    gl.finish(); // GPU完了を含める同期測定。通常の再生FPSとは区別する。
                    if (index >= warmupCount) times.push(performance.now() - start);
                }
                times.sort((a, b) => a - b);
                samples.push({ count, width: canvas.width, height: canvas.height, renderer,
                    medianMs: times[Math.floor(times.length / 2)], p95Ms: times[Math.ceil(times.length * 0.95) - 1] });
            } finally {
                preview.dispose();
            }
        }
        return samples;
    }); // ブラウザで採取した同期描画時間
    expect(measurements.map(({ count }) => count)).toEqual([100, 1000, 5000]);
    expect(measurements.every(({ medianMs, p95Ms }) => Number.isFinite(medianMs) && Number.isFinite(p95Ms))).toBe(true);
    console.log(JSON.stringify({ chrome: browser.version(), measurements }));
});
