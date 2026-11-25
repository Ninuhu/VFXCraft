import { test } from "@playwright/test";

test("T11 保存・読込・IDB・復元のCPU経過時間", async ({ page }, info) => {
    test.setTimeout(240000);
    await page.goto("/");
    const results = await page.evaluate(async () => {
        const factoryPath = "/src/app/editor/projectFactory.ts", flowPath = "/src/app/projectFiles/projectFileFlow.ts";
        const archivePath = "/src/core/persistence/vcrArchive.ts", recoveryPath = "/src/app/editor/recovery.ts";
        const imagesPath = "/src/app/projectFiles/projectImages.ts", filesPath = "/src/app/projectFiles/browserProjectFiles.ts";
        const { newEditorProject } = await import(factoryPath), { ProjectFileFlow } = await import(flowPath);
        const { REVIEW_VCR_LIMITS, readVcr } = await import(archivePath), { recoverySnapshot, storeRecovery, readRecovery } = await import(recoveryPath);
        const { importProjectImage } = await import(imagesPath), { verifyBrowserImage } = await import(filesPath);
        const result = []; // 各条件でウォームアップ一回・計測五回
        for (const mode of ["2d", "3d"]) for (const size of ["small", "large"]) {
            const flow = new ProjectFileFlow(newEditorProject(mode, "sample", "T11 benchmark"), REVIEW_VCR_LIMITS, verifyBrowserImage, "test");
            const count = size === "small" ? 2 : 30; // 大条件は30層・最大深度29・600キー・画像4枚
            while (flow.history.preview.layers.length < count) flow.history.execute({ kind: "hierarchy.duplicate", layerId: flow.history.preview.layers[0].id });
            for (let i = 1; i < count; i++) flow.history.execute({ kind: "layer.reparent", layerId: flow.history.preview.layers[i].id, parentId: flow.history.preview.layers[i - 1].id, timeUs: 0 });
            for (const layer of flow.history.preview.layers) for (let key = 0; key < (size === "small" ? 2 : 20); key++)
                flow.history.execute({ kind: "key.add", layerId: layer.id, property: "opacity", key: { offsetUs: key * 100000, value: 0.5 + key / 100, interpolation: "linear" } });
            const canvas = document.createElement("canvas"); canvas.width = canvas.height = size === "small" ? 32 : 1024;
            const context = canvas.getContext("2d")!, pixels = context.createImageData(canvas.width, canvas.height);
            let random = 123456789; // 圧縮しやすい単色だけを測らない決定的な画像
            for (let i = 0; i < pixels.data.length; i++) {
                random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
                pixels.data[i] = i % 4 === 3 ? 255 : random >>> 24;
            }
            context.putImageData(pixels, 0, 0);
            const image = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
            for (let i = 0; i < (size === "small" ? 1 : 4); i++) await importProjectImage(flow, new File([image], "test-" + i + ".png"), verifyBrowserImage);
            const samples = []; let archiveBytes = 0;
            const heap = () => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize; // GC前後を固定しない観測値
            const heapBefore = heap(); let lastPulse = performance.now(), maxPulseGap = 0, pulseCount = 0;
            const pulse = setInterval(() => { const now = performance.now(); maxPulseGap = Math.max(maxPulseGap, now - lastPulse); lastPulse = now; pulseCount++; }, 10); // 応答性の粗い観測
            try { for (let i = 0; i < 6; i++) {
                let start = performance.now(); const entry = await recoverySnapshot(flow, verifyBrowserImage); const write = performance.now() - start;
                archiveBytes = entry.archive.size;
                start = performance.now(); await readVcr(entry.archive, REVIEW_VCR_LIMITS, verifyBrowserImage); const read = performance.now() - start;
                start = performance.now(); await storeRecovery(entry); const idb = performance.now() - start;
                start = performance.now(); await readRecovery(entry, verifyBrowserImage); const restore = performance.now() - start;
                if (i > 0) samples.push({ write, read, idb, restore });
            } } finally { clearInterval(pulse); }
            result.push({ mode, size, layers: count, keys: flow.history.preview.tracks.reduce((sum: number, track: { keys: unknown[] }) => sum + track.keys.length, 0),
                images: flow.history.preview.assets.length, imageDimensions: canvas.width, imageBytes: image.size, archiveBytes, samples,
                heapBefore, heapAfter: heap(), pulseCount, maxPulseGapMs: pulseCount ? maxPulseGap : null });
        }
        return { browser: navigator.userAgent, viewport: [innerWidth, innerHeight], results: result };
    });
    console.log("T11_PERSISTENCE_PERFORMANCE " + JSON.stringify(results));
    await info.attach("t11-performance.json", { body: JSON.stringify(results, null, 2), contentType: "application/json" });
});
