import { test, expect, type Page } from "@playwright/test";

////////////////////
// すべてPlaywrightの使い捨てコンテキスト内で実行し、利用者のDBは触らない。
async function create(page: Page, mode = "2D") {
    await page.goto("/");
    await page.getByRole("button", { name: "＋ 新規プロジェクトを作成", exact: true }).click();
    await page.getByRole("button", { name: mode + "エフェクト", exact: true }).click();
    await page.getByRole("button", { name: "作成する", exact: true }).click();
    await expect(page.getByLabel("エフェクトプレビュー")).toBeVisible({ timeout: 30_000 });
}

////////////////////
// 件数は実DBから確認し、タイマーの固定待機で成否を推測しない。
async function count(page: Page) {
    return page.evaluate(async () => {
        const path = "/src/app/editor/recovery.ts", recovery = await import(path);
        return (await recovery.listRecovery()).length as number;
    });
}

test.beforeEach(async ({ page }) => { page.on("dialog", (dialog) => void dialog.accept()); });

for (const mode of ["2D", "3D"]) test(`T11 ${mode}: 正式UIで画像・階層・キーを保存し復元する`, async ({ page }, info) => {
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await create(page, mode);
    await page.getByRole("button", { name: "子を追加", exact: true }).click();
    await expect(page.getByRole("treeitem")).toHaveCount(2);
    await page.getByLabel("Auto Key", { exact: true }).check();
    const speed = page.getByLabel("初速度", { exact: true }); await speed.fill("42"); await speed.press("Enter");
    await page.getByRole("button", { name: "素材", exact: true }).click();
    const bytes = await page.evaluate(async () => {
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 16;
        const context = canvas.getContext("2d")!; context.fillStyle = "#aa88ff"; context.fillRect(0, 0, 16, 16);
        const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!)));
        return [...new Uint8Array(await blob.arrayBuffer())];
    });
    await page.getByLabel("画像をインポート", { exact: true }).setInputFiles({ name: "t11.png", mimeType: "image/png", buffer: Buffer.from(bytes) });
    await expect(page.locator(".asset-grid").getByRole("button")).toHaveCount(1);
    await page.getByRole("navigation").getByRole("button", { name: "エディタ", exact: true }).click();
    await page.getByLabel("テクスチャ", { exact: true }).selectOption({ label: "t11.png" });
    await expect(page.getByTestId("autosave-state")).toContainText("自動保存済み", { timeout: 30_000 });
    await page.getByLabel("ダウンロード方式", { exact: true }).check();
    const downloaded = page.waitForEvent("download"); await page.getByRole("button", { name: "保存", exact: true }).click();
    const file = await downloaded, path = info.outputPath("t11-" + mode + ".vcr"); await file.saveAs(path);
    await expect(page.locator(".editor-toolbar")).toContainText("*");
    await page.getByRole("button", { name: "保存完了を確認", exact: true }).click();
    await expect(page.locator(".editor-toolbar")).not.toContainText("*");
    await page.reload();
    await page.getByRole("button", { name: "作業を復元", exact: true }).first().click();
    await expect(page.getByRole("treeitem")).toHaveCount(2);
    await page.getByLabel("Auto Key", { exact: true }).check(); // 復元では操作状態はOFF。評価値を見るため明示的にON
    await expect(speed).toHaveValue("42"); await expect(page.locator(".editor-toolbar")).toContainText("*");
    await page.getByLabel("プロジェクトファイル", { exact: true }).setInputFiles(path);
    await page.getByRole("button", { name: "保存せず開く", exact: true }).click();
    await expect(page.locator(".editor-toolbar")).not.toContainText("*"); // 旧文書の表示を読込成功と取り違えない
    await expect(page.getByRole("treeitem")).toHaveCount(2);
    await page.getByLabel("Auto Key", { exact: true }).check();
    await expect(speed).toHaveValue("42");
    await expect(page.getByLabel("テクスチャ", { exact: true }).locator("option:checked")).toHaveText("t11.png");
    await page.screenshot({ path: info.outputPath("t11-restored.png"), fullPage: true });
    expect(errors).toEqual([]);
});

test("T11 UI操作・選択・無変更で世代を増やさず、Undo/Redo後は保存する", async ({ page }) => {
    await create(page); await expect.poll(() => count(page)).toBe(1);
    await page.getByRole("button", { name: "再生", exact: true }).click();
    await page.waitForTimeout(2300); await page.getByRole("button", { name: "一時停止", exact: true }).click();
    expect(await count(page)).toBe(1);
    const speed = page.getByLabel("初速度", { exact: true }); await speed.fill("42"); await speed.press("Enter");
    await expect.poll(() => count(page), { timeout: 15000 }).toBe(2);
    await page.getByRole("button", { name: "↶ Undo", exact: true }).click();
    await expect.poll(() => count(page), { timeout: 15000 }).toBe(3);
    await page.getByRole("button", { name: "↷ Redo", exact: true }).click();
    await expect.poll(() => count(page), { timeout: 15000 }).toBe(4);
});

test("T11 容量不足・トランザクション中断でも正常世代を保持し再試行する", async ({ page }) => {
    await create(page); await expect.poll(() => count(page)).toBe(1);
    for (const fault of ["quota", "abort"]) {
        await page.evaluate((fault) => {
            const original = IDBObjectStore.prototype.add;
            IDBObjectStore.prototype.add = function (...args: Parameters<IDBObjectStore["add"]>) {
                if (this.name === "generations") {
                    if (fault === "quota") throw new DOMException("test-only capacity", "QuotaExceededError");
                    this.transaction.abort();
                }
                return original.apply(this, args);
            };
            (window as unknown as { restoreIDB: () => void }).restoreIDB = () => { IDBObjectStore.prototype.add = original; };
        }, fault);
        const before = await count(page), speed = page.getByLabel("初速度", { exact: true });
        await speed.fill(fault === "quota" ? "42" : "43"); await speed.press("Enter");
        await expect(page.getByTestId("autosave-state")).toHaveText("自動保存失敗", { timeout: 15000 });
        expect(await count(page)).toBe(before); await expect(speed).toHaveValue(fault === "quota" ? "42" : "43");
        await page.evaluate(() => (window as unknown as { restoreIDB: () => void }).restoreIDB());
        await page.getByRole("button", { name: "自動保存を再試行", exact: true }).click();
        await expect.poll(() => count(page)).toBe(before + 1);
    }
});

test("T11 メタデータ破損を隔離し、破損ZIPの選択でも現在文書を保持", async ({ page }) => {
    await create(page); await expect.poll(() => count(page)).toBe(1);
    await page.evaluate(async () => {
        await new Promise<void>((resolve, reject) => {
            const request = indexedDB.open("vfxcraft-project-recovery");
            request.onsuccess = () => {
                const db = request.result, transaction = db.transaction("snapshots", "readwrite"), store = transaction.objectStore("snapshots");
                store.put({ id: "invalid-metadata", savedAt: "bad" });
                store.put({ id: "invalid-zip", name: "壊れたZIP", savedAt: Date.now() + 10000, archive: new Blob(["broken"]) });
                transaction.oncomplete = () => { db.close(); resolve(); }; transaction.onerror = () => reject(transaction.error);
            };
        });
    });
    await page.reload(); await expect(page.getByRole("status")).toContainText("1件の復元候補情報が破損");
    await page.getByRole("button", { name: "作業を復元", exact: true }).nth(1).click();
    await expect(page.getByRole("treeitem")).toHaveCount(1);
    await page.getByRole("button", { name: "⌂ ホーム", exact: true }).click();
    await page.getByRole("button", { name: "作業を復元", exact: true }).first().click();
    await expect(page.locator(".app-notice")).toBeVisible();
    await page.getByRole("navigation").getByRole("button", { name: "エディタ", exact: true }).click();
    await expect(page.getByRole("treeitem")).toHaveCount(1); await expect(page.getByLabel("初速度", { exact: true })).toHaveValue("80");
});

test("T11 v1の既存DBを非破壊更新して候補を復元", async ({ page }) => {
    await page.goto("/?technical-review");
    await page.evaluate(async () => {
        const factoryPath = "/src/app/editor/projectFactory.ts", flowPath = "/src/app/projectFiles/projectFileFlow.ts", archivePath = "/src/core/persistence/vcrArchive.ts";
        const { newEditorProject } = await import(factoryPath), { ProjectFileFlow } = await import(flowPath), { REVIEW_VCR_LIMITS } = await import(archivePath);
        const project = newEditorProject("2d", "basic", "T10旧候補"), flow = new ProjectFileFlow(project, REVIEW_VCR_LIMITS, async () => {}, "test");
        const path = "/src/app/editor/recovery.ts", { recoverySnapshot } = await import(path), entry = await recoverySnapshot(flow, async () => {});
        await new Promise<void>((resolve, reject) => {
            const request = indexedDB.open("vfxcraft-project-recovery", 1);
            request.onupgradeneeded = () => request.result.createObjectStore("snapshots", { keyPath: "id" });
            request.onerror = () => reject(request.error);
            request.onsuccess = () => { const db = request.result, tx = db.transaction("snapshots", "readwrite"); tx.objectStore("snapshots").add({ id: project.id, name: project.name, savedAt: Date.now(), archive: entry.archive }); tx.oncomplete = () => { db.close(); resolve(); }; };
        });
    });
    await page.goto("/"); await expect(page.getByText(/T10旧候補 — 旧候補/)).toBeVisible();
    await page.getByRole("button", { name: "作業を復元", exact: true }).click();
    await expect(page.getByRole("treeitem")).toHaveCount(1); await expect(page.locator(".editor-toolbar")).toContainText("T10旧候補 *");
});

test("T11 同一プロジェクトを二タブで保存しても候補を上書きしない", async ({ page, context }) => {
    await create(page); await expect.poll(() => count(page)).toBe(1);
    const other = await context.newPage(); other.on("dialog", (dialog) => void dialog.accept());
    await other.goto("/"); await other.getByRole("button", { name: "作業を復元", exact: true }).first().click();
    const speed = other.getByLabel("初速度", { exact: true }); await speed.fill("99"); await speed.press("Enter");
    await expect.poll(() => count(other), { timeout: 15000 }).toBeGreaterThanOrEqual(2);
    const original = page.getByLabel("初速度", { exact: true }); await original.fill("33"); await original.press("Enter");
    await expect.poll(() => count(page), { timeout: 15000 }).toBeGreaterThanOrEqual(3);
    const result = await page.evaluate(async () => {
        const path = "/src/app/editor/recovery.ts", { listRecovery, readRecovery } = await import(path);
        const entries = await listRecovery(), projects = await Promise.all(entries.map((entry: unknown) => readRecovery(entry, async () => {})));
        return { sessions: [...new Set(entries.map((entry: { sessionId: string }) => entry.sessionId))].length,
            speeds: projects.map((data: { project: { emitters: { particle2d: { speed: number } }[] } }) => data.project.emitters[0].particle2d.speed) };
    });
    expect(result.sessions).toBe(2); expect(result.speeds).toContain(33); expect(result.speeds).toContain(99); expect(result.speeds).toContain(80);
    await other.close();
});

test("T11 DB更新が別タブに阻まれても起動し、解放後に再試行できる", async ({ page, context }) => {
    const blocking = await context.newPage();
    await blocking.goto("/?technical-review");
    await blocking.evaluate(async () => {
        await new Promise<void>((resolve, reject) => {
            const request = indexedDB.open("vfxcraft-project-recovery", 1);
            request.onupgradeneeded = () => request.result.createObjectStore("snapshots", { keyPath: "id" });
            request.onerror = () => reject(request.error);
            request.onsuccess = () => { (window as unknown as { blockedDatabase: IDBDatabase }).blockedDatabase = request.result; resolve(); };
        });
    });
    await page.goto("/");
    await expect(page.getByRole("status")).toContainText("他のタブで保留");
    await expect(page.getByRole("button", { name: "＋ 新規プロジェクトを作成", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "復元候補を更新", exact: true }).click();
    await expect(page.getByRole("button", { name: "復元候補を更新", exact: true })).toBeEnabled(); // ブロック継続中の再試行も待ち続けない
    await blocking.evaluate(() => (window as unknown as { blockedDatabase: IDBDatabase }).blockedDatabase.close());
    await page.getByRole("button", { name: "復元候補を更新", exact: true }).click();
    await create(page); await expect.poll(() => count(page), { timeout: 15000 }).toBe(1);
    await blocking.close();
});

test("T11 切替前のflushと、保存済み/編集途中/Undoの離脱警告条件", async ({ page }) => {
    await create(page);
    await page.getByLabel("ダウンロード方式", { exact: true }).check();
    const downloaded = page.waitForEvent("download"); await page.getByRole("button", { name: "保存", exact: true }).click(); await downloaded;
    await page.getByRole("button", { name: "保存完了を確認", exact: true }).click();
    const warn = () => page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })));
    expect(await warn()).toBe(false);
    const speed = page.getByLabel("初速度", { exact: true }); await speed.fill("44");
    expect(await warn()).toBe(true); await speed.press("Escape"); expect(await warn()).toBe(false);
    await speed.fill("45"); await speed.press("Enter"); expect(await warn()).toBe(true);
    await page.getByRole("button", { name: "↶ Undo", exact: true }).click(); expect(await warn()).toBe(false);
    await page.getByRole("button", { name: "↷ Redo", exact: true }).click();
    await page.getByRole("button", { name: "⌂ ホーム", exact: true }).click();
    await page.getByRole("button", { name: "＋ 新規プロジェクトを作成", exact: true }).click();
    await page.getByRole("button", { name: "作成する", exact: true }).click();
    await page.getByRole("button", { name: "保存せず続行", exact: true }).click();
    await expect(page.getByLabel("初速度", { exact: true })).toHaveValue("80");
    const speeds = await page.evaluate(async () => {
        const path = "/src/app/editor/recovery.ts", { listRecovery, readRecovery } = await import(path);
        return Promise.all((await listRecovery()).map(async (entry: unknown) => (await readRecovery(entry, async () => {})).project.emitters[0].particle2d.speed));
    });
    expect(speeds).toContain(45);
});
