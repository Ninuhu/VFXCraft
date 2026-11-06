import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

test("ダウンロード確認後に固定の3Dプロジェクトを開く", async ({ page }) => {
    const fixture = fileURLToPath(new URL("../fixtures/vcr/t04-3d-v1.vcr", import.meta.url)); // 実画像付きの固定検体
    await page.goto("/?vcr-review");
    await expect(page.getByRole("heading", { name: "T04 .vcr 保存・読込検証" })).toBeVisible({ timeout: 20_000 });
    await page.getByLabel("ファイルから開く").setInputFiles(fixture);
    await page.getByRole("group", { name: "未保存変更の確認" }).getByLabel("ダウンロード方式").check();
    page.once("dialog", (dialog) => dialog.accept());
    const download = page.waitForEvent("download"); // 保存開始のブラウザイベント
    await page.getByRole("button", { name: "保存して開く", exact: true }).click();
    expect((await download).suggestedFilename()).toBe("T04 sample.vcr");
    await expect(page.getByText("Test（3d） / 保存済み")).toBeVisible();
    await expect(page.getByText("pixel.png (1×1)")).toBeVisible();
});
