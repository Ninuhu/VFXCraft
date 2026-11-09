import assert from "node:assert/strict";
import { test } from "node:test";
import { createProject } from "../src/core/document/createProject.ts";
import { evaluateLayerTrack } from "../src/core/document/evaluateTrack.ts";
import { eulerXyzDegreesFromQuaternion, quaternionFromEulerXyzDegrees, slerpQuaternion } from "../src/core/document/rotation.ts";
import { frameToTimeUs, withProductionFps } from "../src/core/document/time.ts";
import { DocumentValidationError, validatePreset, validateProject } from "../src/core/document/validateDocument.ts";

const IDS = {
    project: "10000000-0000-4000-8000-000000000001",
    group: "10000000-0000-4000-8000-000000000002",
    layer: "10000000-0000-4000-8000-00000000000a",
    emitter: "10000000-0000-4000-8000-000000000004",
    material: "10000000-0000-4000-8000-000000000005",
    asset: "10000000-0000-4000-8000-000000000006",
    preset: "10000000-0000-4000-8000-000000000007",
    missing: "10000000-0000-4000-8000-000000000008",
}; // 再現可能な検証用ID

////////////////////
// すべてのモデルと参照を含む検証用プロジェクトを生成する
function fixture(mode = "2d", drawing = "normal") {
    const is2d = mode === "2d"; // モード別の値の次元
    const document = createProject({
        id: IDS.project, name: "Example", durationUs: 1_000_000, mode,
        ...(is2d ? { drawing, canvasWidth: 640, canvasHeight: 360 } : {}),
    }); // 初期FPSを含む文書
    const baseValues = {
        position: is2d ? [10, 20] : [1, 2, 3], rotation: is2d ? 0 : [0, 0, 0, 2],
        size: is2d ? [1, 1] : [1, 1, 1], color: [1, 1, 1], opacity: 0.75,
    }; // 基準値。3D回転は正規化も検証する。
    return {
        ...document,
        layers: [
            { id: IDS.group, name: "Group", parentId: null, order: 0, isVisible: true, isLocked: false,
                startUs: 0, values: baseValues, content: { kind: "group" } },
            { id: IDS.layer, name: "Particles", parentId: IDS.group, order: 0, isVisible: true, isLocked: false,
                startUs: 100_000, values: structuredClone(baseValues), content: { kind: "emitter", emitterId: IDS.emitter } },
        ],
        emitters: [{ id: IDS.emitter, materialId: IDS.material, lifetimeUs: 500_000,
            emission: is2d ? { kind: "continuous", ratePerSecond: 60 } : { kind: "burst", count: 32 } }],
        materials: [{ id: IDS.material, textureAssetId: IDS.asset, blend: "alpha",
            color: [1, 1, 1], hasBloom: false, gradient: [{ offset: 0, color: [0, 0, 0] }] }],
        assets: [{ id: IDS.asset, name: "Texture", mediaType: "image/png", width: 32, height: 32 }],
        tracks: [
            { layerId: IDS.layer.toUpperCase(), property: "position", interpolation: "linear",
                keys: [{ offsetUs: 100_000, value: is2d ? [0, 0] : [0, 0, 0] },
                    { offsetUs: 900_000, value: is2d ? [8, 16] : [8, 16, 24] }] },
            { layerId: IDS.layer, property: "rotation", interpolation: "linear",
                keys: [{ offsetUs: 0, value: is2d ? 0 : [0, 0, 0, 2] },
                    { offsetUs: 800_000, value: is2d ? 360 : [0, 1, 0, 0] }] },
            { layerId: IDS.layer, property: "size", interpolation: "step", keys: [] },
            { layerId: IDS.layer, property: "color", interpolation: "linear",
                keys: [{ offsetUs: 0, value: [0, 0, 0] }, { offsetUs: 800_000, value: [1, 1, 1] }] },
            { layerId: IDS.layer, property: "opacity", interpolation: "step",
                keys: [{ offsetUs: 0, value: 0 }, { offsetUs: 800_000, value: 1 }] },
        ],
    };
}

////////////////////
// 二つのQuaternionが同じ姿勢を表すことを確認する
function assertSameRotation(actual, expected) {
    const dot = actual.reduce((sum, value, index) => sum + value * expected[index], 0); // 単位Quaternionの内積
    assert.ok(Math.abs(1 - Math.abs(dot)) < 1e-12);
}

test("通常2D・ピクセル2D・3Dの代表文書を生成しJSON往復できる", () => {
    for (const [mode, drawing] of [["2d", "normal"], ["2d", "pixel"], ["3d", undefined]]) {
        const input = fixture(mode, drawing); // 生の検証データ
        const project = validateProject(input); // 正規化した文書
        assert.equal(project.mode, mode);
        assert.equal(project.productionFps, 60);
        assert.equal(project.drawing, mode === "2d" ? drawing : undefined);
        assert.deepEqual(validateProject(JSON.parse(JSON.stringify(project))), project);
        if (mode === "3d") {
            assert.deepEqual(project.layers[1].values.rotation, [0, 0, 0, 1]);
            assert.deepEqual(input.layers[1].values.rotation, [0, 0, 0, 2]);
        }
    }
});

test("プリセットの素材参照は独立したテンプレートで解決する", () => {
    const preset = { schemaVersion: 1, id: IDS.preset, name: "Preset", template: fixture(), requiredAssetIds: [IDS.asset] }; // プリセット候補
    assert.equal(validatePreset(preset).requiredAssetIds[0], IDS.asset);
    assert.throws(() => validatePreset({ ...preset, requiredAssetIds: [IDS.missing] }), DocumentValidationError);
});

test("絶対フレーム時刻を正確に丸め、FPS変更では時刻を保持する", () => {
    assert.deepEqual([0, 1, 2, 3, 60, 216_000].map((frame) => frameToTimeUs(frame, 60)),
        [0, 16_667, 33_333, 50_000, 1_000_000, 3_600_000_000]);
    assert.equal(frameToTimeUs(1, 128), 7_813);
    assert.equal(frameToTimeUs(Number.MAX_SAFE_INTEGER, 1_000_000), Number.MAX_SAFE_INTEGER);
    for (const [frame, fps] of [[-1, 60], [1.5, 60], [0, 0], [0, 29.97], [1, 1_000_001], [Number.MAX_SAFE_INTEGER, 60]]) {
        assert.throws(() => frameToTimeUs(frame, fps), RangeError);
    }
    const original = validateProject(fixture()); // 変更前の制作データ
    const changed = withProductionFps(original, 128); // フレーム間隔だけが変わる文書
    assert.equal(changed.productionFps, 128);
    assert.equal(original.productionFps, 60);
    assert.deepEqual(changed.tracks, original.tracks);
    assert.deepEqual(changed.layers, original.layers);
});

test("レイヤー開始とキーの境界を扱い、基本値を補間する", () => {
    const project = validateProject(fixture()); // 有効な2D文書
    const layer = project.layers[1]; // 100msから始まるレイヤー
    const [position, rotation, size, color, opacity] = project.tracks; // 5項目のTrack
    assert.equal(evaluateLayerTrack(layer, position, 99_999), undefined);
    assert.deepEqual(evaluateLayerTrack(layer, position, 199_999), [10, 20]);
    assert.deepEqual(evaluateLayerTrack(layer, position, 200_000), [0, 0]);
    assert.deepEqual(evaluateLayerTrack(layer, position, 600_000), [4, 8]);
    assert.deepEqual(evaluateLayerTrack(layer, position, 1_000_000), [8, 16]);
    assert.equal(evaluateLayerTrack(layer, rotation, 500_000), 180);
    assert.deepEqual(evaluateLayerTrack(layer, size, 500_000), [1, 1]);
    assert.deepEqual(evaluateLayerTrack(layer, color, 500_000), [0.5, 0.5, 0.5]);
    assert.equal(evaluateLayerTrack(layer, opacity, 899_999), 0);
    assert.equal(evaluateLayerTrack(layer, opacity, 900_000), 1);
    assert.equal(evaluateLayerTrack(layer, opacity, 1_000_000), 1);
});

test("3DのXYZ角度を往復し、符号差を考慮した最短SLERPを使う", () => {
    for (const angles of [[30, 45, 60], [20, 90, 40], [20, -90, 40]]) {
        const q = quaternionFromEulerXyzDegrees(angles); // 表示角から得た姿勢
        assertSameRotation(quaternionFromEulerXyzDegrees(eulerXyzDegreesFromQuaternion(q)), q);
    }
    const project = validateProject(fixture("3d")); // 0°と180°を持つ文書
    assertSameRotation(evaluateLayerTrack(project.layers[1], project.tracks[1], 500_000),
        quaternionFromEulerXyzDegrees([0, 90, 0]));
    const target = quaternionFromEulerXyzDegrees([0, 90, 0]); // 比較先の姿勢
    assertSameRotation(slerpQuaternion([0, 0, 0, 1], target.map((value) => -value), 0.5),
        quaternionFromEulerXyzDegrees([0, 45, 0]));
});

const invalidCases = [
    ["不正ID", (project) => { project.id = "bad-id"; }, "project.id"],
    ["異なる種類の重複ID", (project) => { project.assets[0].id = IDS.layer.toUpperCase(); }, "project.assets[0].id"],
    ["欠落した素材", (project) => { project.assets = []; }, "project.materials[0].textureAssetId"],
    ["誤種別の材質参照", (project) => { project.emitters[0].materialId = IDS.asset; }, "project.emitters[0].materialId"],
    ["欠落したTrack対象", (project) => { project.tracks[0].layerId = IDS.missing; }, "project.tracks[0].layerId"],
    ["自己親", (project) => { project.layers[0].parentId = IDS.group; }, "project.layers[0].parentId"],
    ["複数レイヤーの循環", (project) => { project.layers[0].parentId = IDS.layer; }, "project.layers[0].parentId"],
    ["NaN", (project) => { project.layers[1].values.position = [NaN, 0]; }, "project.layers[1].values.position[0]"],
    ["Infinity", (project) => { project.emitters[0].emission.ratePerSecond = Infinity; }, "project.emitters[0].emission.ratePerSecond"],
    ["モードと座標の不整合", (project) => { project.layers[1].values.position = [0, 0, 0]; }, "project.layers[1].values.position"],
    ["不正な開始時刻", (project) => { project.layers[1].startUs = 1.5; }, "project.layers[1].startUs"],
    ["安全整数外の制作尺", (project) => { project.durationUs = Number.MAX_SAFE_INTEGER + 1; }, "project.durationUs"],
    ["制作尺外のキー", (project) => { project.tracks[0].keys[1].offsetUs = 900_001; }, "project.tracks[0].keys[1].offsetUs"],
    ["同時刻キー", (project) => { project.tracks[0].keys[1].offsetUs = 100_000; }, "project.tracks[0].keys[1].offsetUs"],
    ["重複Track", (project) => { project.tracks.push(project.tracks[0]); }, "project.tracks[5]"],
    ["未対応スキーマ版", (project) => { project.schemaVersion = 5; }, "project.schemaVersion"],
]; // 誤入力と拒否箇所の組

for (const [label, mutate, path] of invalidCases) {
    test(label + "を拒否する", () => {
        const project = fixture(); // 1箇所だけ壊す文書
        mutate(project);
        assert.throws(() => validateProject(project), { name: "DocumentValidationError", path });
    });
}

test("ゼロ長・非有限Quaternionと3Dへの2D描画設定を拒否する", () => {
    for (const rotation of [[0, 0, 0, 0], [0, Infinity, 0, 1]]) {
        const project = fixture("3d"); // 回転値を壊す3D文書
        project.layers[0].values.rotation = rotation;
        assert.throws(() => validateProject(project), DocumentValidationError);
    }
    assert.throws(() => validateProject({ ...fixture("3d"), drawing: "pixel" }), DocumentValidationError);
});
