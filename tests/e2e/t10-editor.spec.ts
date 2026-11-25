import { test, expect, type Page } from "@playwright/test";

const browserErrors = new WeakMap<Page, string[]>(); // 画面が空白になった場合も起動例外を記録する
const pendingRequests = new WeakMap<Page, Set<string>>(); // 起動停止時の通信を診断する
test.beforeEach(async ({ page }) => {
    const errors: string[] = []; browserErrors.set(page, errors);
    const requests = new Set<string>(); pendingRequests.set(page, requests);
    page.on("request", (request) => requests.add(request.url()));
    page.on("requestfinished", (request) => requests.delete(request.url()));
    page.on("requestfailed", (request) => requests.delete(request.url()));
    page.on("dialog", (dialog) => void dialog.accept());
    page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
    page.on("console", (message) => { if (message.type() === "error" && !message.location().url.endsWith("/favicon.ico")) errors.push(message.text()); });
}); // 標準離脱警告はテスト操作として明示承認する
test.afterEach(async ({ page }, info) => {
    const errors = browserErrors.get(page) ?? [];
    if (info.status !== info.expectedStatus) console.log("T10_PENDING_REQUESTS " + JSON.stringify([...pendingRequests.get(page) ?? []]));
    if (errors.length) console.log("T10_BROWSER_ERRORS " + JSON.stringify({ title: info.title, errors }));
    expect(errors).toEqual([]);
});

////////////////////
// 正式ホームから編集可能な一プロジェクトを作る。
async function create(page: Page, mode = "2D", template = "基本パーティクル入り") {
    await page.goto("/");
    await page.getByRole("button", { name: "＋ 新規プロジェクトを作成", exact: true }).click();
    await page.getByRole("button", { name: mode + "エフェクト", exact: true }).click();
    await page.getByLabel(template, { exact: true }).check();
    await page.getByRole("button", { name: "作成する", exact: true }).click();
    await expect(page.getByLabel("エフェクトプレビュー")).toBeVisible({ timeout: 30_000 }); // 遅延ロード中のモジュール準備も待つ
    await expect(page.getByRole("treeitem")).toHaveCount(template === "空のプロジェクト" ? 0 : template === "基本パーティクル入り" ? 1 : 2);
}

test("正式9画面の入口と2D/3D・3方式の独立作成", async ({ page }, info) => {
    const errors: string[] = []; // 起動・遷移中のReactとWebGL例外
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await page.screenshot({ path: info.outputPath("01-home.png"), fullPage: true });
    for (const [name, title] of [["プリセットLibrary", "プリセットLibrary"], ["素材管理", "素材管理"], ["エクスポート", "エクスポート"], ["設定", "設定"], ["ヘルプ", "ヘルプ"]]) {
        await page.getByRole("navigation").getByRole("button", { name, exact: true }).click();
        await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
        await page.screenshot({ path: info.outputPath(name + ".png"), fullPage: true });
    }
    await page.getByRole("navigation").getByRole("button", { name: "新規作成", exact: true }).click();
    await page.screenshot({ path: info.outputPath("02-new-project.png"), fullPage: true });
    expect(errors).toEqual([]);
});

for (const mode of ["2D", "3D"]) for (const template of ["空のプロジェクト", "基本パーティクル入り", "サンプルプロジェクト"]) {
    test(`${mode} ${template}を正式UIから作成`, async ({ page }, info) => {
        await create(page, mode, template);
        await page.getByRole("button", { name: "再生", exact: true }).click();
        await expect.poll(() => page.getByLabel("現在時刻", { exact: true }).textContent()).not.toBe("0 秒");
        await page.getByRole("button", { name: "一時停止", exact: true }).click();
        await page.screenshot({ path: info.outputPath(mode + "-" + template + ".png"), fullPage: true });
    });
}

test("正式UIの編集・Undo・複数選択・Auto Key・ギズモ・パネル復元", async ({ page }, info) => {
    await create(page, "2D", "サンプルプロジェクト");
    const rows = page.getByRole("treeitem");
    await rows.nth(0).getByRole("button", { name: "✦ 光の粒子", exact: true }).click();
    await rows.nth(1).getByRole("button", { name: "✦ 広がる粒子", exact: true }).click({ modifiers: ["Control"] });
    await expect(page.getByText("2層選択／編集対象：広がる粒子（一括編集なし）")).toBeVisible();
    const speed = page.getByLabel("初速度", { exact: true });
    const previous = await speed.inputValue();
    await speed.fill("25"); await speed.press("Enter");
    await page.getByRole("button", { name: "↶ Undo", exact: true }).click(); await expect(speed).toHaveValue(previous);
    await page.getByLabel("Auto Key", { exact: true }).check();
    await speed.fill("35"); await speed.press("Enter");
    await expect(page.getByLabel(/広がる粒子 初速度 キー/)).toHaveCount(1);
    await page.getByRole("button", { name: "移動", exact: true }).click();
    const handle = page.getByRole("button", { name: "ギズモ X", exact: true });
    const box = await handle.boundingBox(); expect(box).not.toBeNull();
    if (box) { await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width + 35, box.y + box.height / 2, { steps: 5 }); await page.mouse.up(); }
    await page.getByLabel("レイヤー", { exact: true }).selectOption({ label: "光の粒子" });
    await expect(page.getByText("2層選択／編集対象：光の粒子（一括編集なし）")).toBeVisible();
    await page.getByRole("button", { name: "インスペクターを非表示", exact: true }).click();
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByLabel("インスペクター配置").selectOption("left");
    await page.getByLabel("インスペクター", { exact: true }).check();
    await page.reload();
    await page.getByRole("navigation").getByRole("button", { name: "設定", exact: true }).click();
    await expect(page.getByLabel("インスペクター配置")).toHaveValue("left");
    await page.getByRole("button", { name: "初期配置に戻す", exact: true }).click();
    await expect(page.getByLabel("インスペクター配置")).toHaveValue("right");
    await page.screenshot({ path: info.outputPath("layout-settings.png"), fullPage: true });
});

test("ダウンロード確認・.vcr往復・失敗保護・自動復元", async ({ page }, info) => {
    await create(page);
    await page.getByLabel("ダウンロード方式", { exact: true }).check();
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    const file = await downloaded, path = info.outputPath("editor.vcr");
    await file.saveAs(path);
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "保存完了を確認", exact: true }).click();
    await expect(page.locator(".editor-toolbar")).not.toContainText("新しいエフェクト *");
    await page.getByRole("treeitem").first().getByRole("button", { name: "✦ 新しい粒子", exact: true }).click();
    await page.getByLabel("初速度", { exact: true }).fill("42"); await page.getByLabel("初速度", { exact: true }).press("Enter");
    await expect.poll(() => page.evaluate(async () => {
        const request = indexedDB.open("vfxcraft-project-recovery");
        return new Promise<number>((resolve, reject) => { request.onerror = () => reject(request.error); request.onsuccess = () => { const db = request.result, query = db.transaction("generations").objectStore("generations").count(); query.onsuccess = () => { resolve(query.result); db.close(); }; }; });
    })).toBeGreaterThan(0);
    await page.getByLabel("プロジェクトファイル", { exact: true }).setInputFiles({ name: "bad.vcr", mimeType: "application/zip", buffer: Buffer.from("broken") });
    await page.getByRole("button", { name: "保存せず開く", exact: true }).click();
    await expect(page.getByLabel("初速度", { exact: true })).toHaveValue("42");
    await page.getByLabel("プロジェクトファイル", { exact: true }).setInputFiles(path);
    await page.getByRole("button", { name: "保存せず開く", exact: true }).click();
    await page.getByRole("treeitem").first().getByRole("button", { name: "✦ 新しい粒子", exact: true }).click();
    await expect(page.getByLabel("初速度", { exact: true })).toHaveValue("80");
    await page.reload();
    await expect(page.getByRole("button", { name: "作業を復元", exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "作業を復元", exact: true }).first().click();
    await expect(page.getByLabel("エフェクトプレビュー")).toBeVisible();
    await expect(page.locator(".editor-toolbar")).toContainText("*");
});

test("ショートカット競合の取消と解除、入力中の誤発火防止", async ({ page }) => {
    await create(page);
    await page.getByRole("treeitem").first().getByRole("button", { name: "✦ 新しい粒子", exact: true }).click();
    const name = page.locator("#editor-layer-name");
    await name.fill("wasd qer"); await name.press("Space"); await name.press("Enter"); await name.blur();
    await expect(page.getByRole("treeitem")).toHaveCount(1);
    await page.getByRole("button", { name: "設定", exact: true }).click();
    const register = page.getByRole("button", { name: "プロジェクトを開くのキー登録", exact: true });
    await register.click(); await register.press("Control+s");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await register.click(); await register.press("Control+s");
    await page.getByRole("button", { name: "既存割当を解除して登録", exact: true }).click();
    await expect(page.getByRole("row").filter({ has: register })).toContainText("Ctrl+S");
    await page.getByRole("button", { name: "ショートカットを初期設定に戻す", exact: true }).click();
});

test("3Dギズモの移動・回転・スケールとCtrl+Dを実操作する", async ({ page }, info) => {
    await create(page, "3D");
    await page.getByRole("treeitem").first().getByRole("button", { name: "✦ 新しい粒子", exact: true }).click();
    for (const [tool, label] of [["移動", "位置 X"], ["回転", "回転 X度"], ["スケール", "スケール X"]]) {
        const input = page.getByLabel(label, { exact: true }), before = await input.inputValue();
        await page.getByRole("button", { name: tool, exact: true }).click();
        const circle = page.getByRole("button", { name: "ギズモ X", exact: true }).locator("circle"), box = await circle.boundingBox();
        if (!box) throw new Error("3Dハンドルが表示されていません。");
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 - 15, { steps: 6 }); await page.mouse.up();
        await expect(input).not.toHaveValue(before);
        await page.getByRole("button", { name: "↶ Undo", exact: true }).click(); await expect(input).toHaveValue(before);
    }
    await page.getByRole("treeitem").first().getByRole("button", { name: "✦ 新しい粒子", exact: true }).focus();
    await page.keyboard.press("Control+d"); await expect(page.getByRole("treeitem")).toHaveCount(2);
    await page.getByRole("button", { name: "↶ Undo", exact: true }).click(); await expect(page.getByRole("treeitem")).toHaveCount(1);
    await page.screenshot({ path: info.outputPath("3d-gizmo.png"), fullPage: true });
});

test("縮小画面のCanvas表示・画素更新・グループ操作・パネルサイズを確認する", async ({ page }, info) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await create(page);
    await page.getByRole("treeitem").first().getByRole("button", { name: "✦ 新しい粒子", exact: true }).click();
    await page.getByLabel("シーク時刻", { exact: true }).fill("1"); await page.getByLabel("シーク時刻", { exact: true }).press("Enter");
    const canvas = page.getByLabel("エフェクトプレビュー", { exact: true });
    const dimensions = await canvas.evaluate((element) => { const a = element.getBoundingClientRect(), b = element.parentElement!.getBoundingClientRect(); return { canvas: a.height, surface: b.height }; });
    expect(dimensions.canvas).toBeLessThanOrEqual(dimensions.surface + 1);
    const before = await canvas.screenshot();
    const opacity = page.getByLabel("基本透明度", { exact: true });
    await opacity.fill("0"); await opacity.press("Enter");
    await expect.poll(async () => (await canvas.screenshot()).equals(before)).toBe(false);
    await page.getByRole("button", { name: "↶ Undo", exact: true }).click();
    await page.getByRole("treeitem").first().getByRole("button", { name: "✦ 新しい粒子", exact: true }).focus();
    await page.keyboard.press("Control+g"); await expect(page.getByRole("treeitem")).toHaveCount(2);
    await page.getByRole("treeitem").first().getByRole("button", { name: "▱ グループ", exact: true }).focus();
    await page.keyboard.press("Control+Shift+g"); await expect(page.getByRole("treeitem")).toHaveCount(1);
    const separator = page.getByRole("separator", { name: "leftWidth サイズ変更", exact: true });
    await separator.focus(); await separator.press("ArrowRight");
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("vfxcraft.editor.layout")!).leftWidth)).toBe(260);
    await page.screenshot({ path: info.outputPath("responsive-editor.png"), fullPage: true });
});

test("不正な共通設定・保存失敗・破損復元で起動と操作を維持する", async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem("vfxcraft.editor.layout", "broken json");
        localStorage.setItem("vfxcraft.editor.shortcuts", JSON.stringify({ save: ["Ctrl+W"] }));
        Storage.prototype.setItem = () => { throw new DOMException("検証用の容量不足", "QuotaExceededError"); }; // 共通設定の書込失敗を注入
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "＋ 新規プロジェクトを作成", exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("共通設定を保存できませんでした");
    await page.evaluate(async () => {
        await new Promise<void>((resolve, reject) => {
            const request = indexedDB.open("vfxcraft-project-recovery");
            request.onupgradeneeded = () => request.result.createObjectStore("snapshots", { keyPath: "id" });
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const db = request.result, transaction = db.transaction("snapshots", "readwrite");
                transaction.objectStore("snapshots").put({ id: "bad", name: "破損した復元候補", savedAt: Date.now(), archive: new Blob(["broken"]) });
                transaction.oncomplete = () => { db.close(); resolve(); };
                transaction.onerror = () => { db.close(); reject(transaction.error); };
            };
        });
    });
    await page.reload();
    await expect(page.getByText(/破損した復元候補/)).toBeVisible();
    await page.getByRole("button", { name: "作業を復元", exact: true }).click();
    await expect(page.getByRole("status")).not.toContainText("共通設定を保存できませんでした");
    await expect(page.getByRole("button", { name: "＋ 新規プロジェクトを作成", exact: true })).toBeVisible();
});

test("再生中の数値連続入力もAuto Key一個・Undo一回へまとめる", async ({ page }) => {
    await create(page);
    await page.getByLabel("Auto Key", { exact: true }).check();
    await page.getByRole("button", { name: "再生", exact: true }).click();
    const input = page.getByLabel("初速度", { exact: true });
    await input.fill("20");
    const first = await page.getByLabel("現在時刻", { exact: true }).textContent();
    await expect(page.getByLabel("現在時刻", { exact: true })).not.toHaveText(first!);
    await input.fill("30"); await input.press("Enter");
    await page.getByRole("button", { name: "一時停止", exact: true }).click();
    await expect(page.getByLabel(/新しい粒子 初速度 キー/)).toHaveCount(1);
    await page.getByRole("button", { name: "↶ Undo", exact: true }).click();
    await expect(page.getByLabel(/新しい粒子 初速度 キー/)).toHaveCount(0);
});

test("PNG・JPEG・WebPの素材取り込みとテクスチャ参照を保存往復する", async ({ page }, info) => {
    await create(page);
    await page.getByRole("button", { name: "素材", exact: true }).click();
    for (const type of ["image/png", "image/jpeg", "image/webp"]) {
        const bytes = await page.evaluate(async (type) => {
            const canvas = document.createElement("canvas"); canvas.width = canvas.height = 4;
            const context = canvas.getContext("2d")!; context.fillStyle = "#9867ff"; context.fillRect(0, 0, 4, 4);
            const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), type));
            return [...new Uint8Array(await blob.arrayBuffer())];
        }, type);
        const name = type.split("/")[1] + ".image";
        await page.getByLabel("画像をインポート", { exact: true }).setInputFiles({ name, mimeType: "application/octet-stream", buffer: Buffer.from(bytes) });
        await expect(page.locator(".asset-grid").getByRole("button", { name, exact: true })).toBeVisible();
    }
    await page.getByRole("navigation").getByRole("button", { name: "エディタ", exact: true }).click();
    await page.getByLabel("テクスチャ", { exact: true }).selectOption({ label: "png.image" });
    await page.getByLabel("ダウンロード方式", { exact: true }).check();
    const download = page.waitForEvent("download"); await page.getByRole("button", { name: "保存", exact: true }).click();
    const file = await download, path = info.outputPath("images.vcr"); await file.saveAs(path);
    await page.getByRole("button", { name: "保存完了を確認", exact: true }).click();
    await page.reload(); await page.getByLabel("プロジェクトファイル", { exact: true }).setInputFiles(path);
    await expect(page.getByLabel("テクスチャ", { exact: true }).locator("option:checked")).toHaveText("png.image");
    await page.getByRole("button", { name: "素材", exact: true }).click();
    await expect(page.locator(".asset-grid").getByRole("button")).toHaveCount(3);
});
