import assert from "node:assert/strict";
import { test } from "node:test";
import { recoverGlowAlpha } from "../src/verification/exportTransparentPng.ts";
import { validateSnapshot } from "../src/verification/verificationStorage.ts";

test("発光だけの画素を半透明で残し、黒背景に再合成すると元の色を再現する", () => {
    const pixels = new Uint8ClampedArray([1, 2, 7, 255, 20, 60, 100, 255, 30, 15, 0, 255]); // 極低輝度の裾・発光・粒子本体
    const coverage = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128]); // 粒子本体だけの被覆率
    recoverGlowAlpha(pixels, coverage);
    assert.deepEqual([...pixels.slice(0, 4)], [0, 0, 0, 0]);
    assert.equal(pixels[7], 100);
    assert.equal(pixels[11], 128);
    assert.deepEqual([...pixels.slice(4, 7)].map((value) => Math.round(value * 100 / 255)), [20, 60, 100]);
});

test("設定・時刻・画像を検証し、未知の版や壊れた設定を拒否する", () => {
    const image = new Blob(["型検証用のデータ"], { type: "image/png" }); // 実画像の復号はブラウザで確認する
    const options = { mode: "3d", emission: "burst", isPlaying: false, isAdditive: true, hasBloom: true }; // 有効な検証設定
    const snapshot = { version: 1, options, seconds: 0.5, image }; // 保存枠から読み出す値
    assert.deepEqual(validateSnapshot(snapshot), snapshot);
    for (const invalid of [undefined, { ...snapshot, version: 2 }, { ...snapshot, seconds: Infinity },
        { ...snapshot, options: { ...options, mode: "unknown" } }, { ...snapshot, image: new Blob() }]) {
        assert.throws(() => validateSnapshot(invalid));
    }
});
