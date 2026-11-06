import assert from "node:assert/strict";
import { test } from "node:test";
import { createProject } from "../src/core/document/createProject.ts";
import { DocumentValidationError } from "../src/core/document/validateDocument.ts";
import { EditingHistory } from "../src/core/editing/history.ts";

const PROJECT_ID = "10000000-0000-4000-8000-000000000001"; // プロジェクトの識別子
const LAYER_ID = "10000000-0000-4000-8000-00000000000a"; // 操作対象のレイヤー
const CHILD_ID = "10000000-0000-4000-8000-000000000003"; // 親子操作用レイヤー
const MATERIAL_ID = "10000000-0000-4000-8000-000000000004"; // 素材参照を持つ材質
const ASSET_ID = "10000000-0000-4000-8000-00000000000b"; // 参照先の素材
const asset = { id: ASSET_ID, name: "Texture", mediaType: "image/png", width: 32, height: 32 }; // 画像のメタデータ
const keyTarget = { layerId: LAYER_ID, property: "opacity" }; // キー編集の対象

////////////////////
// 代表的な編集対象を持つプロジェクトを用意する
function fixture(mode = "2d") {
    const project = createProject({ id: PROJECT_ID, name: "Project", durationUs: 1000, mode,
        ...(mode === "2d" ? { drawing: "normal", canvasWidth: 64, canvasHeight: 64 } : {}) }); // 基礎文書
    const values = mode === "2d" ? { position: [0, 0], rotation: 0, size: [1, 1] }
        : { position: [0, 0, 0], rotation: [2, 17, 53, 81], size: [1, 1, 1] }; // モードに応じた基準値
    return { ...project, layers: [{ id: LAYER_ID, name: "Root", order: 0, parentId: null,
        isVisible: true, isLocked: false, startUs: 0, values: { ...values, color: [1, 1, 1], opacity: 1 },
        content: { kind: "group" } }],
    materials: [{ id: MATERIAL_ID, textureAssetId: null, blend: "alpha", color: [1, 1, 1], hasBloom: false, gradient: [] }] };
}

////////////////////
// 履歴を識別できる連続したレイヤー名の変更を作る
function rename(name) {
    return { kind: "layer.update", layerId: LAYER_ID, patch: { name } };
}

////////////////////
// 2Dレイヤーの位置を変更するコマンドを作る
function move(x, y) {
    return { kind: "layer.update", layerId: LAYER_ID, patch: { values: { position: [x, y] } } };
}

test("レイヤー追加・親子変更・パラメータ変更・削除を共通経路で適用する", () => {
    const history = new EditingHistory(fixture()); // 編集セッション
    const child = { ...history.preview.layers[0], id: CHILD_ID, name: "Child", order: 1 }; // 追加レイヤー
    assert.equal(history.execute({ kind: "layer.add", layer: child }), true);
    assert.equal(history.execute({ kind: "layer.reparent", layerId: CHILD_ID, parentId: LAYER_ID.toUpperCase() }), true);
    assert.equal(history.preview.layers[1].parentId, LAYER_ID.toUpperCase());
    assert.equal(history.execute(move(8, 12)), true);
    assert.deepEqual(history.preview.layers[0].values.position, [8, 12]);
    assert.throws(() => history.execute({ kind: "layer.remove", layerId: LAYER_ID }), DocumentValidationError);
    history.execute({ kind: "key.add", layerId: CHILD_ID, property: "opacity", key: { offsetUs: 0, value: 0 } });
    history.execute({ kind: "layer.remove", layerId: CHILD_ID });
    assert.equal(history.preview.layers.length, 1);
    assert.equal(history.preview.tracks.length, 0);
    assert.equal(history.undo(), true);
    assert.equal(history.preview.tracks[0].layerId, CHILD_ID);
});

test("キーの追加・移動・変更・削除を検証し、時刻順と補間設定を保つ", () => {
    const history = new EditingHistory(fixture()); // 編集セッション
    history.execute({ kind: "key.add", ...keyTarget, interpolation: "step", key: { offsetUs: 200, value: 0.2 } });
    history.execute({ kind: "key.add", ...keyTarget, key: { offsetUs: 100, value: 0.4 } });
    assert.throws(() => history.execute({ kind: "key.add", ...keyTarget, key: { offsetUs: 100, value: 0.8 } }), DocumentValidationError);
    history.execute({ kind: "key.update", ...keyTarget, offsetUs: 200, key: { offsetUs: 50, value: 0.7 } });
    assert.deepEqual(history.preview.tracks[0].keys, [{ offsetUs: 50, value: 0.7 }, { offsetUs: 100, value: 0.4 }]);
    history.execute({ kind: "key.remove", ...keyTarget, offsetUs: 50 });
    assert.equal(history.preview.tracks[0].interpolation, "step");
    history.execute({ kind: "key.remove", ...keyTarget, offsetUs: 100 });
    assert.deepEqual(history.preview.tracks, []);
});

test("UndoとRedoは元のスナップショットを復元する", () => {
    const history = new EditingHistory(fixture()); // 編集セッション
    const initial = history.snapshot; // 初期位置
    history.execute(rename("Changed"));
    const changed = history.snapshot; // 編集後の位置
    assert.equal(history.undo(), true);
    assert.equal(history.snapshot, initial);
    assert.equal(history.undo(), false);
    assert.equal(history.redo(), true);
    assert.equal(history.snapshot, changed);
    assert.equal(history.redo(), false);
});

test("101件の編集で直近100件をUndo・Redoし、失われた保存位置に戻らない", () => {
    const history = new EditingHistory(fixture(), "loaded"); // 保存済みの初期位置
    for (let count = 1; count <= 101; count++) history.execute(rename(String(count)));
    for (let count = 100; count >= 1; count--) {
        assert.equal(history.undo(), true);
        assert.equal(history.preview.layers[0].name, String(count));
        assert.equal(history.isSaved, false);
    }
    assert.equal(history.undo(), false);
    for (let count = 2; count <= 101; count++) {
        assert.equal(history.redo(), true);
        assert.equal(history.preview.layers[0].name, String(count));
    }
    assert.equal(history.redo(), false);
    assert.equal(history.isSaved, false);
});

test("保存済み状態はUndo・Redoで復元し、分岐や偶然同じ値になった状態とは区別する", () => {
    const history = new EditingHistory(fixture()); // 編集セッション
    history.execute(rename("Saved"));
    const saved = history.snapshot; // 実際に保存した状態
    history.execute(rename("Other"));
    assert.equal(history.markSaved(saved), true);
    assert.equal(history.isSaved, false);
    history.undo();
    assert.equal(history.isSaved, true);
    history.redo();
    assert.equal(history.isSaved, false);
    history.undo();
    history.undo();
    assert.equal(history.isSaved, false);
    history.redo();
    assert.equal(history.isSaved, true);
    history.undo();
    history.execute(rename("Saved"));
    assert.deepEqual(history.snapshot.project, saved.project);
    assert.notEqual(history.snapshot.revision, saved.revision);
    assert.equal(history.canRedo, false);
    assert.equal(history.isSaved, false);
});

test("ドラッグの複数更新はプレビューだけを変え、確定時に1件になる", () => {
    const history = new EditingHistory(fixture(), "loaded"); // 保存済みセッション
    const original = history.snapshot; // ドラッグ開始前
    const token = history.beginContinuousEdit(); // ドラッグの識別子
    for (let x = 1; x <= 4; x++) assert.equal(history.updateContinuousEdit(token, move(x, x * 2)), true);
    assert.deepEqual(history.preview.layers[0].values.position, [4, 8]);
    assert.equal(history.snapshot, original);
    assert.equal(history.isSaved, true);
    assert.throws(() => history.execute(rename("Interruption")));
    assert.throws(() => history.beginContinuousEdit());
    assert.equal(history.commitContinuousEdit(token), true);
    assert.equal(history.isSaved, false);
    assert.equal(history.undo(), true);
    assert.equal(history.snapshot, original);
    assert.equal(history.canUndo, false);
    assert.throws(() => history.updateContinuousEdit(token, move(1, 1)));
});

test("数値入力の無効な途中値は確定を妨げ、有効な入力に戻ると1件として確定できる", () => {
    const history = new EditingHistory(fixture()); // 編集セッション
    const token = history.beginContinuousEdit(); // 数値入力の識別子
    assert.equal(history.updateContinuousEdit(token, move(3, 0)), true);
    assert.equal(history.updateContinuousEdit(token, move(NaN, 0)), false);
    assert.equal(history.commitContinuousEdit(token), false);
    assert.deepEqual(history.preview.layers[0].values.position, [3, 0]);
    assert.deepEqual(history.snapshot.project.layers[0].values.position, [0, 0]);
    assert.equal(history.updateContinuousEdit(token, move(30, 0)), true);
    assert.equal(history.commitContinuousEdit(token), true);
    assert.equal(history.undo(), true);
    assert.equal(history.canUndo, false);
    assert.equal(history.redo(), true);
    assert.deepEqual(history.preview.layers[0].values.position, [30, 0]);
});

test("連続編集の取消と無変更の確定ではRedoや保存位置が維持される", () => {
    const history = new EditingHistory(fixture(), "loaded"); // 初期位置が保存済み
    history.execute(rename("Other"));
    history.undo();
    const initial = history.snapshot; // 編集開始前の状態
    let token = history.beginContinuousEdit(); // 取消対象
    history.updateContinuousEdit(token, move(3, 0));
    history.cancelContinuousEdit(token);
    assert.equal(history.preview, initial.project);
    token = history.beginContinuousEdit();
    history.updateContinuousEdit(token, move(3, 0));
    history.updateContinuousEdit(token, move(0, 0));
    assert.equal(history.commitContinuousEdit(token), false);
    assert.equal(history.execute(rename("Root")), false);
    token = history.beginContinuousEdit();
    history.updateContinuousEdit(token, { kind: "key.add", ...keyTarget, key: { offsetUs: 0, value: 0 } });
    history.updateContinuousEdit(token, { kind: "key.remove", ...keyTarget, offsetUs: 0 });
    assert.equal(history.commitContinuousEdit(token), false);
    assert.equal(history.snapshot, initial);
    assert.equal(history.canRedo, true);
    assert.equal(history.isSaved, true);
});

test("無効な単発編集は現在の文書、Undo、Redoと保存位置を変えない", () => {
    const history = new EditingHistory(fixture()); // 編集セッション
    history.execute(rename("Saved"));
    history.markSaved(history.snapshot);
    history.execute(rename("Other"));
    history.undo();
    const saved = history.snapshot; // UndoとRedoの両方を持つ位置
    assert.throws(() => history.execute({ kind: "layer.reparent", layerId: LAYER_ID, parentId: LAYER_ID }), DocumentValidationError);
    assert.throws(() => history.execute({ kind: "material.setTexture", materialId: MATERIAL_ID, assetId: ASSET_ID }), DocumentValidationError);
    assert.throws(() => history.execute({ kind: "layer.update", layerId: LAYER_ID, patch: { id: CHILD_ID } }), DocumentValidationError);
    assert.equal(history.snapshot, saved);
    assert.equal(history.canUndo, true);
    assert.equal(history.canRedo, true);
    assert.equal(history.isSaved, true);
});

test("Quaternionの丸めと符号差は無変更とみなし、保存状態とUndoを維持する", () => {
    const history = new EditingHistory(fixture("3d"), "loaded"); // 再正規化で末尾が変わる姿勢
    const original = history.snapshot; // 保存済みの位置
    const rotation = original.project.layers[0].values.rotation; // 正規化済みの姿勢
    assert.equal(history.execute(rename("Root")), false);
    assert.equal(history.execute({ kind: "layer.update", layerId: LAYER_ID,
        patch: { values: { rotation: rotation.map((value) => -value) } } }), false);
    assert.equal(history.snapshot, original);
    history.execute(rename("Changed"));
    assert.equal(history.preview.layers[0].values.rotation, rotation);
    assert.equal(history.isSaved, false);
    history.undo();
    assert.equal(history.isSaved, true);
});

test("新規作成・読込は履歴を初期化し、失敗と前セッションの保存通知を隔離する", () => {
    const history = new EditingHistory(fixture()); // 編集セッション
    history.execute(rename("Old"));
    const old = history.snapshot; // 前セッションの保存候補
    assert.throws(() => history.replaceProject({}, "loaded"), DocumentValidationError);
    assert.equal(history.snapshot, old);
    assert.equal(history.canUndo, true);
    history.replaceProject({ ...fixture(), id: CHILD_ID }, "loaded");
    assert.equal(history.isSaved, true);
    assert.equal(history.markSaved(old), false);
    assert.equal(history.undo(), false);
    assert.equal(history.redo(), false);
    history.execute(rename("Another"));
    history.replaceProject(fixture(), "new");
    assert.equal(history.isSaved, false);
    assert.equal(history.undo(), false);
    assert.equal(history.redo(), false);
});

test("素材参照の設定・解除・削除を履歴化し、Undoでメタデータと参照を戻す", () => {
    const history = new EditingHistory(fixture()); // 編集セッション
    const setTexture = { kind: "material.setTexture", materialId: MATERIAL_ID }; // 同じ材質を編集
    history.execute({ kind: "asset.add", asset });
    history.execute({ ...setTexture, assetId: ASSET_ID.toUpperCase() });
    assert.equal(history.preview.materials[0].textureAssetId, ASSET_ID);
    history.execute({ ...setTexture, assetId: null });
    assert.equal(history.preview.materials[0].textureAssetId, null);
    history.undo();
    history.execute({ kind: "asset.remove", assetId: ASSET_ID });
    assert.equal(history.preview.assets.length, 0);
    assert.equal(history.preview.materials[0].textureAssetId, null);
    assert.deepEqual([...history.getRetainedAssetIds()], [ASSET_ID]);
    history.undo();
    assert.equal(history.preview.materials[0].textureAssetId, ASSET_ID);
    assert.deepEqual(history.preview.assets[0], asset);
    history.redo();
    for (let index = 0; index < 100; index++) history.execute(rename(String(index)));
    assert.equal(history.getRetainedAssetIds().has(ASSET_ID), false);
});

test("同じ素材IDを大文字小文字だけ変えて指定しても新しい編集にしない", () => {
    const project = fixture(); // 大文字で参照する既存文書
    project.assets.push(asset);
    project.materials[0].textureAssetId = ASSET_ID.toUpperCase();
    const history = new EditingHistory(project, "loaded"); // 保存済みセッション
    assert.equal(history.execute({ kind: "material.setTexture", materialId: MATERIAL_ID, assetId: ASSET_ID }), false);
    assert.equal(history.preview.materials[0].textureAssetId, ASSET_ID.toUpperCase());
    assert.equal(history.isSaved, true);
    assert.equal(history.canUndo, false);
});

test("100回の編集で画像本体は外部ストアの1個を共有し、素材メタデータも参照を共有する", () => {
    const history = new EditingHistory(fixture()); // 編集セッション
    const blob = new Blob([new Uint8Array(4 * 1024 * 1024)], { type: "image/png" }); // 4 MiBの素材本体
    const store = new Map([[ASSET_ID, blob]]); // 履歴から独立した素材ストア
    history.execute({ kind: "asset.add", asset });
    history.execute({ kind: "material.setTexture", materialId: MATERIAL_ID, assetId: ASSET_ID });
    const assets = history.preview.assets; // 全操作に共有されるメタデータ
    for (let index = 0; index < 100; index++) history.execute(rename(String(index)));
    for (let index = 0; index <= 100; index++) {
        assert.equal(history.preview.assets, assets);
        assert.equal(store.get(history.preview.materials[0].textureAssetId), blob);
        assert.deepEqual([...history.getRetainedAssetIds()], [ASSET_ID]);
        if (index < 100) assert.equal(history.undo(), true);
    }
    assert.equal(store.size, 1);
    assert.equal([...store.values()].reduce((bytes, entry) => bytes + entry.size, 0), blob.size);
});
