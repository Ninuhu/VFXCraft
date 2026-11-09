import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { BlobReader, BlobWriter, ZipWriter } from "@zip.js/zip.js";
import { createProject } from "../src/core/document/createProject.ts";
import { readVcr, writeVcr, REVIEW_VCR_LIMITS } from "../src/core/persistence/vcrArchive.ts";
import { ProjectFileFlow } from "../src/app/projectFiles/projectFileFlow.ts";

const ID = "10000000-0000-4000-8000-000000000001"; // プロジェクトID
const ASSET = { id: "20000000-0000-4000-8000-000000000001", name: "pixel.png", mediaType: "image/png", width: 1, height: 1 }; // 未使用画像
const PNG = new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMIqDjxHwAFPAKQ8H9qXAAAAABJRU5ErkJggg==", "base64")]); // 固定の画像検体
const LIMITS = REVIEW_VCR_LIMITS; // テスト用ポリシー
const VERSION = "0.0.0"; // 検体の生成版

////////////////////
// NodeではPNGヘッダーの寸法を確認し、ブラウザのデコード経路は別に検証する
async function verify(blob, asset) {
    const header = new DataView(await blob.slice(0, 24).arrayBuffer()); // PNGのIHDRまで
    assert.equal(header.getUint32(16), asset.width);
    assert.equal(header.getUint32(20), asset.height);
}

////////////////////
// 両モードの小さな有効文書を生成する
function project(mode = "2d") {
    return createProject({ id: ID, name: "Test", mode, durationUs: 100,
        ...(mode === "2d" ? { drawing: "pixel", canvasWidth: 64, canvasHeight: 64 } : {}) });
}

////////////////////
// フローに未使用画像を1件追加する
function addImage(flow) {
    flow.history.execute({ kind: "asset.add", asset: ASSET });
    flow.rememberImage(ASSET.id, PNG);
}

////////////////////
// 書込状態を観測可能な保存先を返す
function target() {
    const files = []; // 確定書き込みの記録
    return { files, async write(file) { files.push(file); } };
}

////////////////////
// 手製の異常コンテナをzip.jsの公開APIで作る
async function zip(entries, options = {}) {
    const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false, level: 0, ...options }); // テスト用ZIP
    for (const [name, value] of entries) {
        await writer.add(name, new BlobReader(new Blob([JSON.stringify(value)])));
    }
    return writer.close();
}

const metadata = { format: "VFXCraft", containerVersion: 1, createdByVersion: VERSION }; // 正常なコンテナ識別子

test("固定の初版2D・3Dファイルを読み込んで再保存できる", async () => {
    for (const mode of ["2d", "3d"]) {
        const fixed = await readFile(new URL("./fixtures/vcr/t04-" + mode + "-v1.vcr", import.meta.url)); // 永続的な互換性検体
        const loaded = await readVcr(new Blob([fixed]), LIMITS, verify); // v1の読み込み結果
        assert.equal(loaded.project.mode, mode);
        assert.deepEqual(loaded.project.assets, [ASSET]);
        const written = await writeVcr(loaded, LIMITS, verify, VERSION); // 現行コードの書き出し
        const reopened = await readVcr(written, LIMITS, verify); // 再読込の結果
        assert.deepEqual(reopened.project, loaded.project);
        assert.deepEqual(await reopened.images.get(ASSET.id).arrayBuffer(), await PNG.arrayBuffer());
    }
});

test("素材の欠損と画像の実形式違いを拒否し、未使用素材は同梱する", async () => {
    const doc = { ...project(), assets: [ASSET] }; // 未使用画像を持つ文書
    await assert.rejects(writeVcr({ project: doc, images: new Map() }, LIMITS, verify, VERSION), /素材/);
    await assert.rejects(writeVcr({ project: doc, images: new Map([[ASSET.id, new Blob(["text"])]]) }, LIMITS, verify, VERSION), /画像/);
    const file = await writeVcr({ project: doc, images: new Map([[ASSET.id, PNG]]) }, LIMITS, verify, VERSION); // 完全なZIP
    assert.equal((await readVcr(file, LIMITS, verify)).images.size, 1);
    await assert.rejects(readVcr(await zip([["metadata.json", metadata], ["project.json", doc]]), LIMITS, verify), /素材/);
});

test("破損・未知コンテナ版・未知スキーマ版・暗号化・不正パス・容量超過を拒否する", async () => {
    const doc = project(); // 有効な論理文書
    const good = await zip([["metadata.json", metadata], ["project.json", doc]]); // 正常なZIP
    const crcDamaged = new Uint8Array(await good.arrayBuffer()); // データだけを書き換える
    const offset = Buffer.from(crcDamaged).indexOf(Buffer.from("VFXCraft")); // メタデータ内の識別子
    assert.ok(offset > 0);
    crcDamaged[offset] ^= 1;
    await assert.rejects(readVcr(new Blob([crcDamaged]), LIMITS, verify), /signature|CRC/i);
    await assert.rejects(readVcr(good.slice(0, -8), LIMITS, verify));
    await assert.rejects(readVcr(await zip([["metadata.json", { ...metadata, containerVersion: 2 }], ["project.json", doc]]), LIMITS, verify), /コンテナ版/);
    await assert.rejects(readVcr(await zip([["metadata.json", metadata], ["project.json", { ...doc, schemaVersion: 6 }]]), LIMITS, verify), /スキーマ版/);
    await assert.rejects(readVcr(await zip([["metadata.json", metadata], ["project.json", doc]], { password: "test" }), LIMITS, verify));
    await assert.rejects(readVcr(await zip([["metadata.json", metadata], ["project.json", doc], ["other.json", {}]]), LIMITS, verify), /エントリ/);
    const duplicate = Buffer.from(await (await zip([["metadata.json", metadata], ["project.json", doc], ["another.json", {}]])).arrayBuffer()); // 正常ZIPを重複名に改変
    for (let position = duplicate.indexOf("another.json"); position !== -1; position = duplicate.indexOf("another.json", position + 12)) {
        duplicate.write("project.json", position, "ascii");
    }
    await assert.rejects(readVcr(new Blob([duplicate]), LIMITS, verify), /重複|duplicat/i);
    const traversal = Buffer.from(await (await zip([["metadata.json", metadata], ["project.json", doc], ["another.json", {}]])).arrayBuffer()); // パストラバーサル用
    for (let position = traversal.indexOf("another.json"); position !== -1; position = traversal.indexOf("another.json", position + 12)) {
        traversal.write("../evil.json", position, "ascii");
    }
    await assert.rejects(readVcr(new Blob([traversal]), LIMITS, verify), /エントリ|filename|path/i);
    for (const limit of [{ entryCount: 1 }, { totalBytes: 120 }, { entryBytes: 20 }, { archiveBytes: 20 }, { jsonBytes: 20 }]) {
        await assert.rejects(readVcr(good, { ...LIMITS, ...limit }, verify), /上限/);
    }
});

test("保存中の追加編集は未保存で、通常保存では同じ保存先を再利用する", async () => {
    const flow = new ProjectFileFlow(project(), LIMITS, verify, VERSION); // 未保存のセッション
    const disk = target(); // 上書き先
    const route = { kind: "overwrite", async getTarget() { addImage(flow); return disk; } }; // 保存開始直後の追加編集
    assert.equal(await flow.save(route), true);
    assert.equal(flow.history.isSaved, false);
    assert.equal((await readVcr(disk.files[0], LIMITS, verify)).images.size, 0);
    assert.equal(await flow.save({ kind: "overwrite", getTarget() { assert.fail("既存先を使う"); } }), true);
    assert.equal(flow.history.isSaved, true);
    assert.equal((await readVcr(disk.files[1], LIMITS, verify)).images.size, 1);
});

test("未保存で開く三択とダウンロードの確認を扱い、失敗で編集を保持する", async () => {
    const flow = new ProjectFileFlow(project(), LIMITS, verify, VERSION); // 未保存のセッション
    addImage(flow);
    const before = flow.history.snapshot; // 切替前の編集
    const next = await writeVcr({ project: project("3d"), images: new Map() }, LIMITS, verify, VERSION); // 次に開く文書
    let downloads = 0; // ダウンロード開始回数
    const download = { kind: "download", download() { downloads++; assert.equal(flow.history.isSaved, false); },
        async confirm() { assert.equal(flow.history.snapshot, before); return false; } }; // 利用者による取消
    assert.equal(await flow.open(next, undefined, "cancel"), "cancelled");
    assert.equal(downloads, 0);
    assert.equal(await flow.open(next, undefined, "save", download), "cancelled");
    assert.equal(flow.history.snapshot, before);
    assert.equal(flow.history.isSaved, false);
    await assert.rejects(flow.open(new Blob(["invalid"]), undefined, "discard"));
    assert.equal(flow.history.snapshot, before);
    await assert.rejects(flow.open(next, undefined, "save", { kind: "overwrite", async getTarget() {
        return { async write() { throw new Error("disk failure"); } };
    } }), /disk failure/);
    assert.equal(flow.history.snapshot, before);
    assert.equal(await flow.open(next, undefined, "save", { ...download, async confirm() {
        assert.equal(flow.history.snapshot, before);
        return true;
    } }), "opened");
    assert.equal(flow.history.snapshot.project.mode, "3d");
    assert.equal(flow.history.isSaved, true);
    assert.equal(flow.history.canUndo, false);
});

test("UndoとRedoが参照するBlobを回収せず、確認済みの通常ダウンロードを保存済みにする", async () => {
    const flow = new ProjectFileFlow(project(), LIMITS, verify, VERSION); // 素材の寿命を確認するセッション
    addImage(flow);
    flow.history.undo();
    flow.collectImages();
    flow.history.redo();
    let saved; // 確認前のダウンロードファイル
    const route = { kind: "download", download(file) { saved = file; }, async confirm() {
        assert.equal(flow.history.isSaved, false);
        return true;
    } }; // 利用者確認をシミュレート
    assert.equal(await flow.save(route), true);
    assert.equal(flow.history.isSaved, true);
    assert.equal((await readVcr(saved, LIMITS, verify)).images.size, 1);
});
