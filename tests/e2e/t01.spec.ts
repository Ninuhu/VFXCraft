import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("描画モードとカメラ操作を切り替えられる", async ({ page }) => {
    await page.goto("/?technical-review");
    const canvas = page.locator('canvas[aria-label="粒子描画プレビュー"]'); // GPUの描画面
    const mode = page.getByRole("combobox", { name: "描画方式" }); // 描画モードの操作
    await expect(canvas).toBeVisible({ timeout: 30_000 }); // T10以降は検証画面を遅延ロードする
    await expect(canvas).toHaveAttribute("width", "640");
    await mode.selectOption("pixel");
    await expect(canvas).toHaveAttribute("width", "160");
    await mode.selectOption("3d");
    await expect(canvas).toHaveAttribute("width", "640");
    await page.getByRole("button", { name: "一時停止" }).click();
    const before = await canvas.screenshot(); // カメラを動かす前の固定フレーム
    const box = await canvas.boundingBox(); // ドラッグとホイール操作の範囲
    if (!box) throw new Error("描画面が表示されていません。");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 15, { steps: 5 });
    await page.mouse.up({ button: "right" });
    await expect.poll(async () => (await canvas.screenshot()).equals(before)).toBe(false);
    const panned = await canvas.screenshot(); // カメラを移動した後の固定フレーム
    await page.mouse.wheel(0, -250);
    await expect.poll(async () => (await canvas.screenshot()).equals(panned)).toBe(false);
    await page.getByRole("button", { name: "カメラリセット" }).click();
    await expect.poll(async () => (await canvas.screenshot()).equals(before)).toBe(true);
    await expect(page.getByRole("alert")).toHaveCount(0);
});

test("IndexedDBから画像を復元し、透過PNGを出力できる", async ({ page }) => {
    await page.goto("/?technical-review");
    const mode = page.getByRole("combobox", { name: "描画方式" }); // 復元後に照合する設定
    const restore = page.getByRole("button", { name: "保存データを復元" }); // 保存枠の読み込み操作
    await restore.click();
    await expect(page.getByRole("alert")).toContainText("復元できる検証データがありません");
    await mode.selectOption("pixel");
    await page.getByRole("checkbox", { name: "Bloom" }).check();
    await page.getByRole("button", { name: "ブラウザに保存" }).click();
    await expect(page.getByRole("status")).toContainText("保存しました");
    await page.reload();
    await restore.click();
    await expect(page.getByRole("status")).toContainText("復元しました");
    await expect(mode).toHaveValue("pixel");
    await expect(page.getByRole("checkbox", { name: "Bloom" })).toBeChecked();
    await expect.poll(() => page.getByRole("img", { name: "保存されたパーティクル画像" })
        .evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(160);

    await page.getByRole("checkbox", { name: "Bloom" }).uncheck();
    await page.getByRole("button", { name: "時間リセット" }).click();
    const downloadPromise = page.waitForEvent("download"); // 実際の出力ファイルの取得
    await page.getByRole("button", { name: "透過PNGを出力" }).click();
    const download = await downloadPromise; // ダウンロードされたPNG
    const file = await download.path(); // ローカルで復号するファイル
    const bytes = [...await readFile(file)]; // ブラウザへ戻してデコードするバイト列
    const result = await page.evaluate(async (data) => {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: "image/png" })); // 復号した画像
        try {
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height); // アルファを読み取るキャンバス
            const context = canvas.getContext("2d")!; // PNGを画素へ変換する描画先
            context.drawImage(bitmap, 0, 0);
            const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data; // 画素列
            return { width: bitmap.width, height: bitmap.height,
                corner: pixels[3], hasPartialAlpha: pixels.some((value, index) => index % 4 === 3 && value > 0 && value < 255) };
        } finally {
            bitmap.close();
        }
    }, bytes);
    expect(result).toEqual({ width: 160, height: 90, corner: 0, hasPartialAlpha: true });
});
