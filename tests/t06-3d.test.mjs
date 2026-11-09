import assert from "node:assert/strict";
import { test } from "node:test";
import { Vector3 } from "three";
import { readFile } from "node:fs/promises";
import { createProject } from "../src/core/document/createProject.ts";
import { validateProject } from "../src/core/document/validateDocument.ts";
import { quaternionFromEulerXyzDegrees } from "../src/core/document/rotation.ts";
import { evaluateParticles3D, layerTransform3D } from "../src/core/particles/evaluate3D.ts";
import { billboardBasis, sortParticles3D, fillParticleVertices } from "../src/rendering/particleDrawData3D.ts";
import { Camera3D } from "../src/rendering/Camera3D.ts";
import { EditingHistory } from "../src/core/editing/history.ts";
import { ProjectFileFlow } from "../src/app/projectFiles/projectFileFlow.ts";
import { readVcr, writeVcr, REVIEW_VCR_LIMITS } from "../src/core/persistence/vcrArchive.ts";

const ID = (n) => "10000000-0000-4000-8000-" + String(n).padStart(12, "0"); // 固定の一意ID
const DEFAULT = { speed: 2, direction: [0, 1, 0], acceleration: [0, -2, 0], space: "local", seed: 7, shape: "point", billboard: "camera" }; // 3D設定
const BASIS = { position: [0, 0, 10], forward: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0] }; // 基準カメラ

////////////////////
// 二つのレイヤーで粒子単位のソートを確認できる文書を作る
function fixture(patch = {}) {
    const base = createProject({ id: ID(1), name: "3D test", mode: "3d", durationUs: 4e6 }); // 空の文書
    return validateProject({ ...base,
        layers: [2, 5].map((id) => ({ id: ID(id), name: String(id), parentId: null, order: id, isVisible: true,
            isLocked: false, startUs: 0, values: { position: [0, 0, id - 2], rotation: [0, 0, 0, 1], size: [1, 1, 1],
                color: [1, 1, 1], opacity: 0.5 }, content: { kind: "emitter", emitterId: ID(id + 1) } })),
        emitters: [3, 6].map((id) => ({ id: ID(id), materialId: ID(4), lifetimeUs: 1e6,
            emission: { kind: "continuous", ratePerSecond: 10 }, particle3d: { ...DEFAULT, ...patch } })),
        materials: [{ id: ID(4), textureAssetId: null, blend: "alpha", color: [1, 1, 1], hasBloom: false, gradient: [] }],
    });
}

////////////////////
// 浮動小数点の計算結果を許容差で比べる
function near(actual, expected) {
    assert.equal(actual.length, expected.length);
    actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-9, actual + " != " + expected));
}

test("3D Continuousの時刻0、開始前、寿命の終端とBurstを扱う", () => {
    const doc = fixture(); // 連続発生データ
    assert.equal(evaluateParticles3D(doc, 0).length, 2);
    assert.equal(evaluateParticles3D(doc, 100000).length, 4);
    assert.equal(evaluateParticles3D(doc, 1e6)[0].key, ID(2) + ":1");
    const delayed = validateProject({ ...doc, layers: doc.layers.map((layer) => ({ ...layer, startUs: 100000 })) }); // 開始前
    assert.equal(evaluateParticles3D(delayed, 99999).length, 0);
    const burst = validateProject({ ...doc, emitters: doc.emitters.map((entry) => ({ ...entry, emission: { kind: "burst", count: 20 } })) }); // 一括設定
    assert.equal(evaluateParticles3D(burst, 0).length, 40);
    assert.equal(evaluateParticles3D(burst, 999999).length, 40);
    assert.equal(evaluateParticles3D(burst, 1e6).length, 0);
    assert.equal(evaluateParticles3D(burst, 2e6).length, 0);
});

test("3D方向を単位化し、初速と加速度を秒単位で計算する", () => {
    const doc = fixture({ direction: [0, 20, 0] }); // 方向の長さは速度に影響しない
    near(evaluateParticles3D(doc, 500000)[0].position, [0, 0.75, 0]);
    const huge = fixture({ direction: [Number.MAX_VALUE, 0, 0], acceleration: [0, 0, 0] }); // 正規化であふれない方向
    near(evaluateParticles3D(huge, 500000)[0].position, [1, 0, 0]);
});

test("親の位置・Quaternion・非一様スケールを合成する", () => {
    const doc = fixture(); // 子のある文書
    const parent = { ...doc.layers[1], content: { kind: "group" }, values: { ...doc.layers[1].values,
        position: [10, 0, 0], rotation: quaternionFromEulerXyzDegrees([0, 0, 90]), size: [2, 3, 4] } }; // 親変換
    const child = { ...doc.layers[0], parentId: parent.id, values: { ...doc.layers[0].values, position: [1, 0, 0] } }; // 子変換
    const project = validateProject({ ...doc, layers: [parent, child] }); // 検証済み階層
    near(layerTransform3D(project, child.id, 0)([0, 0, 0]), [10, 2, 0]);
    const particle = evaluateParticles3D(project, 0)[0]; // 拡大した板
    assert.ok(Math.abs(particle.width - 0.4) < 1e-9);
    assert.ok(Math.abs(particle.height - 0.6) < 1e-9);
});

test("ワールドは発生時の親変換、ローカルは現在時刻の変換に追従する", () => {
    for (const space of ["world", "local"]) {
        const doc = fixture({ space }); // 空間設定
        const project = validateProject({ ...doc, tracks: [{ layerId: ID(2), property: "position", interpolation: "linear",
            keys: [{ offsetUs: 0, value: [0, 0, 0] }, { offsetUs: 1e6, value: [10, 0, 0] }] }] }); // 移動する発生器
        near(evaluateParticles3D(project, 500000)[0].position, [space === "local" ? 5 : 0, 0.75, 0]);
    }
});

test("シード・設定・時刻が同じならシーク順序によらず同じ結果になる", () => {
    const doc = fixture(); // 点発生ではシードを使う乱数自体が不要
    const expected = evaluateParticles3D(doc, 900000); // 比較する時刻
    for (const time of [0, 1e6, 700000, 10000, 3e6]) evaluateParticles3D(doc, time);
    assert.deepEqual(evaluateParticles3D(doc, 900000), expected);
});

test("全面ビルボードはカメラ基底、Y軸固定はワールドYを維持して極でも有限になる", () => {
    const sample = evaluateParticles3D(fixture(), 0)[0]; // 原点の粒子
    const view = new Camera3D(); // 回転したカメラ
    view.orbit(0.5, 0.2);
    assert.deepEqual(billboardBasis(sample, view.basis()), { right: view.basis().right, up: view.basis().up });
    for (const position of [[0, 10, 0], [0, -10, 0], [1e-14, 10, 1e-14], [4, 3, 6]]) {
        const basis = billboardBasis({ ...sample, billboard: "world-y" }, { ...BASIS, position }); // Y固定の向き
        near(basis.up, [0, 1, 0]);
        assert.ok([...basis.up, ...basis.right].every(Number.isFinite));
        assert.ok(Math.abs(Math.hypot(...basis.right) - 1) < 1e-9);
        assert.equal(basis.right[1], 0);
    }
});

test("全レイヤーを横断して深度ソートし、逆方向のカメラと同深度にも対応する", () => {
    const samples = evaluateParticles3D(fixture(), 0); // 二つのレイヤー
    assert.deepEqual(sortParticles3D(samples, BASIS).map((p) => p.key), [ID(2) + ":0", ID(5) + ":0"]);
    assert.deepEqual(sortParticles3D(samples, { ...BASIS, position: [0, 0, -10], forward: [0, 0, 1] }).map((p) => p.key),
        [ID(5) + ":0", ID(2) + ":0"]);
    const ties = [samples[1], { ...samples[0], position: samples[1].position }]; // 同深度を逆順入力
    assert.equal(sortParticles3D(ties, BASIS)[0].key, ID(2) + ":0");
    assert.deepEqual(sortParticles3D([], BASIS), []);
});

test("大量粒子のソートと頂点構築は有限で、バッファ不足・GPU範囲外を拒否する", () => {
    const sample = evaluateParticles3D(fixture(), 0)[0]; // 基準粒子
    const samples = Array.from({ length: 10000 }, (_, index) => ({ ...sample, key: String(index), position: [0, 0, index / 100] })); // 複数深度
    const sorted = sortParticles3D(samples, BASIS); // 1万個の順序
    assert.equal(sorted[0].position[2], 0);
    const positions = new Float32Array(180000), colors = new Float32Array(240000); // 再利用バッファ
    fillParticleVertices(sorted, BASIS, positions, colors);
    assert.ok(positions.every(Number.isFinite));
    assert.throws(() => fillParticleVertices(sorted, BASIS, new Float32Array(0), colors));
    assert.throws(() => fillParticleVertices([{ ...sample, position: [Infinity, 0, 0] }], BASIS, positions, colors));
});

test("カメラのOrbit・Pan・Zoomを制限し、固定リセットは全体表示と独立する", () => {
    const rig = new Camera3D(); // カメラ
    const initial = rig.camera.position.toArray(); // 固定視点
    rig.orbit(1, 1e30); rig.pan(0.1, -0.1); rig.zoom(1e30);
    assert.ok(rig.basis().position.every(Number.isFinite));
    assert.ok(rig.camera.position.distanceTo(rig.target) <= 1000000.001);
    rig.zoom(-1e30);
    assert.ok(rig.camera.position.distanceTo(rig.target) >= 0.00999);
    rig.reset(); near(rig.camera.position.toArray(), initial);
    assert.throws(() => rig.orbit(NaN, 0)); assert.throws(() => rig.pan(0, Infinity)); assert.throws(() => rig.zoom(NaN));
});

test("全体表示は現在粒子の板を含み、縦横画面と空・異常Boundsを扱う", () => {
    const rig = new Camera3D(); // カメラ
    const samples = evaluateParticles3D(fixture(), 500000); // 現在粒子
    for (const [width, height] of [[1600, 400], [400, 1600]]) {
        rig.resize(width, height);
        assert.equal(rig.frame(samples), true);
        const forward = rig.camera.position.distanceTo(rig.target); // 視点距離
        assert.ok(forward > 0);
        const vertices = new Float32Array(samples.length * 18), colors = new Float32Array(samples.length * 24); // 全板の角
        fillParticleVertices(samples, rig.basis(), vertices, colors);
        for (let index = 0; index < vertices.length; index += 3) {
            const point = new Vector3(vertices[index], vertices[index + 1], vertices[index + 2]).project(rig.camera); // 正規化画面座標
            assert.ok(Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1 && point.z >= -1 && point.z <= 1);
        }
        const positions = rig.camera.position.toArray(); // 空の場合に保持する状態
        assert.equal(rig.frame([]), false);
        near(rig.camera.position.toArray(), positions);
        assert.throws(() => rig.frame([{ ...samples[0], position: [NaN, 0, 0] }]));
        near(rig.camera.position.toArray(), positions);
    }
    assert.throws(() => rig.resize(1, 0));
    assert.throws(() => rig.resize(Number.MAX_VALUE, Number.MIN_VALUE));
});

test("3D不正設定は履歴を変更せず、ビルボードの連続入力を1回のUndoで戻せる", () => {
    const history = new EditingHistory(fixture()); // 編集セッション
    const initial = history.snapshot; // 保護対象
    const emitter = initial.project.emitters[0]; // 編集対象
    for (const patch of [{ direction: [0, 0, 0] }, { acceleration: [0, NaN, 0] }, { billboard: "invalid" }, { speed: -1 }, { shape: "sphere" }]) {
        assert.throws(() => history.execute({ kind: "emitter.update", emitterId: emitter.id, settings: {
            emission: emitter.emission, lifetimeUs: emitter.lifetimeUs, particle3d: { ...DEFAULT, ...patch } } }));
        assert.equal(history.snapshot, initial);
    }
    const token = history.beginContinuousEdit(); // 数値入力・ドラッグを集約
    for (const speed of [1, 2, 3]) history.updateContinuousEdit(token, { kind: "emitter.update", emitterId: emitter.id,
        settings: { emission: emitter.emission, lifetimeUs: emitter.lifetimeUs, particle3d: { ...DEFAULT, speed, billboard: "world-y" } } });
    assert.equal(history.commitContinuousEdit(token), true);
    assert.equal(history.snapshot.project.emitters[0].particle3d.billboard, "world-y");
    history.undo(); assert.equal(history.snapshot, initial);
    history.redo(); assert.equal(history.snapshot.project.emitters[0].particle3d.speed, 3);
});

test("初版3D・T05版を読み込み、T06設定を保存往復できる", async () => {
    const verify = async () => {}; // 実画像のデコードは既存E2Eで検証する
    const old = await readFile(new URL("./fixtures/vcr/t04-3d-v1.vcr", import.meta.url)); // 固定の初版
    const loaded = await readVcr(new Blob([old]), REVIEW_VCR_LIMITS, verify); // 現行への移行
    assert.equal(loaded.project.schemaVersion, 5);
    const oldV2 = await readFile(new URL("./fixtures/vcr/t05-2d-v2.vcr", import.meta.url)); // 版2の固定検体
    assert.equal((await readVcr(new Blob([oldV2]), REVIEW_VCR_LIMITS, verify)).project.mode, "2d");
    const doc = fixture({ billboard: "world-y", space: "world" }); // 現行設定
    const file = await writeVcr({ project: doc, images: new Map() }, REVIEW_VCR_LIMITS, verify, "0.0.0"); // 保存結果
    assert.deepEqual((await readVcr(file, REVIEW_VCR_LIMITS, verify)).project, doc);
    const migrated = validateProject({ ...doc, schemaVersion: 2, emitters: doc.emitters.map(({ particle3d, ...rest }) => rest) }); // 旧版の3D発生器
    assert.equal(migrated.emitters[0].particle3d.billboard, "camera");
    assert.equal(migrated.emitters[0].particle3d.speed, 0);
    assert.throws(() => validateProject({ ...doc, schemaVersion: 6 }));
});

test("壊れたファイルと保存中の追加編集でも3D文書と履歴を保護する", async () => {
    const flow = new ProjectFileFlow(fixture(), REVIEW_VCR_LIMITS, async () => {}, "0.0.0"); // 保存セッション
    const before = flow.history.snapshot; // 読込前の状態
    await assert.rejects(flow.open(new Blob(["bad"]), undefined, "discard"));
    assert.equal(flow.history.snapshot, before);
    await flow.save({ kind: "download", download() {
        const emitter = before.project.emitters[0]; // 保存中に変更する設定
        flow.history.execute({ kind: "emitter.update", emitterId: emitter.id, settings: {
            emission: emitter.emission, lifetimeUs: emitter.lifetimeUs, particle3d: { ...DEFAULT, billboard: "world-y" } } });
    }, async confirm() { return true; } });
    assert.equal(flow.history.isSaved, false);
});
