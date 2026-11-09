import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BlobReader, BlobWriter, ZipWriter } from "@zip.js/zip.js";
import { createProject } from "../src/core/document/createProject.ts";
import { validateProject } from "../src/core/document/validateDocument.ts";
import { DEFAULT_APPEARANCE, DEFAULT_BACKGROUND, DEFAULT_PREVIEW, evaluateGradient, multiplyRgba,
    resolveBackground, toLinear, toSrgb } from "../src/core/materials/materialEvaluation.ts";
import { EditingHistory } from "../src/core/editing/history.ts";
import { readVcr, REVIEW_VCR_LIMITS, writeVcr } from "../src/core/persistence/vcrArchive.ts";

const MATERIAL_ID = "10000000-0000-4000-8000-000000000001"; // 材質の固定ID
const verify = async () => {}; // この検体は画像を含まない

////////////////////
// 材質を一つ持つ最小文書を作る
function fixture(mode = "2d") {
    return validateProject({ ...createProject({ id: "20000000-0000-4000-8000-000000000001", name: "T07", mode,
        ...(mode === "2d" ? { drawing: "normal", canvasWidth: 640, canvasHeight: 360 } : {}), durationUs: 2000000 }),
    materials: [{ id: MATERIAL_ID, color: [1, 1, 1], textureAssetId: null, blend: "alpha", gradient: [], hasBloom: false,
        appearance: DEFAULT_APPEARANCE }] });
}

test("独立した色と透明度の制御点をLinear sRGBで補間し端点を保持する", () => {
    const gradient = { colors: [{ offset: 0.25, value: [1, 0, 0] }, { offset: 0.75, value: [0, 0, 1] }],
        alphas: [{ offset: 0, value: 0 }, { offset: 0.5, value: 1 }, { offset: 1, value: 0 }] };
    assert.deepEqual(evaluateGradient(gradient, 0), [1, 0, 0, 0]);
    assert.deepEqual(evaluateGradient(gradient, 0.5), [0.5, 0, 0.5, 1]);
    assert.deepEqual(evaluateGradient(gradient, 1), [0, 0, 1, 0]);
    assert.deepEqual(evaluateGradient(DEFAULT_APPEARANCE.spatial, 0.5), [1, 1, 1, 1]);
    assert.ok(Math.abs(toLinear(toSrgb(0.5)) - 0.5) < 1e-12);
});

test("基本値・寿命・空間・テクスチャのRGBとアルファを独立に乗算する", () => {
    const layer = multiplyRgba([1, 0.5, 0.25, 0.5], [0.5, 1, 0, 0.5]);
    assert.deepEqual(multiplyRgba(multiplyRgba(layer, [0.5, 0.25, 1, 0.5]), [0.5, 1, 1, 0]),
        [0.125, 0.125, 0, 0]);
});

test("制御点を整列し、重複位置・非有限値・範囲外・不明な合成と素材欠損を拒否する", () => {
    const project = fixture(), material = project.materials[0]; // 基準の材質
    const alpha = (values) => ({ ...DEFAULT_APPEARANCE, spatial: { colors: [], alphas: values } });
    const stops = [{ offset: 1, value: 0 }, { offset: 0, value: 1 }];
    const valid = validateProject({ ...project, materials: [{ ...material, appearance: alpha(stops) }] });
    assert.deepEqual(valid.materials[0].appearance.spatial.alphas, stops.toReversed());
    for (const patch of [{ blend: "screen" }, { color: [2, 0, 0] }, { textureAssetId: project.id },
        { appearance: { ...DEFAULT_APPEARANCE, opacity: NaN } }, { appearance: { ...DEFAULT_APPEARANCE, bloomStrength: Infinity } },
        { appearance: { ...DEFAULT_APPEARANCE, bloomStrength: 9 } },
        { appearance: alpha([stops[0], stops[0]]) }, { appearance: alpha([{ offset: -0.01, value: 1 }]) },
        { appearance: alpha([{ offset: 0, value: 1.01 }]) }]) {
        assert.throws(() => validateProject({ ...project, materials: [{ ...material, ...patch }] }));
    }
    assert.throws(() => validateProject({ ...project, preview: { ...DEFAULT_PREVIEW, bloom: { radius: 33, threshold: 0 } } }));
});

test("部分上書きのfalseと0を保持し、解除すると環境設定へ戻る", () => {
    const common = { ...DEFAULT_BACKGROUND, checker: true, grid: true }; // 環境設定
    const result = resolveBackground(common, { checker: false, gridOpacity: 0 });
    assert.equal(result.checker, false);
    assert.equal(result.grid, true);
    assert.equal(result.gridOpacity, 0);
    assert.equal(resolveBackground(common, {}).checker, true);
});

test("マテリアルと背景の変更を履歴で管理し、不正値は確定しない", () => {
    const history = new EditingHistory(fixture()); // T03の経路
    const before = history.snapshot; // 変更前
    const token = history.beginContinuousEdit();
    for (const strength of [1, 2, 3]) history.updateContinuousEdit(token, { kind: "material.appearance", materialId: MATERIAL_ID,
        color: [1, 0, 0], blend: "multiply", appearance: { ...DEFAULT_APPEARANCE, bloomStrength: strength } });
    assert.equal(history.commitContinuousEdit(token), true);
    const material = history.snapshot; // 確定した一操作
    assert.equal(material.project.materials[0].appearance.bloomStrength, 3);
    assert.throws(() => history.execute({ kind: "project.preview", preview: { ...DEFAULT_PREVIEW, background: { gridOpacity: Infinity } } }));
    assert.equal(history.snapshot, material);
    history.execute({ kind: "project.preview", preview: { ...DEFAULT_PREVIEW, pixelBloom: "smooth", background: { grid: false, gridOpacity: 0 } } });
    assert.equal(history.snapshot.project.preview.pixelBloom, "smooth");
    history.undo(); assert.equal(history.snapshot, material);
    history.undo(); assert.equal(history.snapshot, before);
    history.redo(); assert.equal(history.snapshot, material);
});

test("固定されたT04・T05検体とT06のZIPを読み、旧フィールドを保つ", async () => {
    for (const name of ["t04-2d-v1.vcr", "t04-3d-v1.vcr", "t05-2d-v2.vcr"]) {
        const bytes = await readFile(new URL("./fixtures/vcr/" + name, import.meta.url));
        const { project } = await readVcr(new Blob([bytes]), REVIEW_VCR_LIMITS, verify);
        assert.equal(project.schemaVersion, 4);
        assert.ok(project.materials.every((material) => material.appearance === undefined));
    }
    const doc = fixture("3d"); // スキーマ3の旧フィールドだけで構成する
    const materials = doc.materials.map(({ appearance, ...old }) => ({ ...old, hasBloom: true,
        gradient: [{ offset: 0, color: [1, 0, 0] }] }));
    const zip = new ZipWriter(new BlobWriter(), { level: 0, useWebWorkers: false }); // 版3のコンテナ
    await zip.add("metadata.json", new BlobReader(new Blob([JSON.stringify({ format: "VFXCraft", containerVersion: 1, createdByVersion: "0.0.0" })])));
    await zip.add("project.json", new BlobReader(new Blob([JSON.stringify({ ...doc, schemaVersion: 3, materials })])));
    const { project } = await readVcr(await zip.close(), REVIEW_VCR_LIMITS, verify);
    assert.equal(project.materials[0].appearance, undefined);
    assert.equal(project.materials[0].hasBloom, true);
    assert.deepEqual(project.materials[0].gradient, materials[0].gradient);
});

test("版4の材質と背景上書きが2D・3Dの.vcrで往復する", async () => {
    for (const mode of ["2d", "3d"]) {
        const base = fixture(mode); // 各モードの文書
        const project = validateProject({ ...base, preview: { ...DEFAULT_PREVIEW, pixelBloom: "smooth", background: { grid: false, gridOpacity: 0 } },
            materials: [{ ...base.materials[0], blend: "multiply", appearance: { ...DEFAULT_APPEARANCE, bloomStrength: 4 } }] });
        const file = await writeVcr({ project, images: new Map() }, REVIEW_VCR_LIMITS, verify, "0.0.0");
        assert.deepEqual((await readVcr(file, REVIEW_VCR_LIMITS, verify)).project, project);
        assert.throws(() => validateProject({ ...project, schemaVersion: 5 }));
        assert.throws(() => validateProject({ ...project, preview: { ...project.preview, unknown: true } }));
    }
});
