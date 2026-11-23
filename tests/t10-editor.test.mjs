import test from "node:test";
import assert from "node:assert/strict";
import { newEditorProject } from "../src/app/editor/projectFactory.ts";
import { EMPTY_SELECTION, firstLayerSelection, selectLayer, pruneSelection } from "../src/app/editor/selection.ts";
import { DEFAULT_LAYOUT, parseLayout } from "../src/app/editor/preferences.ts";
import { DEFAULT_SHORTCUTS, shortcutKey, canAssignShortcut, assignShortcut, parseShortcuts } from "../src/app/editor/shortcuts.ts";
import { propertyCommand } from "../src/app/editor/propertyEditing.ts";
import { transformCommand, displayedTransform } from "../src/app/editor/transformEditing.ts";
import { recoverySnapshot, readRecovery } from "../src/app/editor/recovery.ts";
import { EditingHistory } from "../src/core/editing/history.ts";
import { ProjectFileFlow } from "../src/app/projectFiles/projectFileFlow.ts";
import { REVIEW_VCR_LIMITS } from "../src/core/persistence/vcrArchive.ts";
import { validateProject } from "../src/core/document/validateDocument.ts";
import { advancePlaybackClock } from "../src/core/document/playback.ts";
import { groupLayerCommand, ungroupLayerCommand } from "../src/app/editor/grouping.ts";
import { importProjectImage } from "../src/app/projectFiles/projectImages.ts";

const fixture = () => newEditorProject("2d", "basic", "test"); // 外部素材なしの正常文書
const verify = async () => {}; // この検体は画像を持たない

for (const mode of ["2d", "3d"]) for (const template of ["empty", "basic", "sample"]) {
    test(`${mode} ${template}を独立した有効な文書として生成する`, () => {
        const first = newEditorProject(mode, template, "first"), second = newEditorProject(mode, template, "second");
        assert.equal(first.mode, mode); assert.equal(first.productionFps, 60);
        assert.equal(first.layers.length, template === "empty" ? 0 : template === "basic" ? 1 : 2);
        assert.notEqual(first.id, second.id);
        for (const layer of first.layers) assert.ok(!second.layers.some((item) => item.id === layer.id));
        assert.deepEqual(validateProject(JSON.parse(JSON.stringify(first))), first);
    });
}
test("単一・Ctrl追加解除・Shift可視範囲選択とアクティブ一層", () => {
    let selection = selectLayer(EMPTY_SELECTION, "b", ["a", "b", "c", "d"], false, false);
    selection = selectLayer(selection, "d", ["a", "b", "c", "d"], false, true);
    assert.deepEqual(selection.ids, ["b", "c", "d"]); assert.equal(selection.active, "d");
    selection = selectLayer(selection, "d", ["a", "b", "c", "d"], true, false);
    assert.deepEqual(selection.ids, ["b", "c"]); assert.equal(selection.active, "c");
    assert.deepEqual(pruneSelection(selection, ["b"]).ids, ["b"]);
});
test("折りたたみで見えないIDと削除済み選択を処理する", () => {
    assert.deepEqual(firstLayerSelection([]), EMPTY_SELECTION);
    assert.deepEqual(firstLayerSelection(["a", "b"]), { ids: ["a"], active: "a", anchor: "a" });
    assert.equal(selectLayer(EMPTY_SELECTION, "hidden", ["a"], false, false), EMPTY_SELECTION);
    assert.deepEqual(pruneSelection({ ids: ["a"], active: "a", anchor: "a" }, []), EMPTY_SELECTION);
});
test("パネル配置の欠損復旧・サイズ上下限・falseを維持する", () => {
    assert.deepEqual(parseLayout(null), DEFAULT_LAYOUT);
    const layout = parseLayout({ hierarchy: { visible: false, region: "right" }, leftWidth: Infinity, rightWidth: 1, bottomHeight: 99999 });
    assert.equal(layout.hierarchy.visible, false); assert.equal(layout.hierarchy.region, "right");
    assert.equal(layout.leftWidth, 250); assert.equal(layout.rightWidth, 240); assert.equal(layout.bottomHeight, 650);
    assert.deepEqual(parseLayout(JSON.parse(JSON.stringify(layout))), layout);
    layout.preview.visible = false; assert.equal(DEFAULT_LAYOUT.preview.visible, true);
});
test("ショートカットを正規化し、IME・修飾単体・予約キーを拒否する", () => {
    assert.equal(shortcutKey({ key: "d", ctrlKey: true, altKey: false, shiftKey: false }), "Ctrl+D");
    assert.equal(shortcutKey({ key: " ", ctrlKey: false, altKey: false, shiftKey: false }), "Space");
    assert.equal(shortcutKey({ key: "a", isComposing: true }), null);
    assert.equal(shortcutKey({ key: "Control" }), null);
    for (const key of ["Alt+F4", "Ctrl+W", "F5", "Ctrl+T"]) assert.equal(canAssignShortcut(key), false);
});
test("競合は確認前に変更せず、確認後に片方の割当だけ残す", () => {
    assert.throws(() => assignShortcut(DEFAULT_SHORTCUTS, "open", "Ctrl+S", false));
    const assigned = assignShortcut(DEFAULT_SHORTCUTS, "open", "Ctrl+S", true);
    assert.deepEqual(assigned.save, []); assert.deepEqual(assigned.open, ["Ctrl+S"]);
    assert.deepEqual(DEFAULT_SHORTCUTS.save, ["Ctrl+S"]);
    const parsed = parseShortcuts({ open: ["Ctrl+S"], save: ["Ctrl+S"] });
    assert.equal(Object.values(parsed).flat().filter((key) => key === "Ctrl+S").length, 1);
});
test("Auto Key OFFは基本値のみを変更し、既存キーを変更しない", () => {
    const history = new EditingHistory(fixture()), layer = history.preview.layers[0];
    history.execute(propertyCommand(history.preview, layer, "opacity", 0.5, 1e6, true));
    const track = history.preview.tracks[0];
    history.execute(propertyCommand(history.preview, history.preview.layers[0], "opacity", 0.2, 2e6, false));
    assert.equal(history.preview.layers[0].values.opacity, 0.2); assert.deepEqual(history.preview.tracks[0], track);
});
test("Auto Key ONは現在時刻へ追加・更新し、区間補間と基本値を維持する", () => {
    const history = new EditingHistory(fixture());
    history.execute({ kind: "key.add", layerId: history.preview.layers[0].id, property: "speed", key: { offsetUs: 1e6, value: 2, interpolation: "step" } });
    history.execute(propertyCommand(history.preview, history.preview.layers[0], "speed", 3, 1e6, true));
    assert.equal(history.preview.tracks[0].keys.length, 1); assert.equal(history.preview.tracks[0].keys[0].interpolation, "step");
    assert.equal(history.preview.emitters[0].particle2d.speed, 80);
    history.undo(); assert.equal(history.preview.tracks[0].keys[0].value, 2); history.redo(); assert.equal(history.preview.tracks[0].keys[0].value, 3);
});
test("アニメーション対象の各設定を基本値とキーの両方へ接続する", () => {
    const values = { rate: 70, lifetimeUs: 800000, speed: 30, direction: 90, acceleration: [0, 20], materialColor: [1, 0, 0], materialOpacity: 0.5, bloomStrength: 2, opacity: 0.6 };
    for (const [property, value] of Object.entries(values)) {
        const history = new EditingHistory(fixture());
        history.execute(propertyCommand(history.preview, history.preview.layers[0], property, value, 1e6, false));
        history.execute(propertyCommand(history.preview, history.preview.layers[0], property, value, 1e6, true));
        assert.deepEqual(history.preview.tracks[0].keys[0].value, value);
    }
});
test("Auto Keyで負の相対時刻、不正値、ロックを拒否して文書を保持する", () => {
    const history = new EditingHistory(fixture()), id = history.preview.layers[0].id;
    history.execute({ kind: "layer.update", layerId: id, patch: { startUs: 1e6 } });
    const before = history.snapshot;
    assert.throws(() => history.execute(propertyCommand(history.preview, history.preview.layers[0], "opacity", 0.5, 0, true)));
    assert.throws(() => history.execute(propertyCommand(history.preview, history.preview.layers[0], "opacity", NaN, 1e6, true)));
    assert.equal(history.snapshot, before);
    history.execute({ kind: "layer.update", layerId: id, patch: { isLocked: true } });
    assert.throws(() => history.execute(propertyCommand(history.preview, history.preview.layers[0], "opacity", 0.5, 1e6, true)));
});
test("複合コマンドを一履歴へまとめ、途中失敗時も原子的に維持する", () => {
    const history = new EditingHistory(fixture()), id = history.preview.layers[0].id, before = history.snapshot;
    assert.throws(() => history.execute({ kind: "edit.batch", commands: [{ kind: "layer.update", layerId: id, patch: { name: "changed" } }, { kind: "layer.update", layerId: id, patch: { values: { opacity: 3 } } }] }));
    assert.equal(history.snapshot, before);
    history.execute({ kind: "edit.batch", commands: [{ kind: "layer.update", layerId: id, patch: { name: "changed" } }, { kind: "layer.update", layerId: id, patch: { values: { opacity: 0.5 } } }] });
    history.undo(); assert.equal(history.snapshot, before);
});
test("World／Parent LocalのTransform編集はスナップと一操作のUndoに接続する", () => {
    const history = new EditingHistory(fixture()), layer = history.preview.layers[0];
    const token = history.beginContinuousEdit();
    for (const x of [21, 33, 51]) history.updateContinuousEdit(token, transformCommand(history.preview, layer, 0, "world", "position", [x, 11], false, 16));
    history.commitContinuousEdit(token); assert.deepEqual(history.preview.layers[0].values.position, [48, 16]);
    history.undo(); assert.deepEqual(history.preview.layers[0].values.position, layer.values.position);
    assert.equal(displayedTransform(history.preview, layer, 0, "parent").rotation, 0);
});
test("自動保存の.vcr往復は明示保存済み状態を変更しない", async () => {
    const flow = new ProjectFileFlow(fixture(), REVIEW_VCR_LIMITS, verify, "test"), before = flow.history.snapshot;
    const entry = await recoverySnapshot(flow, verify), loaded = await readRecovery(entry, verify);
    assert.deepEqual(loaded.project, before.project); assert.equal(flow.history.isSaved, false); assert.equal(flow.history.snapshot, before);
    assert.ok(entry.savedAt > 0);
});
test("破損復元候補は拒否し、作業中の文書・履歴に触れない", async () => {
    const flow = new ProjectFileFlow(fixture(), REVIEW_VCR_LIMITS, verify, "test"), before = flow.history.snapshot;
    await assert.rejects(() => readRecovery({ id: "bad", name: "bad", savedAt: 0, archive: new Blob(["bad"]) }, verify));
    assert.equal(flow.history.snapshot, before);
});

test("複合編集内のロック解除で後続の編集保護を回避できない", () => {
    const history = new EditingHistory(fixture()), id = history.preview.layers[0].id;
    history.execute({ kind: "layer.update", layerId: id, patch: { isLocked: true } });
    const before = history.snapshot;
    assert.throws(() => history.execute({ kind: "edit.batch", commands: [{ kind: "layer.update", layerId: id, patch: { isLocked: false } }, { kind: "layer.update", layerId: id, patch: { name: "bypass" } }] }));
    assert.equal(history.snapshot, before);
});
test("パネル外の再生時計はループ終端と一時停止位置を維持する", () => {
    const clock = { time: 0, anchor: 0, wall: 1000, playing: true, speed: 2, loop: true };
    advancePlaybackClock(clock, 2000, 2e6); assert.equal(clock.time, 0);
    clock.loop = false; advancePlaybackClock(clock, 2000, 2e6); assert.equal(clock.time, 2e6); assert.equal(clock.playing, false);
    advancePlaybackClock(clock, 3000, 2e6); assert.equal(clock.time, 2e6);
});

test("発生終了とキーを持つ層をグループ化・解除し、単一Undoで戻せる", () => {
    const history = new EditingHistory(fixture()), id = history.preview.layers[0].id;
    history.execute({ kind: "layer.update", layerId: id, patch: { emissionEndUs: 2e6 } });
    history.execute(propertyCommand(history.preview, history.preview.layers[0], "position", [350, 200], 1e6, true));
    const before = history.snapshot, grouped = groupLayerCommand(history.preview, id, 1e6);
    history.execute(grouped.command);
    assert.equal(history.preview.layers.find((item) => item.id === grouped.groupId).emissionEndUs, undefined);
    assert.equal(history.preview.layers.find((item) => item.id === id).emissionEndUs, 2e6);
    assert.deepEqual(history.preview.tracks, before.project.tracks);
    history.undo(); assert.equal(history.snapshot, before); history.redo();
    history.execute(ungroupLayerCommand(history.preview, grouped.groupId, 1e6));
    assert.equal(history.preview.layers.length, 1); assert.equal(history.preview.layers[0].parentId, null);
    history.undo(); assert.equal(history.preview.layers.length, 2);
});

test("素材取り込みは申告MIMEではなく実データを識別し、未使用画像も復元できる", async () => {
    const flow = new ProjectFileFlow(fixture(), REVIEW_VCR_LIMITS, verify, "test");
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMIqDjxHwAFPAKQ8H9qXAAAAABJRU5ErkJggg==", "base64");
    const file = new File([bytes], "misnamed.jpg", { type: "image/jpeg" });
    const asset = await importProjectImage(flow, file, verify);
    assert.equal(asset.mediaType, "image/png"); assert.equal(asset.width, 1); assert.equal(flow.getImage(asset.id), file);
    const loaded = await readRecovery(await recoverySnapshot(flow, verify), verify);
    assert.equal(loaded.project.assets.length, 1); assert.equal(loaded.images.size, 1);
});
test("不正画像・デコード検証失敗では素材と履歴を変更しない", async () => {
    const flow = new ProjectFileFlow(fixture(), REVIEW_VCR_LIMITS, verify, "test"), before = flow.history.snapshot;
    await assert.rejects(() => importProjectImage(flow, new File(["broken"], "bad.png", { type: "image/png" }), verify));
    assert.equal(flow.history.snapshot, before);
    const file = new File([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMIqDjxHwAFPAKQ8H9qXAAAAABJRU5ErkJggg==", "base64")], "pixel.png");
    await assert.rejects(() => importProjectImage(flow, file, async () => { throw new Error("decode failed"); }));
    assert.equal(flow.history.snapshot, before); assert.equal(flow.history.preview.assets.length, 0);
});
