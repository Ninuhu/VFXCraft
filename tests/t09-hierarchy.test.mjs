import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BlobReader, BlobWriter, ZipWriter } from "@zip.js/zip.js";
import { createProject } from "../src/core/document/createProject.ts";
import { validateProject } from "../src/core/document/validateDocument.ts";
import { hierarchyAt, hierarchyRows, isLayerLocked, composeTransform, decomposeTransform, inverseMatrix, multiplyMatrix, snapPosition } from "../src/core/document/hierarchy.ts";
import { quaternionFromEulerXyzDegrees } from "../src/core/document/rotation.ts";
import { EditingHistory } from "../src/core/editing/history.ts";
import { evaluateParticles2D } from "../src/core/particles/evaluate2D.ts";
import { evaluateParticles3D } from "../src/core/particles/evaluate3D.ts";
import { collectMaterialParticles, tintMaterialParticles } from "../src/rendering/materialParticleData.ts";
import { ProjectFileFlow } from "../src/app/projectFiles/projectFileFlow.ts";
import { readVcr, writeVcr, REVIEW_VCR_LIMITS } from "../src/core/persistence/vcrArchive.ts";
import { DEFAULT_APPEARANCE } from "../src/core/materials/materialEvaluation.ts";

const SEC = 1_000_000; // 秒からµs
const id = (number) => "10000000-0000-4000-8000-" + number.toString(16).padStart(12, "0");
const ROOT = id(1), CHILD = id(2), GRANDCHILD = id(3), OTHER = id(4), EMITTER = id(5), MATERIAL = id(6), ASSET = id(7);
const targets = [ROOT, CHILD, GRANDCHILD];

////////////////////
// 普通の粒子レイヤーが親になる三階層と別の親を作る
function fixture(mode = "2d", options = {}) {
    const dimensions = mode === "2d" ? 2 : 3;
    const vector = (x) => Array.from({ length: dimensions }, (_, index) => index === 0 ? x : 0);
    const source = createProject({ id: id(9), name: "T09", mode, durationUs: 8 * SEC,
        ...(mode === "2d" ? { drawing: "normal", canvasWidth: 640, canvasHeight: 360 } : {}) });
    const layers = [...targets, OTHER].map((item, index) => ({ id: item, name: "Layer " + index, parentId: index === 1 ? ROOT : index === 2 ? CHILD : null,
        order: index, isVisible: true, isLocked: false, startUs: 0,
        values: { position: vector(index === 3 ? 30 : index + 1), rotation: mode === "2d" ? 0 : [0, 0, 0, 1],
            size: new Array(dimensions).fill(1), color: [1, 1, 1], opacity: 1 },
        content: { kind: "emitter", emitterId: EMITTER }, ...options.layers?.[index] }));
    const emitter = { id: EMITTER, materialId: MATERIAL, lifetimeUs: 4 * SEC, emission: { kind: "continuous", ratePerSecond: 2 },
        ...(mode === "2d" ? { particle2d: { speed: 0, directionDegrees: 0, acceleration: [0, 0], space: "local", seed: 1, shape: { kind: "point" } } }
            : { particle3d: { speed: 0, direction: [0, 1, 0], acceleration: [0, 0, 0], space: "local", seed: 1, shape: "point", billboard: "camera" } }),
        ...options.emitter };
    return validateProject({ ...source, layers, emitters: [emitter], materials: [{ id: MATERIAL, color: [1, 1, 1], blend: options.blend ?? "alpha",
        hasBloom: false, gradient: [], textureAssetId: options.asset ? ASSET : null, appearance: DEFAULT_APPEARANCE }],
        assets: options.asset ? [{ id: ASSET, name: "pixel.png", width: 1, height: 1, mediaType: "image/png" }] : [],
        tracks: options.tracks ?? [] });
}

////////////////////
// 行列の全成分を許容誤差で比較する
function near(actual, expected) {
    actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-7 * Math.max(1, Math.abs(value)),
        "matrix " + index + ": " + value + " != " + expected[index]));
}

////////////////////
// 発生順によらない粒子を評価する
function particles(project, time) {
    return project.mode === "2d" ? evaluateParticles2D(project, GRANDCHILD, time) : evaluateParticles3D(project, time).filter((item) => item.key.startsWith(GRANDCHILD));
}

test("ルートと通常粒子の多階層を安定した順で列挙し、親移動・回転・スケールを合成する", () => {
    for (const mode of ["2d", "3d"]) {
        const original = fixture(mode);
        assert.deepEqual(hierarchyRows(original).map((item) => item.depth), [0, 1, 2, 0]);
        assert.equal(hierarchyAt(original, GRANDCHILD, 0).matrix[3], 6);
        const rotation = mode === "2d" ? 90 : quaternionFromEulerXyzDegrees([0, 0, 90]);
        const project = validateProject({ ...original, layers: original.layers.map((layer, index) => index === 0
            ? { ...layer, values: { ...layer.values, rotation, size: mode === "2d" ? [2, 2] : [2, 2, 2] } } : layer) });
        const matrix = hierarchyAt(project, GRANDCHILD, 0).matrix;
        assert.ok(Math.abs(matrix[3] - 1) < 1e-8);
        assert.ok(Math.abs(matrix[7] - 10) < 1e-8);
        assert.equal(hierarchyAt(project, ROOT, 0).visible, true);
    }
});

test("循環・欠損・自己親・重複ID・不正な順序を検証で拒否する", () => {
    const project = fixture();
    for (const patch of [{ parentId: id(99) }, { parentId: ROOT }, { parentId: GRANDCHILD }, { id: CHILD }, { order: -1 }, { order: Infinity }]) {
        assert.throws(() => validateProject({ ...project, layers: project.layers.map((layer, index) => index === 0 ? { ...layer, ...patch } : layer) }));
    }
    const corrupt = { ...project, layers: project.layers.map((layer, index) => index === 0 ? { ...layer, parentId: GRANDCHILD } : layer) };
    assert.throws(() => hierarchyAt(corrupt, CHILD, 0), /循環/);
    assert.throws(() => hierarchyRows(corrupt), /循環/);
});

test("深さ3000の階層と大量レイヤーを再帰なしで評価する", () => {
    const base = fixture();
    const source = base.layers[0];
    const project = validateProject({ ...base, layers: Array.from({ length: 3000 }, (_, index) => ({
        ...source, id: id(100 + index), parentId: index === 0 ? null : id(99 + index), order: index,
    })) });
    assert.equal(hierarchyRows(project).length, 3000);
    assert.equal(hierarchyAt(project, id(3099), 0).matrix[3], 3000);
});

test("2D・3Dの再親子化と親解除はワールドTRSを保ち、一回のUndoで復元する", () => {
    for (const mode of ["2d", "3d"]) {
        const history = new EditingHistory(fixture(mode));
        const before = hierarchyAt(history.preview, CHILD, SEC).matrix;
        const initial = history.snapshot;
        history.execute({ kind: "layer.reparent", layerId: CHILD, parentId: OTHER, timeUs: SEC });
        near(hierarchyAt(history.preview, CHILD, SEC).matrix, before);
        assert.equal(history.preview.layers[1].parentId, OTHER);
        history.undo(); assert.equal(history.snapshot, initial);
        history.redo(); near(hierarchyAt(history.preview, CHILD, SEC).matrix, before);
        history.execute({ kind: "layer.reparent", layerId: CHILD, parentId: null, timeUs: SEC });
        near(hierarchyAt(history.preview, CHILD, SEC).matrix, before);
    }
});

test("親・子がアニメーション中でも現在時刻と既存キーの時刻・補間を保つ", () => {
    for (const mode of ["2d", "3d"]) {
        const vector = (x) => mode === "2d" ? [x, 0] : [x, 0, 0];
        const tracks = [ROOT, CHILD, OTHER].map((layerId) => ({ layerId, property: "position", interpolation: "linear",
            keys: [{ offsetUs: 0, value: vector(layerId === OTHER ? 20 : 0), interpolation: "step" }, { offsetUs: 3 * SEC, value: vector(10) }] }));
        const history = new EditingHistory(fixture(mode, { tracks }));
        const start = history.snapshot, before = hierarchyAt(history.preview, CHILD, SEC).matrix;
        history.execute({ kind: "layer.reparent", layerId: CHILD, parentId: OTHER, timeUs: SEC });
        near(hierarchyAt(history.preview, CHILD, SEC).matrix, before);
        const oldKeys = tracks[1].keys;
        assert.equal(history.preview.tracks[1].keys.length, 3);
        for (const old of oldKeys) assert.deepEqual(history.preview.tracks[1].keys.find((key) => key.offsetUs === old.offsetUs), old);
        assert.equal(history.preview.layers[1].startUs, 0);
        history.undo(); assert.equal(history.snapshot, start);
    }
});

test("Shear・特異変換・循環を生む再親子化を無変更で拒否する", () => {
    for (const mode of ["2d", "3d"]) {
        const base = fixture(mode);
        const project = validateProject({ ...base, layers: base.layers.map((layer, index) => index === 3 ? { ...layer,
            values: { ...layer.values, size: mode === "2d" ? [2, 1] : [2, 1, 1],
                rotation: mode === "2d" ? 45 : quaternionFromEulerXyzDegrees([0, 0, 45]) } } : layer) });
        const history = new EditingHistory(project), before = history.snapshot;
        assert.throws(() => history.execute({ kind: "layer.reparent", layerId: CHILD, parentId: OTHER, timeUs: SEC }), /Shear/);
        assert.equal(history.snapshot, before); assert.equal(history.canUndo, false);
        const zero = validateProject({ ...base, layers: base.layers.map((layer, index) => index === 3 ? { ...layer,
            values: { ...layer.values, size: mode === "2d" ? [0, 1] : [0, 1, 1] } } : layer) });
        const locked = new EditingHistory(zero);
        assert.throws(() => locked.execute({ kind: "layer.reparent", layerId: CHILD, parentId: OTHER, timeUs: 0 }), /ゼロ/);
        assert.throws(() => history.execute({ kind: "layer.reparent", layerId: ROOT, parentId: GRANDCHILD, timeUs: 0 }), /子孫/);
        assert.throws(() => history.execute({ kind: "layer.reparent", layerId: CHILD, parentId: OTHER, timeUs: NaN }));
    }
});

test("既存の現在時刻キーを更新しても、直前区間のStepを持ち込まない", () => {
    const project = fixture("2d", { tracks: [{ layerId: CHILD, property: "position", interpolation: "linear", keys: [
        { offsetUs: 0, value: [2, 0], interpolation: "step" }, { offsetUs: SEC, value: [5, 0] }, { offsetUs: 2 * SEC, value: [8, 0] },
    ] }] });
    const history = new EditingHistory(project);
    history.execute({ kind: "layer.reparent", layerId: CHILD, parentId: OTHER, timeUs: SEC });
    const track = history.preview.tracks[0];
    assert.equal(track.keys.length, 3);
    assert.equal(track.keys[1].interpolation, undefined);
    assert.equal(track.keys[0].interpolation, "step");
    assert.equal(history.preview.layers[1].startUs, project.layers[1].startUs);
    near(hierarchyAt(history.preview, CHILD, SEC).matrix, hierarchyAt(project, CHILD, SEC).matrix);
});

test("行列の逆変換とQuaternion分解は任意の3D軸回転でも再構築できる", () => {
    for (const angles of [[25, 40, 80], [180, 0, 0], [0, 180, 0], [0, 0, 180]]) {
        const values = { position: [1, 2, 3], rotation: quaternionFromEulerXyzDegrees(angles), size: [2, 3, 4], color: [1, 1, 1], opacity: 1 };
        const matrix = composeTransform(values), decomposed = decomposeTransform(matrix, "3d");
        near(composeTransform({ ...decomposed, color: [1, 1, 1], opacity: 1 }), matrix);
        near(multiplyMatrix(matrix, inverseMatrix(matrix)), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    }
});

test("子の発生とキー時刻は親の開始・終了から独立し、シーク順序も変えない", () => {
    for (const mode of ["2d", "3d"]) {
        const base = fixture(mode, { layers: [{ startUs: 2 * SEC, emissionEndUs: 3 * SEC }, {}, { startUs: 5 * SEC }] });
        assert.equal(particles(base, 5 * SEC - 1).length, 0);
        const result = particles(base, 6 * SEC);
        assert.equal(result.length, 3);
        particles(base, 7 * SEC); particles(base, 0);
        assert.deepEqual(particles(base, 6 * SEC), result);
        const history = new EditingHistory(base);
        history.execute({ kind: "layer.update", layerId: ROOT, patch: { startUs: 4 * SEC, emissionEndUs: 5 * SEC } });
        assert.deepEqual(particles(history.preview, 6 * SEC), result);
    }
});

test("表示を祖先から継承し、RGBと透明度は3階層で乗算する", () => {
    for (const mode of ["2d", "3d"]) for (const blend of ["alpha", "additive", "multiply"]) {
        const base = fixture(mode, { blend });
        const project = validateProject({ ...base, layers: base.layers.map((layer) => ({ ...layer, values: {
            ...layer.values, color: [0.5, 1, 0.75], opacity: 0.5 } })) });
        const inherited = hierarchyAt(project, GRANDCHILD, 0);
        assert.deepEqual(inherited.color, [0.125, 1, 0.421875]); assert.equal(inherited.opacity, 0.125);
        const tinted = tintMaterialParticles(collectMaterialParticles(project, 0), new Map(project.materials.map((item) => [item.id, item])));
        const sample = tinted.find((item) => item.key.startsWith(GRANDCHILD));
        assert.deepEqual(sample.color, inherited.color); assert.equal(sample.opacity, 0.125);
        const history = new EditingHistory(project);
        history.execute({ kind: "layer.update", layerId: ROOT, patch: { isVisible: false } });
        assert.equal(particles(history.preview, 0).length, 0);
        assert.equal(history.preview.layers[2].isVisible, true);
        history.execute({ kind: "layer.update", layerId: ROOT, patch: { isVisible: true } });
        assert.equal(particles(history.preview, 0).length, 1);
    }
});

test("親の色とAlphaキーを子の現在時刻へ適用し保存値を変更しない", () => {
    for (const mode of ["2d", "3d"]) {
        const project = fixture(mode, { tracks: [
            { layerId: ROOT, property: "opacity", interpolation: "linear", keys: [{ offsetUs: 0, value: 1 }, { offsetUs: 2 * SEC, value: 0 }] },
            { layerId: ROOT, property: "color", interpolation: "linear", keys: [{ offsetUs: 0, value: [1, 0, 0] }, { offsetUs: 2 * SEC, value: [0, 0, 1] }] },
        ] });
        assert.equal(hierarchyAt(project, GRANDCHILD, SEC).opacity, 0.5);
        assert.deepEqual(hierarchyAt(project, GRANDCHILD, SEC).color, [0.5, 0, 0.5]);
        assert.deepEqual(project.layers[2].values.color, [1, 1, 1]);
    }
});

test("自己・祖先ロックでコマンド経由の変更を拒否し、表示と自身の解除は許可する", () => {
    const base = fixture();
    const history = new EditingHistory(base);
    history.execute({ kind: "layer.update", layerId: ROOT, patch: { isLocked: true } });
    const locked = history.snapshot;
    const commands = [
        { kind: "layer.update", layerId: CHILD, patch: { name: "bad" } },
        { kind: "layer.update", layerId: CHILD, patch: { isLocked: false, values: { position: [99, 0] } } },
        { kind: "key.add", layerId: CHILD, property: "opacity", key: { offsetUs: 0, value: 0 } },
        { kind: "layer.reparent", layerId: OTHER, parentId: ROOT, timeUs: 0 },
        { kind: "layer.reparent", layerId: CHILD, parentId: null, timeUs: 0 },
        { kind: "layer.transform", layerId: CHILD, space: "parent", timeUs: 0, values: { position: [2, 2] } },
        { kind: "hierarchy.duplicate", layerId: ROOT },
        { kind: "hierarchy.add", parentId: ROOT },
        { kind: "layer.add", layer: { ...base.layers[3], id: id(99), parentId: CHILD } },
        { kind: "layer.remove", layerId: ROOT, descendants: true },
        { kind: "hierarchy.reorder", layerId: ROOT, direction: 1 },
        { kind: "material.appearance", materialId: MATERIAL, color: [1, 0, 0], blend: "alpha", appearance: DEFAULT_APPEARANCE },
        { kind: "emitter.update", emitterId: EMITTER, settings: { emission: base.emitters[0].emission, lifetimeUs: SEC } },
    ];
    for (const command of commands) {
        assert.throws(() => history.execute(command), /ロック/);
        assert.equal(history.snapshot, locked);
    }
    assert.equal(isLayerLocked(history.preview, GRANDCHILD), true);
    history.execute({ kind: "layer.update", layerId: CHILD, patch: { isVisible: false, isLocked: false } });
    assert.equal(isLayerLocked(history.preview, CHILD), true);
    history.execute({ kind: "layer.update", layerId: ROOT, patch: { isLocked: false } });
    assert.equal(isLayerLocked(history.preview, CHILD), false);
    history.undo(); assert.equal(isLayerLocked(history.preview, CHILD), true);
});

test("ロック子孫を含む削除と複製、共有素材解除も拒否する", () => {
    const history = new EditingHistory(fixture("2d", { asset: true, layers: [{}, {}, { isLocked: true }] }));
    for (const command of [
        { kind: "layer.remove", layerId: ROOT, descendants: true }, { kind: "hierarchy.duplicate", layerId: ROOT },
        { kind: "asset.remove", assetId: ASSET }, { kind: "material.setTexture", materialId: MATERIAL, assetId: null },
    ]) assert.throws(() => history.execute(command), /ロック/);
});

test("階層削除は関連Trackを一括削除し、共有設定と画像・Undo復元を維持する", () => {
    const history = new EditingHistory(fixture("2d", { asset: true, tracks: [
        { layerId: CHILD, property: "opacity", interpolation: "linear", keys: [{ offsetUs: 0, value: 0.5 }] },
    ] }));
    const initial = history.snapshot;
    assert.throws(() => history.execute({ kind: "layer.remove", layerId: ROOT }), /確認/);
    assert.equal(history.snapshot, initial);
    history.execute({ kind: "layer.remove", layerId: ROOT, descendants: true });
    assert.equal(history.preview.layers.length, 1); assert.equal(history.preview.tracks.length, 0);
    assert.equal(history.preview.materials.length, 1); assert.equal(history.preview.assets.length, 1);
    history.undo(); assert.equal(history.snapshot, initial);
    history.redo(); assert.equal(history.preview.layers[0].id, OTHER);
});

test("複製はID・親・Trackを張り替え、発生器・材質を独立させBlobは一つを共有する", () => {
    const flow = new ProjectFileFlow(fixture("2d", { asset: true, tracks: [
        { layerId: CHILD, property: "opacity", interpolation: "linear", keys: [{ offsetUs: 0, value: 0.5 }] },
    ] }), REVIEW_VCR_LIMITS, async () => {}, "0.0.0");
    const blob = new Blob(["image"]); flow.rememberImage(ASSET, blob);
    const history = flow.history, initial = history.snapshot;
    history.execute({ kind: "hierarchy.duplicate", layerId: ROOT });
    const after = history.snapshot, copies = history.preview.layers.slice(4);
    assert.equal(copies.length, 3);
    assert.equal(copies[1].parentId, copies[0].id); assert.equal(copies[2].parentId, copies[1].id);
    assert.equal(history.preview.emitters.length, 2); assert.equal(history.preview.materials.length, 2);
    assert.equal(history.preview.tracks[1].layerId, copies[1].id);
    assert.equal(history.preview.materials[1].textureAssetId, ASSET);
    assert.equal(flow.getImage(ASSET), blob); assert.equal(history.preview.assets.length, 1);
    history.execute({ kind: "key.update", layerId: copies[1].id, property: "opacity", offsetUs: 0, key: { offsetUs: 0, value: 0.1 } });
    assert.equal(history.preview.tracks[0].keys[0].value, 0.5);
    history.undo(); history.undo(); assert.equal(history.snapshot, initial);
    history.redo(); assert.equal(history.snapshot, after);
});

test("WorldとParent Localの数値・スナップは別空間で、Simulation Spaceを変更しない", () => {
    for (const mode of ["2d", "3d"]) {
        const base = fixture(mode);
        const parent = { ...base.layers[0], values: { ...base.layers[0].values, rotation: mode === "2d" ? 90 : quaternionFromEulerXyzDegrees([0, 0, 90]) } };
        const history = new EditingHistory({ ...base, layers: [parent, ...base.layers.slice(1)] });
        const position = mode === "2d" ? [4.2, 3.1] : [4.2, 3.1, 0];
        history.execute({ kind: "layer.transform", layerId: CHILD, space: "world", timeUs: 0, values: { position }, snapInterval: 0.5 });
        const matrix = hierarchyAt(history.preview, CHILD, 0).matrix;
        assert.ok(Math.abs(matrix[3] - 4) < 1e-10); assert.ok(Math.abs(matrix[7] - 3) < 1e-10);
        history.execute({ kind: "layer.transform", layerId: CHILD, space: "parent", timeUs: 0, values: { position }, snapInterval: 0.5 });
        assert.equal(history.preview.layers[1].values.position[0], 4);
        assert.equal(history.preview.layers[1].values.position[1], 3);
        assert.equal(history.preview.emitters[0][mode === "2d" ? "particle2d" : "particle3d"].space, "local");
        for (const invalid of [0, -1, NaN, Infinity, 1e-12]) assert.throws(() => snapPosition([0, 1], invalid));
    }
});

test("兄弟並び替え・子追加はUndo/Redoで参照と順序を復元する", () => {
    const history = new EditingHistory(fixture());
    const initial = history.snapshot;
    history.execute({ kind: "hierarchy.reorder", layerId: ROOT, direction: 1 });
    assert.equal(hierarchyRows(history.preview)[0].layer.id, OTHER);
    history.undo(); assert.equal(history.snapshot, initial);
    history.execute({ kind: "hierarchy.add", parentId: CHILD });
    const layer = history.preview.layers.at(-1);
    assert.equal(layer.parentId, CHILD); assert.equal(history.preview.emitters.length, 2);
    history.undo(); assert.equal(history.snapshot, initial);
});

test("階層Transformの連続ドラッグは一履歴、取消と無変更は履歴を作らない", () => {
    const history = new EditingHistory(fixture());
    const before = history.snapshot;
    const token = history.beginContinuousEdit();
    for (const x of [1, 2, 3]) history.updateContinuousEdit(token, { kind: "layer.transform", layerId: CHILD,
        timeUs: 0, space: "parent", values: { position: [x, 0] } });
    history.commitContinuousEdit(token);
    history.undo(); assert.equal(history.snapshot, before);
    const cancel = history.beginContinuousEdit();
    history.updateContinuousEdit(cancel, { kind: "layer.transform", layerId: CHILD, timeUs: 0, space: "parent", values: { position: [55, 0] } });
    history.cancelContinuousEdit(cancel); assert.equal(history.snapshot, before);
});

test("論理版1〜5の互換と版6の階層保存往復、読込失敗時のセッション保持", async () => {
    const verify = async () => {};
    for (const name of ["t04-2d-v1.vcr", "t04-3d-v1.vcr", "t05-2d-v2.vcr"]) {
        const file = await readFile(new URL("./fixtures/vcr/" + name, import.meta.url));
        assert.equal((await readVcr(new Blob([file]), REVIEW_VCR_LIMITS, verify)).project.schemaVersion, 6);
    }
    for (const version of [3, 4, 5]) {
        const project = { ...fixture("3d"), schemaVersion: version }; // 旧版の既存階層フィールドだけを持つZIP
        const writer = new ZipWriter(new BlobWriter(), { level: 0, useWebWorkers: false });
        await writer.add("metadata.json", new BlobReader(new Blob([JSON.stringify({ format: "VFXCraft", containerVersion: 1, createdByVersion: "0.0.0" })])));
        await writer.add("project.json", new BlobReader(new Blob([JSON.stringify(project)])));
        const loaded = await readVcr(await writer.close(), REVIEW_VCR_LIMITS, verify);
        assert.equal(loaded.project.layers[2].parentId, CHILD);
    }
    for (const mode of ["2d", "3d"]) {
        const flow = new ProjectFileFlow(fixture(mode), REVIEW_VCR_LIMITS, verify, "0.0.0");
        flow.history.execute({ kind: "hierarchy.duplicate", layerId: ROOT });
        const before = flow.history.snapshot;
        const file = await writeVcr({ project: before.project, images: new Map() }, REVIEW_VCR_LIMITS, verify, "0.0.0");
        assert.deepEqual((await readVcr(file, REVIEW_VCR_LIMITS, verify)).project, before.project);
        await assert.rejects(flow.open(new Blob(["bad"]), undefined, "discard"));
        assert.equal(flow.history.snapshot, before);
        assert.throws(() => validateProject({ ...before.project, schemaVersion: 7 }));
    }
});
