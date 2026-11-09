import { expect, test, type Page } from "@playwright/test";

////////////////////
// タイムラインの数値を確定する
async function input(page: Page, label: string, value: string) {
    const field = page.getByLabel(label, { exact: true });
    await field.fill(value);
    await field.press("Enter");
}

////////////////////
// 実ブラウザでキー、描画、履歴、保存を同じ操作経路から確認する
test("キーの数値・ドラッグ・補間・衝突と保存を検証する", async ({ page }, info) => {
    const errors: string[] = []; // 重大なブラウザエラー
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
        if (message.type() === "error" && !message.location().url.endsWith("/favicon.ico")) errors.push(message.text());
    });
    await page.goto("/?timeline-review");
    await expect(page.getByLabel("描画状態")).toHaveText(/粒子 1 \/ GL 0/, { timeout: 70_000 });
    const add = page.getByRole("button", { name: "現在時刻にキーを追加" });
    const preview = page.getByLabel("タイムラインプレビュー");
    const keys = page.getByLabel("キーを選択");
    const keyTime = page.getByLabel("キー時刻", { exact: true });
    await add.click();
    await add.click(); // 同じトラックの同時刻は拒否する
    await expect(page.getByRole("alert")).toContainText("重複");
    await input(page, "シーク時刻", "1");
    await expect(page.getByLabel("現在時刻")).toHaveText("1 秒");
    await add.click();
    await input(page, "キー値 1", "510");
    await expect(page.getByLabel("キー値 1")).toHaveValue("510");
    await input(page, "シーク時刻", "0.5");
    await expect(page.getByLabel("現在時刻")).toHaveText("0.5 秒");
    const linear = await preview.screenshot({ path: info.outputPath("t08-linear.png") });
    await keys.selectOption("0");
    await page.getByLabel("補間方式").selectOption("step");
    await expect.poll(async () => (await preview.screenshot()).equals(linear)).toBe(false);
    await preview.screenshot({ path: info.outputPath("t08-step.png") });

    await input(page, "キー時刻", "1");
    const conflict = page.getByRole("dialog", { name: "移動先にキーがあります" });
    await expect(conflict.getByRole("button", { name: "キャンセル" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(conflict).toHaveCount(0);
    await expect(keyTime).toHaveValue("0");
    await input(page, "キー時刻", "1");
    await conflict.getByRole("button", { name: "上書きする" }).click();
    await expect(keys.locator("option")).toHaveCount(2);
    const undo = page.getByRole("button", { name: "Undo", exact: true });
    const redo = page.getByRole("button", { name: "Redo", exact: true });
    await undo.click();
    await expect(keys.locator("option")).toHaveCount(3);
    await redo.click();
    await expect(keys.locator("option")).toHaveCount(2);
    await undo.click();

    const marker = page.getByRole("button", { name: /位置 キー 1000000/ });
    await marker.scrollIntoViewIfNeeded();
    const lane = marker.locator("xpath=ancestor::div[contains(@class,'timeline-lane')]");
    const box = (await marker.boundingBox())!, laneBox = (await lane.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + laneBox.width * 0.1, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect(keyTime).toHaveValue("1.4");
    await input(page, "キー時刻", "1.412345"); // スナップ有効でも数値には適用しない
    await expect(keys).toHaveValue("1412345");
    await page.getByLabel("表示単位").selectOption("frames");
    await expect(keyTime).toHaveValue("85");
    await input(page, "制作FPS", "30");
    await expect(keys).toHaveValue("1412345");
    await page.getByLabel("表示単位").selectOption("seconds");
    await expect(keyTime).toHaveValue("1.412345");
    await page.getByRole("button", { name: "時間軸を拡大" }).click();
    const scroller = page.getByLabel("時間軸スクロール");
    await scroller.evaluate((element) => { element.scrollLeft = 250; });
    expect(await scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);

    await input(page, "制作尺", "1");
    await page.getByRole("button", { name: "範囲外キーを削除する" }).click();
    await expect(keys.locator("option")).toHaveCount(2);
    await undo.click();
    await expect(keys.locator("option")).toHaveCount(3);
    await input(page, "制作尺", "1");
    await page.getByRole("button", { name: "範囲外キーを残す" }).click();
    await expect(page.getByRole("note")).toContainText("1 個");
    await page.getByLabel("ダウンロード方式").check();
    const download = page.waitForEvent("download"); // 実際の保存ファイル
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "ダウンロードして保存", exact: true }).click();
    const file = await (await download).path();
    await undo.click();
    await page.getByLabel("ファイルから開く").setInputFiles(file!);
    await page.getByRole("button", { name: "保存せずに開く" }).click();
    await expect(page.getByRole("note")).toContainText("1 個");
    await expect(keys.locator("option")).toHaveCount(3);
    expect(errors).toEqual([]);
});

test("再生・ループ・発生終端を2Dと3Dで検証する", async ({ page }, info) => {
    await page.goto("/?timeline-review");
    const status = page.getByLabel("描画状態"), readout = page.getByLabel("現在時刻");
    await expect(status).toHaveText(/粒子 1 \/ GL 0/, { timeout: 70_000 });
    const speed = page.getByLabel("再生速度");
    await expect(speed.locator("option")).toHaveCount(7);
    for (const value of ["0.25", "0.5", "0.75", "1", "1.25", "1.5", "2"]) await speed.selectOption(value);
    const play = page.getByRole("button", { name: "再生", exact: true });
    const pause = page.getByRole("button", { name: "一時停止", exact: true });
    const stop = page.getByRole("button", { name: "停止", exact: true });
    const loop = page.getByRole("checkbox", { name: "ループ", exact: true });
    await input(page, "制作尺", "2");
    await input(page, "シーク時刻", "2");
    await expect(readout).toHaveText("2 秒");
    await play.click();
    await expect(readout).not.toHaveText("2 秒");
    await speed.selectOption("0.5");
    await pause.click();
    const paused = await readout.textContent();
    await expect(readout).toHaveText(paused!);
    await play.click();
    await expect(readout).not.toHaveText(paused!);
    await stop.click();
    await expect(readout).toHaveText("0 秒");
    await loop.uncheck();
    await input(page, "シーク時刻", "1.95");
    await play.click();
    await expect(readout).toHaveText("2 秒");
    await input(page, "発生開始", "0.5");
    await input(page, "発生終了", "1");
    await stop.click();
    await expect(status).toHaveText(/粒子 0 \/ GL 0/);
    await input(page, "シーク時刻", "1.5");
    await expect(status).toHaveText(/粒子 50 \/ GL 0/);
    await page.getByLabel("サンプル").selectOption("3d");
    await expect(status).toHaveText(/粒子 2 \/ GL 0/);
    await page.getByLabel("トラック").selectOption("bloomStrength");
    await page.getByRole("button", { name: "現在時刻にキーを追加" }).click();
    await input(page, "キー値", "4");
    await input(page, "シーク時刻", "1");
    await expect(status).toHaveText(/粒子 202 \/ GL 0/);
    await page.getByLabel("タイムラインプレビュー").screenshot({ path: info.outputPath("t08-3d.png") });
});
