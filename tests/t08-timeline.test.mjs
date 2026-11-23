import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BlobReader, BlobWriter, ZipWriter } from "@zip.js/zip.js";
import { createProject } from "../src/core/document/createProject.ts";
import { validateProject } from "../src/core/document/validateDocument.ts";
import { evaluateTrack } from "../src/core/document/evaluateTrack.ts";
import { playbackPosition, parseTimelineTime, PLAYBACK_SPEEDS, snapTimeUs, timeUsToFrame } from "../src/core/document/playback.ts";
import { frameToTimeUs } from "../src/core/document/time.ts";
import { EditingHistory } from "../src/core/editing/history.ts";
import { evaluateParticles2D } from "../src/core/particles/evaluate2D.ts";
import { evaluateParticles3D } from "../src/core/particles/evaluate3D.ts";
import { collectMaterialParticles, tintMaterialParticles } from "../src/rendering/materialParticleData.ts";
import { readVcr, writeVcr, REVIEW_VCR_LIMITS } from "../src/core/persistence/vcrArchive.ts";

const SEC = 1_000_000; // µs
const LAYER = "10000000-0000-4000-8000-000000000001"; // レイヤーID
const EMITTER = "10000000-0000-4000-8000-000000000002";
const MATERIAL = "10000000-0000-4000-8000-000000000003";
const PROJECT = "10000000-0000-4000-8000-000000000004";
const PARENT = "10000000-0000-4000-8000-000000000005";

////////////////////
// 座標と発生だけを最小限設定した2Dまたは3D文書を作る
function fixture(mode = "2d", tracks = [], settings = {}) {
    const is2D = mode === "2d";
    const origin = is2D ? [0, 0] : [0, 0, 0];
    const values = { position: origin, rotation: is2D ? 0 : [0, 0, 0, 1], size: is2D ? [1, 1] : [1, 1, 1],
        color: [1, 1, 1], opacity: 1 };
    const doc = createProject({ id: PROJECT, name: "T08", mode, durationUs: 8 * SEC,
        ...(is2D ? { drawing: "normal", canvasWidth: 640, canvasHeight: 360 } : {}) });
    return validateProject({ ...doc, tracks,
        layers: [{ id: LAYER, name: "粒子", parentId: null, order: 0, isVisible: true, isLocked: false, startUs: 0,
            content: { kind: "emitter", emitterId: EMITTER }, values, ...settings.layer }, ...(settings.parents ?? [])],
        emitters: [{ id: EMITTER, materialId: MATERIAL, lifetimeUs: 4 * SEC, emission: { kind: "continuous", ratePerSecond: 2 },
            ...(is2D ? { particle2d: { speed: 1, directionDegrees: 0, acceleration: origin, space: "local", seed: 3, shape: { kind: "point" } } }
                : { particle3d: { speed: 1, direction: [1, 0, 0], acceleration: origin, space: "local", seed: 3, shape: "point", billboard: "camera" } }),
            ...settings.emitter }],
        materials: [{ id: MATERIAL, textureAssetId: null, blend: "alpha", color: [1, 1, 1], hasBloom: false, gradient: [] }],
    });
}

////////////////////
// 対象レイヤーのキーを短く定義する
function track(property, ...points) {
    return { layerId: LAYER, property, interpolation: "linear",
        keys: points.map(([offsetUs, value, interpolation]) => ({ offsetUs, value, ...(interpolation ? { interpolation } : {}) })) };
}

////////////////////
// 二つのモードで同じ時刻を評価する
function sample(project, time) {
    return project.mode === "2d" ? evaluateParticles2D(project, LAYER, time) : evaluateParticles3D(project, time);
}

test("再生の半開区間、任意シークと停止位置、7倍率を確認する", () => {
    const end = 2 * SEC;
    assert.equal(playbackPosition(0, frameToTimeUs(119, 60), end, true), 1_983_333);
    assert.equal(playbackPosition(0, frameToTimeUs(120, 60), end, true), 0);
    assert.equal(playbackPosition(end, 0, end, false), end);
    assert.equal(playbackPosition(1_500_000, 5_000_001, end, true), 500_001);
    assert.throws(() => playbackPosition(-1, 0, end, true));
    assert.deepEqual(PLAYBACK_SPEEDS, [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]);
});

test("秒とフレームを変換し、フレーム入力とドラッグ丸めを区別する", () => {
    assert.equal(timeUsToFrame(1_500_000, 60), 90);
    assert.equal(parseTimelineTime("90", "frames", 60), 1_500_000);
    assert.equal(parseTimelineTime("0.123456", "seconds", 60), 123456);
    assert.equal(snapTimeUs(123456, 60, SEC), 116667);
    assert.throws(() => parseTimelineTime("1.5", "frames", 60));
    assert.throws(() => parseTimelineTime("-1", "seconds", 60));
    assert.throws(() => parseTimelineTime("3", "frames", 0));
});

test("先頭・末尾・ゼロキーと、左キーが所有するLinear/Stepを評価する", () => {
    const item = track("speed", [SEC, 4, "step"], [2 * SEC, 8, "linear"], [3 * SEC, 12]);
    assert.equal(evaluateTrack(item, 0, 1), 4);
    assert.equal(evaluateTrack(item, 2 * SEC - 1, 1), 4);
    assert.equal(evaluateTrack(item, 2 * SEC, 1), 8);
    assert.equal(evaluateTrack(item, 2.5 * SEC, 1), 10);
    assert.equal(evaluateTrack(item, 4 * SEC, 1), 12);
    assert.equal(evaluateTrack(track("speed"), 0, 1), 1);
    assert.equal(evaluateTrack(track("speed", [SEC, 4]), 3 * SEC, 1), 4);
    assert.equal(evaluateTrack({ ...item, beforeFirst: "base" }, 0, 1), 1);
});

test("3D回転LinearはQuaternionのSLERP、Stepは直前の姿勢を保持する", () => {
    const item = track("rotation", [0, [0, 0, 0, 1]], [SEC, [0, 1, 0, 0]]);
    const value = evaluateTrack(item, SEC / 2, [0, 0, 0, 1]);
    assert.ok(Math.abs(value[1] - Math.SQRT1_2) < 1e-12);
    assert.ok(Math.abs(value[3] - Math.SQRT1_2) < 1e-12);
    assert.deepEqual(evaluateTrack({ ...item, interpolation: "step" }, SEC / 2, null), [0, 0, 0, 1]);
});

test("同時刻はトラック間で許可し、衝突の取消・上書き・Undo/Redoを原子的に処理する", () => {
    const history = new EditingHistory(fixture("2d", [track("speed", [0, 2, "step"], [SEC, 7]), track("bloomStrength", [SEC, 2])]));
    const old = history.snapshot.project; // キー二つがある文書
    const move = { kind: "key.update", layerId: LAYER, property: "speed", offsetUs: 0, key: { offsetUs: SEC, value: 2 } };
    assert.throws(() => history.execute(move), /移動先/);
    assert.equal(history.snapshot.project, old);
    assert.equal(history.canUndo, false);
    history.execute({ ...move, overwrite: true });
    assert.deepEqual(history.snapshot.project.tracks[0].keys, [{ offsetUs: SEC, value: 2, interpolation: "step" }]);
    history.undo();
    assert.equal(history.snapshot.project, old);
    history.redo();
    assert.equal(history.snapshot.project.tracks[0].keys.length, 1);
    history.execute({ kind: "key.remove", layerId: LAYER, property: "speed", offsetUs: SEC });
    assert.equal(history.snapshot.project.tracks.length, 1);
});

test("尺の短縮に確認を要求し、範囲外キー保持と削除を一操作で戻す", () => {
    const original = fixture("2d", [track("speed", [0, 2], [6 * SEC, 7])], { layer: { emissionEndUs: SEC } });
    const history = new EditingHistory(original);
    const shorten = { kind: "timeline.duration", durationUs: 3 * SEC };
    assert.throws(() => history.execute(shorten), /処理を選んで/);
    history.execute({ ...shorten, outside: "keep" });
    assert.equal(history.snapshot.project.tracks[0].keys[1].offsetUs, 6 * SEC);
    history.undo();
    history.execute({ ...shorten, outside: "delete" });
    assert.equal(history.snapshot.project.tracks[0].keys.length, 1);
    history.undo();
    assert.equal(history.snapshot.project.durationUs, 8 * SEC);
    assert.equal(history.snapshot.project.tracks[0].keys.length, 2);
    history.execute({ kind: "timeline.fps", productionFps: 30 });
    assert.deepEqual(history.snapshot.project.tracks, original.tracks);
});

test("2D・3Dとも開始を含み、終了で発生を止めて寿命が残る粒子だけを維持する", () => {
    for (const mode of ["2d", "3d"]) {
        const project = fixture(mode, [], { layer: { startUs: SEC, emissionEndUs: 2 * SEC } });
        assert.equal(sample(project, SEC - 1).length, 0);
        assert.equal(sample(project, SEC).length, 1);
        assert.equal(sample(project, 2 * SEC).length, 2);
        assert.equal(sample(project, 5 * SEC).length, 1);
        assert.equal(sample(project, 5.5 * SEC).length, 0);
        const burst = fixture(mode, [], { layer: { startUs: SEC, emissionEndUs: 2 * SEC },
            emitter: { emission: { kind: "burst", count: 5 } } });
        assert.equal(sample(burst, SEC).length, 5);
        assert.equal(sample(burst, 3 * SEC).length, 5);
        assert.equal(sample(burst, 5 * SEC).length, 0);
    }
});

test("可変発生率を積分し、初速・寿命・粒子サイズを各発生時の値に固定する", () => {
    for (const mode of ["2d", "3d"]) {
        const project = fixture(mode, [track("rate", [0, 2], [2 * SEC, 6]), track("speed", [0, 1, "step"], [SEC, 5]),
            track("lifetimeUs", [0, 2 * SEC, "step"], [SEC, 5 * SEC]), track("particleSize", [0, 1, "step"], [SEC, 2])]);
        assert.equal(sample(project, SEC).length, 4); // 積分量3と時刻0の粒子
        const later = sample(project, 1.5 * SEC);
        assert.equal(later[0].position[0], 1.5);
        assert.equal(later[0].age, 0.75);
        assert.equal(mode === "2d" ? later[3].size : later[3].width, mode === "2d" ? 2 : 0.4);
        assert.equal(sample(project, 2 * SEC).some((entry) => mode === "2d" ? entry.id === 0 : entry.key.endsWith(":0")), false);
    }
});

test("発生率0の区間と半開終端では新規発生しない", () => {
    for (const mode of ["2d", "3d"]) {
        const rates = track("rate", [0, 0, "step"], [SEC, 2, "step"], [2 * SEC, 0]);
        const project = fixture(mode, [rates], { layer: { emissionEndUs: 2 * SEC } });
        assert.equal(sample(project, SEC).length, 0);
        assert.equal(sample(project, 1.5 * SEC - 1).length, 0);
        assert.equal(sample(project, 1.5 * SEC).length, 1);
        assert.equal(sample(project, 3 * SEC).length, 1);
        assert.equal(sample(project, 5.5 * SEC).length, 0);
    }
});

test("世界空間は発生時、ローカル空間は現在の親変換を使う", () => {
    for (const mode of ["2d", "3d"]) {
        const is2D = mode === "2d";
        const vec = (x) => is2D ? [x, 0] : [x, 0, 0];
        const parent = { ...fixture(mode).layers[0], id: PARENT, content: { kind: "group" } };
        const moving = { ...track("position", [0, vec(0)], [SEC, vec(10)]), layerId: PARENT };
        for (const space of ["local", "world"]) {
            const settings = fixture(mode).emitters[0][is2D ? "particle2d" : "particle3d"];
            const project = fixture(mode, [moving], { layer: { parentId: PARENT }, parents: [parent],
                emitter: { [is2D ? "particle2d" : "particle3d"]: { ...settings, space } } });
            assert.equal(sample(project, SEC)[0].position[0], space === "local" ? 11 : 1);
        }
    }
});

test("時刻の順序、制作FPS、速度やループ経由の同一時刻で結果が一致する", () => {
    for (const mode of ["2d", "3d"]) {
        const project = fixture(mode, [track("rate", [0, 2], [SEC, 12, "step"], [3 * SEC, 0])]);
        const expected = sample(project, 2 * SEC);
        sample(project, 7 * SEC); sample(project, 0);
        assert.deepEqual(sample(project, 2 * SEC), expected);
        assert.deepEqual(sample({ ...project, productionFps: 24 }, playbackPosition(0, 10 * SEC, 8 * SEC, true)), expected);
        assert.deepEqual(sample(project, playbackPosition(0, 2 * SEC * 1, 8 * SEC, true)), expected);
    }
});

test("材質色・材質透明度・Bloom・レイヤー透明度は現在時刻で更新する", () => {
    for (const mode of ["2d", "3d"]) {
        const project = fixture(mode, [track("materialColor", [0, [1, 0, 0]], [SEC, [0, 0, 1]]),
            track("materialOpacity", [0, 0.5]), track("opacity", [0, 0.4]), track("bloomStrength", [0, 0], [SEC, 4])]);
        const result = tintMaterialParticles(collectMaterialParticles(project, SEC / 2), new Map(project.materials.map((material) =>
            [material.id, material])))[0];
        assert.deepEqual(result.color, [0.5, 0, 0.5]);
        assert.equal(result.opacity, 0.2);
        assert.equal(result.bloomStrength, 2);
    }
});

test("不正な終了時刻・キー値・補間・トラック参照を拒否する", () => {
    assert.throws(() => fixture("2d", [], { layer: { startUs: SEC, emissionEndUs: SEC - 1 } }));
    assert.throws(() => fixture("2d", [track("speed", [0, Infinity])]));
    assert.throws(() => fixture("2d", [track("speed", [0, 1, "curve"])]));
    assert.throws(() => fixture("2d", [track("speed", [0, 1], [0, 2])]));
    assert.throws(() => fixture("3d", [track("direction", [0, [0, 0, 0]])]));
    assert.throws(() => fixture("2d", [{ ...track("speed", [0, 1]), layerId: PARENT }]));
});

test("旧固定検体と版3・4を開き、版5の区間補間と範囲外保持を保存往復する", async () => {
    const verify = async () => {}; // この検体は画像なし
    for (const name of ["t04-2d-v1.vcr", "t04-3d-v1.vcr", "t05-2d-v2.vcr"]) {
        const bytes = await readFile(new URL("./fixtures/vcr/" + name, import.meta.url));
        assert.equal((await readVcr(new Blob([bytes]), REVIEW_VCR_LIMITS, verify)).project.schemaVersion, 6);
    }
    for (const version of [3, 4]) {
        const doc = { ...fixture("2d", [track("opacity", [SEC, 0.5])]), schemaVersion: version };
        const zip = new ZipWriter(new BlobWriter(), { level: 0, useWebWorkers: false });
        await zip.add("metadata.json", new BlobReader(new Blob([JSON.stringify({ format: "VFXCraft", containerVersion: 1, createdByVersion: "0.0.0" })])));
        await zip.add("project.json", new BlobReader(new Blob([JSON.stringify(doc)])));
        const { project } = await readVcr(await zip.close(), REVIEW_VCR_LIMITS, verify);
        assert.equal(project.tracks[0].beforeFirst, "base");
        assert.equal(evaluateTrack(project.tracks[0], 0, 1), 1);
    }
    const base = fixture("3d", [track("speed", [0, 1, "step"], [SEC, 2])], { layer: { emissionEndUs: 2 * SEC } });
    const history = new EditingHistory(base);
    history.execute({ kind: "timeline.duration", durationUs: 500_000, outside: "keep" });
    const project = history.snapshot.project;
    const file = await writeVcr({ project, images: new Map() }, REVIEW_VCR_LIMITS, verify, "0.0.0");
    assert.deepEqual((await readVcr(file, REVIEW_VCR_LIMITS, verify)).project, project);
    assert.throws(() => validateProject({ ...project, schemaVersion: 7 }));
});
