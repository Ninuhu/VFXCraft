import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { newEditorProject } from "../src/app/editor/projectFactory.ts";
import { ProjectFileFlow } from "../src/app/projectFiles/projectFileFlow.ts";
import { AutosaveController } from "../src/app/editor/autosave.ts";
import { recoverySnapshot, readRecovery, isRecoveryEntry } from "../src/app/editor/recovery.ts";
import { persistenceErrorMessage } from "../src/app/editor/persistenceErrors.ts";
import { importProjectImage } from "../src/app/projectFiles/projectImages.ts";
import { propertyCommand } from "../src/app/editor/propertyEditing.ts";
import { readVcr, REVIEW_VCR_LIMITS } from "../src/core/persistence/vcrArchive.ts";
import { evaluateParticles2D } from "../src/core/particles/evaluate2D.ts";
import { evaluateParticles3D } from "../src/core/particles/evaluate3D.ts";
import { BlobReader, BlobWriter, ZipWriter } from "@zip.js/zip.js";
import { writeVcr } from "../src/core/persistence/vcrArchive.ts";
import { evaluateTrack } from "../src/core/document/evaluateTrack.ts";

const verify = async () => {}; // 実デコードは隔離Chrome/Edgeで検証
const flowOf = (mode = "2d", template = "basic") => new ProjectFileFlow(newEditorProject(mode, template, "T11"), REVIEW_VCR_LIMITS, verify, "test");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMIqDjxHwAFPAKQ8H9qXAAAAABJRU5ErkJggg==", "base64");
const edit = (flow, name) => flow.history.execute({ kind: "layer.update", layerId: flow.history.preview.layers[0].id, patch: { name } });
const particles = (project, time) => project.mode === "2d"
    ? project.layers.map((layer) => evaluateParticles2D(project, layer.id, time)) : evaluateParticles3D(project, time);

for (const mode of ["2d", "3d"]) for (const template of ["empty", "sample"]) {
    test(`T11 ${mode} ${template}: 全文書・階層・キー・共有/未使用素材・粒子の意味的往復`, async () => {
        const flow = flowOf(mode, template);
        const image = await importProjectImage(flow, new File([png], "pixel.png"), verify);
        await importProjectImage(flow, new File([png], "unused.png"), verify);
        if (flow.history.preview.layers.length) {
            const [parent, child] = flow.history.preview.layers;
            flow.history.execute({ kind: "layer.reparent", layerId: child.id, parentId: parent.id, timeUs: 0 });
            for (const material of flow.history.preview.materials) flow.history.execute({ kind: "material.setTexture", materialId: material.id, assetId: image.id });
            flow.history.execute(propertyCommand(flow.history.preview, parent, "opacity", 0.4, 1e6, true));
        }
        const before = flow.history.snapshot;
        const entry = await recoverySnapshot(flow, verify), loaded = await readRecovery(entry, verify);
        assert.deepEqual(loaded.project, before.project);
        assert.equal(loaded.images.size, 2);
        for (const bytes of loaded.images.values()) assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), png);
        for (const time of [0, 100000, 1000000, 2500000]) assert.deepEqual(particles(loaded.project, time), particles(before.project, time));
        assert.equal(flow.history.snapshot, before); assert.equal(flow.history.isSaved, false);
        const restored = new ProjectFileFlow(loaded.project, REVIEW_VCR_LIMITS, verify, "test");
        assert.equal(restored.history.canUndo, false); assert.equal(restored.history.isSaved, false);
    });
}

test("T11 自動保存は同一文書でも別世代になり、メタデータと実文書の不一致を拒否", async () => {
    const flow = flowOf(), first = await recoverySnapshot(flow, verify), second = await recoverySnapshot(flow, verify);
    assert.notEqual(first.id, second.id); assert.ok(second.sequence > first.sequence);
    for (const bad of [null, {}, { ...first, savedAt: NaN }, { ...first, archive: "bad" }, { ...first, mode: "4d" }]) assert.equal(isRecoveryEntry(bad), false);
    await assert.rejects(() => readRecovery({ ...first, projectId: crypto.randomUUID() }, verify));
    await assert.rejects(() => readRecovery({ ...first, mode: "3d" }, verify));
});

test("T11 変更なし・プレビュー操作は書込せず、確定編集をデバウンス", async () => {
    const flow = flowOf(), entries = [], controller = new AutosaveController(flow, verify, { store: async (entry) => { entries.push(entry); }, delayMs: 5 });
    try {
        controller.observe(); await controller.flush();
        for (let i = 0; i < 5; i++) controller.observe();
        await delay(20); assert.equal(entries.length, 1);
        edit(flow, "a"); controller.observe(); edit(flow, "b"); controller.observe(); await delay(40);
        assert.equal(entries.length, 2); assert.equal((await readRecovery(entries[1], verify)).project.layers[0].name, "b");
        assert.equal(flow.history.isSaved, false);
    } finally { controller.dispose(); }
});

test("T11 連続入力の途中値は保存せず、確定後だけ一世代、取消は変更なし", async () => {
    const flow = flowOf(), entries = [], controller = new AutosaveController(flow, verify, { store: async (entry) => { entries.push(entry); }, delayMs: 5 });
    try {
        await controller.flush();
        const token = flow.history.beginContinuousEdit();
        flow.history.updateContinuousEdit(token, { kind: "layer.update", layerId: flow.history.preview.layers[0].id, patch: { name: "preview" } });
        controller.observe(); await controller.flush(); assert.equal(entries.length, 1);
        flow.history.cancelContinuousEdit(token); controller.observe(); await controller.flush(); assert.equal(entries.length, 1);
        const next = flow.history.beginContinuousEdit();
        flow.history.updateContinuousEdit(next, { kind: "layer.update", layerId: flow.history.preview.layers[0].id, patch: { name: "committed" } });
        flow.history.commitContinuousEdit(next); controller.observe(); await controller.flush(); assert.equal(entries.length, 2);
    } finally { controller.dispose(); }
});

test("T11 非同期自動保存を直列化し、追加編集を次世代へ確保", async () => {
    const flow = flowOf(), entries = []; let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const controller = new AutosaveController(flow, verify, { store: async (entry) => { entries.push(entry); if (entries.length === 1) await gate; } });
    try {
        const first = controller.flush(); await delay(30); edit(flow, "newer");
        const second = controller.flush(); release(); await Promise.all([first, second]);
        assert.equal(entries.length, 2); assert.notEqual(entries[0].id, entries[1].id);
        assert.equal((await readRecovery(entries[0], verify)).project.layers[0].name, "新しい粒子");
        assert.equal((await readRecovery(entries[1], verify)).project.layers[0].name, "newer");
    } finally { release(); controller.dispose(); }
});

test("T11 自動保存失敗は文書・保存位置を維持し、再試行可能", async () => {
    const flow = flowOf(), states = []; let failed = true;
    flow.history.markSaved(flow.history.snapshot); edit(flow, "unsaved"); const before = flow.history.snapshot;
    const controller = new AutosaveController(flow, verify, { store: async () => { if (failed) throw new DOMException("quota", "QuotaExceededError"); }, onState: (state) => states.push(state) });
    try {
        await assert.rejects(() => controller.flush()); assert.equal(flow.history.snapshot, before); assert.equal(flow.history.isSaved, false);
        failed = false; await controller.flush(); assert.equal(states.at(-1), "saved");
        flow.history.undo(); assert.equal(flow.history.isSaved, true); await controller.flush(); assert.equal(flow.history.isSaved, true);
        flow.history.redo(); assert.equal(flow.history.isSaved, false);
    } finally { controller.dispose(); }
});

test("T11 別名保存の取消・書込失敗でも以前の上書き先を維持", async () => {
    const flow = flowOf(), files = [], target = { write: async (file) => { files.push(file); } };
    const route = { kind: "overwrite", getTarget: async () => target };
    await flow.save(route); edit(flow, "changed"); const before = flow.history.snapshot;
    await assert.rejects(() => flow.save({ kind: "overwrite", getTarget: async () => { throw new DOMException("cancel", "AbortError"); } }, true));
    await assert.rejects(() => flow.save({ kind: "overwrite", getTarget: async () => ({ write: async () => { throw new Error("disk"); } }) }, true));
    assert.equal(flow.history.snapshot, before); assert.equal(flow.history.isSaved, false);
    await flow.save({ kind: "overwrite", getTarget: async () => { throw new Error("既存保存先を再利用するはず"); } });
    assert.equal(files.length, 2); assert.equal(flow.history.isSaved, true);
});

test("T11 保存中の重複要求を拒否し、保存中の素材追加・編集を保存済みにしない", async () => {
    const flow = flowOf(); let release, started;
    const writing = new Promise((resolve) => { started = resolve; }), gate = new Promise((resolve) => { release = resolve; });
    let saved;
    const save = flow.save({ kind: "overwrite", getTarget: async () => ({ write: async (file) => { saved = file; started(); await gate; } }) });
    await writing;
    await assert.rejects(() => flow.save({ kind: "download", download() {}, confirm: async () => true }));
    await importProjectImage(flow, new File([png], "later.png"), verify); edit(flow, "later");
    release(); assert.equal(await save, true); assert.equal(flow.history.isSaved, false);
    assert.equal((await readVcr(saved, REVIEW_VCR_LIMITS, verify)).project.assets.length, 0);
});

test("T11 旧プロジェクトの保存完了を新しいプロジェクトへ適用しない", async () => {
    const flow = flowOf(); let release, started;
    const writing = new Promise((resolve) => { started = resolve; }), gate = new Promise((resolve) => { release = resolve; });
    const saving = flow.save({ kind: "overwrite", getTarget: async () => ({ write: async () => { started(); await gate; } }) });
    await writing; flow.history.replaceProject(newEditorProject("3d", "empty", "new"), "new");
    release(); assert.equal(await saving, false); assert.equal(flow.history.isSaved, false); assert.equal(flow.history.preview.mode, "3d");
});

test("T11 容量不足・アクセス拒否・中断を分かりやすい原因に変換", () => {
    assert.match(persistenceErrorMessage(new DOMException("quota", "QuotaExceededError")), /容量/);
    assert.match(persistenceErrorMessage(new DOMException("permission", "NotAllowedError")), /アクセス/);
    assert.match(persistenceErrorMessage(new DOMException("abort", "AbortError")), /中断/);
});

for (const version of [1, 2, 3, 4, 5, 6]) test(`T11 論理版${version}を再保存して先頭キー以前の互換動作を維持`, async () => {
    const flow = flowOf(), layer = flow.history.preview.layers[0];
    flow.history.execute({ kind: "key.add", layerId: layer.id, property: "opacity", key: { offsetUs: 1e6, value: 0.25, interpolation: "linear" } });
    const doc = structuredClone(flow.history.snapshot.project); doc.schemaVersion = version;
    if (version < 4) {
        delete doc.preview;
        for (const material of doc.materials) delete material.appearance;
    }
    if (version === 1) { delete doc.pixelScale; for (const emitter of doc.emitters) delete emitter.particle2d; }
    const writer = new ZipWriter(new BlobWriter(), { level: 0, useWebWorkers: false });
    await writer.add("metadata.json", new BlobReader(new Blob([JSON.stringify({ format: "VFXCraft", containerVersion: 1, createdByVersion: "test" })])));
    await writer.add("project.json", new BlobReader(new Blob([JSON.stringify(doc)])));
    const loaded = await readVcr(await writer.close(), REVIEW_VCR_LIMITS, verify);
    const reopened = await readVcr(await writeVcr(loaded, REVIEW_VCR_LIMITS, verify, "test"), REVIEW_VCR_LIMITS, verify);
    assert.deepEqual(reopened.project, loaded.project);
    assert.equal(evaluateTrack(reopened.project.tracks[0], 0, 1), version < 5 ? 1 : 0.25);
});
