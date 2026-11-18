import { expect, test, type Page } from "@playwright/test";

////////////////////
// 数値欄を確定してドメインの編集経路を通す
async function number(page: Page, label: string, value: string) {
    const input = page.getByLabel(label, { exact: true });
    await input.fill(value); await input.press("Enter");
}

test("階層の再親子化・ロック・表示・複製・削除・保存を操作する", async ({ page }, info) => {
    const errors: string[] = []; // React・WebGLの重大なエラー
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
        if (message.type() === "error" && !message.location().url.endsWith("/favicon.ico")) errors.push(message.text());
    });
    await page.goto("/?hierarchy-review");
    const tree = page.getByRole("list", { name: "レイヤー階層" });
    const canvas = page.getByLabel("階層プレビュー", { exact: true });
    const parent = page.getByRole("button", { name: "親の粒子を選択", exact: true });
    const child = page.getByRole("button", { name: "子の粒子を選択", exact: true });
    const other = page.getByRole("button", { name: "別の親を選択", exact: true });
    const undo = page.getByRole("button", { name: "Undo", exact: true });
    const redo = page.getByRole("button", { name: "Redo", exact: true });
    const alert = page.getByRole("alert").first();
    await expect(page.getByLabel("階層描画状態")).toContainText("GL 0", { timeout: 70_000 });
    await page.getByText("共有タイムラインとキーフレーム", { exact: true }).click();
    await number(page, "シーク時刻", "1");
    await expect(page.getByLabel("階層描画状態")).toContainText("1.000 秒");
    await canvas.screenshot({ path: info.outputPath("t09-parent-child.png") });
    await child.click();
    const position = await page.getByLabel("ワールド位置").textContent();
    const parents = page.getByLabel("親を変更", { exact: true });
    const otherId = await parents.locator("option").filter({ hasText: "別の親" }).getAttribute("value");
    await parents.selectOption(otherId!);
    await expect(page.getByLabel("ワールド位置")).toHaveText(position!);
    await canvas.screenshot({ path: info.outputPath("t09-reparent.png") });
    await undo.click(); await expect(page.getByLabel("ワールド位置")).toHaveText(position!);
    await redo.click(); await expect(page.getByLabel("ワールド位置")).toHaveText(position!);
    await undo.click();
    await child.locator("..").dragTo(other.locator(".."));
    await expect(parents).toHaveValue(otherId!);
    await expect(page.getByLabel("ワールド位置")).toHaveText(position!);
    await undo.click();

    await parent.click();
    await page.getByLabel("自身を表示", { exact: true }).uncheck();
    await expect(page.getByLabel("階層描画状態")).toContainText("粒子 0");
    await child.click();
    await expect(page.getByLabel("自身を表示", { exact: true })).toBeChecked();
    await parent.click();
    await page.getByLabel("自身を表示", { exact: true }).check();
    const beforeAlpha = await canvas.screenshot();
    await number(page, "レイヤー透明度", "0.2");
    await expect.poll(async () => (await canvas.screenshot()).equals(beforeAlpha)).toBe(false);
    await canvas.screenshot({ path: info.outputPath("t09-inherited-alpha.png") });
    await undo.click();
    await page.getByLabel("レイヤー色", { exact: true }).fill("#ffff00");
    await page.getByLabel("レイヤー色", { exact: true }).blur();
    await canvas.screenshot({ path: info.outputPath("t09-inherited-color.png") });
    await undo.click();
    await page.getByLabel("自身をロック", { exact: true }).check();
    await child.click();
    await expect(page.getByRole("note").first()).toContainText("祖先");
    await expect(page.getByLabel("位置 X", { exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "階層を複製", exact: true })).toBeDisabled();
    await other.click();
    const lockedParentId = await parents.locator("option").filter({ hasText: "親の粒子" }).getAttribute("value");
    await parents.selectOption(lockedParentId!);
    await expect(alert).toContainText("ロック");
    await expect(parents).toHaveValue("");
    await parent.click(); await page.getByLabel("自身をロック", { exact: true }).uncheck();
    await child.click();
    await page.getByRole("button", { name: "一段上へ親解除" }).click();
    await expect(parents).toHaveValue("");
    await expect(page.getByLabel("ワールド位置")).toHaveText(position!);
    await undo.click();
    await parent.click();
    const sourceRows = await tree.locator(":scope > li").count();
    await page.getByRole("button", { name: "階層を複製", exact: true }).click();
    await expect(tree.locator(":scope > li")).toHaveCount(sourceRows + 2);
    await page.getByRole("button", { name: "子の粒子 コピーを選択", exact: true }).click();
    await number(page, "位置 X", "88");
    await child.click();
    await expect(page.getByLabel("位置 X", { exact: true })).toHaveValue("45");
    await parent.click();
    await page.getByRole("button", { name: "階層を削除", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "親と子孫を削除しますか" });
    await expect(modal.getByRole("button", { name: "キャンセル", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(tree.locator(":scope > li")).toHaveCount(sourceRows + 2);
    await page.getByRole("button", { name: "階層を削除", exact: true }).click();
    await modal.getByRole("button", { name: "親と子孫を削除する" }).click();
    await expect(tree.locator(":scope > li")).toHaveCount(sourceRows);
    await undo.click();
    await expect(tree.locator(":scope > li")).toHaveCount(sourceRows + 2);
    await page.getByLabel("ダウンロード方式", { exact: true }).check();
    const download = page.waitForEvent("download");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "ダウンロードして保存", exact: true }).click();
    const file = await (await download).path();
    await page.getByRole("button", { name: "ルート粒子を追加", exact: true }).click();
    await page.getByLabel("ファイルから開く").setInputFiles(file!);
    await page.getByRole("button", { name: "保存せずに開く", exact: true }).click();
    await expect(tree.locator(":scope > li")).toHaveCount(sourceRows + 2);
    await expect(page.getByText("T09 2D（2d） / 保存済み")).toBeVisible();
    expect(errors).toEqual([]);
});

test("World・親ローカル・グリッド・3Dと共有タイムラインを検証する", async ({ page }, info) => {
    await page.goto("/?hierarchy-review");
    await expect(page.getByLabel("階層描画状態")).toContainText("GL 0", { timeout: 70_000 });
    await page.getByRole("button", { name: "子の粒子を選択", exact: true }).click();
    await page.getByLabel("編集座標", { exact: true }).selectOption("world");
    await page.getByLabel("位置スナップ", { exact: true }).check();
    await number(page, "2D スナップ間隔", "0.5");
    await number(page, "位置 X", "370.2");
    await expect(page.getByLabel("ワールド位置")).toHaveText("370, 180");
    await page.getByLabel("編集座標", { exact: true }).selectOption("parent");
    await expect(page.getByLabel("位置 X", { exact: true })).toHaveValue("50");
    const drag = page.getByRole("button", { name: "ドラッグでX方向へ移動", exact: true });
    await drag.scrollIntoViewIfNeeded();
    const box = (await drag.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect(page.getByLabel("位置 X", { exact: true })).toHaveValue("70");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.getByLabel("位置 X", { exact: true })).toHaveValue("50");
    await page.getByLabel("編集グリッド", { exact: true }).check();
    await page.getByLabel("階層プレビュー", { exact: true }).screenshot({ path: info.outputPath("t09-2d-grid.png") });
    await number(page, "2D スナップ間隔", "0");
    await expect(page.getByRole("alert").first()).toContainText("スナップ間隔");
    await page.getByLabel("階層サンプル").selectOption("3d");
    await expect(page.getByLabel("3D スナップ間隔")).toHaveValue("0.5");
    await page.getByRole("button", { name: "子の粒子を選択", exact: true }).click();
    await page.getByLabel("編集座標", { exact: true }).selectOption("world");
    await number(page, "位置 X", "1.2");
    await expect(page.getByLabel("ワールド位置")).toHaveText("1, 0, 0");
    await page.getByLabel("編集グリッド", { exact: true }).check();
    await page.getByText("共有タイムラインとキーフレーム", { exact: true }).click();
    await number(page, "シーク時刻", "1");
    await expect(page.getByLabel("階層描画状態")).toContainText("1.000 秒");
    await expect(page.getByLabel("ワールド位置")).toHaveText("1.25, 0, 0");
    await page.getByLabel("階層プレビュー", { exact: true }).screenshot({ path: info.outputPath("t09-3d-grid.png") });
    const before = await page.getByLabel("ワールド位置").textContent();
    const parents = page.getByLabel("親を変更", { exact: true });
    const other = await parents.locator("option").filter({ hasText: "別の親" }).getAttribute("value");
    await parents.selectOption(other!);
    await expect(page.getByLabel("ワールド位置")).toHaveText(before!);
    await page.getByRole("button", { name: "子粒子を追加", exact: true }).click();
    await expect(page.getByRole("button", { name: "新しい粒子を選択", exact: true })).toBeVisible();
});

test("祖先の色・Alphaと非表示が三種の合成へ反映される", async ({ page }) => {
    await page.goto("/");
    const measured = await page.evaluate(async () => {
        const { createHierarchyExample } = await import("/src/app/hierarchy/" + "hierarchyExample.ts");
        const { MaterialPreview } = await import("/src/rendering/" + "MaterialPreview.ts");
        const { DEFAULT_BACKGROUND } = await import("/src/core/materials/" + "materialEvaluation.ts");
        const output = document.createElement("canvas"), renderer = new MaterialPreview(output);
        const results = [];
        const pixel = () => [...output.getContext("2d")!.getImageData(320, 180, 1, 1).data];
        try {
            for (const mode of ["2d", "3d"]) {
                const source = createHierarchyExample(mode);
                const first = source.layers[0], child = source.layers[1];
                const origin = mode === "2d" ? [320, 180] : [0, 0, 0];
                const doc = { ...source, tracks: [], layers: [
                    { ...first, content: { kind: "group" }, values: { ...first.values, position: origin, color: [0.5, 1, 1], opacity: 0.5 } },
                    { ...child, startUs: 0, values: { ...child.values, position: mode === "2d" ? [0, 0] : [0, 0, 0],
                        size: mode === "2d" ? [4, 4] : [3, 3, 3], color: [1, 1, 1], opacity: 0.5 } },
                ], emitters: source.emitters.map((item: Record<string, unknown>) => ({ ...item,
                    ...(mode === "2d" ? { particle2d: { ...(item.particle2d as object), speed: 0, acceleration: [0, 0] } }
                        : { particle3d: { ...(item.particle3d as object), speed: 0, acceleration: [0, 0, 0] } }),
                    emission: { kind: "burst", count: 1 } })), materials: source.materials.map((item: object) => ({ ...item, color: [1, 0, 0] })) };
                renderer.view.camera.position.set(0, 0, 5);
                const options = { images: new Map(), light: false };
                renderer.draw(doc, 0, options);
                const rgba = pixel();
                const variants = [];
                for (const blend of ["alpha", "additive", "multiply"]) {
                    renderer.draw({ ...doc, materials: doc.materials.map((item: object) => ({ ...item, blend })) }, 0,
                        { ...options, background: { ...DEFAULT_BACKGROUND, color: [0.21586, 0.21586, 0.21586] } });
                    variants.push(pixel());
                }
                renderer.draw({ ...doc, layers: doc.layers.map((layer: object, index: number) => index === 0
                    ? { ...layer, isVisible: false } : layer) }, 0, options);
                const hidden = pixel();
                renderer.draw({ ...doc, tracks: [{ layerId: first.id, property: "opacity", interpolation: "linear",
                    keys: [{ offsetUs: 0, value: 0.5 }, { offsetUs: 2000000, value: 0 }] }] }, 1000000, options);
                results.push({ rgba, variants, hidden, animated: pixel(), gl: renderer.glError });
            }
        } finally { renderer.dispose(); }
        return results;
    });
    for (const result of measured) {
        expect(result.gl).toBe(0);
        expect(result.rgba[0]).toBeGreaterThan(180);
        expect(result.rgba[0]).toBeLessThan(195);
        expect(result.rgba[3]).toBeGreaterThan(60);
        expect(result.rgba[3]).toBeLessThan(68);
        expect(result.hidden).toEqual([0, 0, 0, 0]);
        expect(result.animated[3]).toBeGreaterThan(28);
        expect(result.animated[3]).toBeLessThan(36);
        expect(result.variants[1]![0]).toBeGreaterThan(result.variants[0]![0]!);
        expect(result.variants[0]![0]).toBeGreaterThan(result.variants[2]![0]!);
    }
});
