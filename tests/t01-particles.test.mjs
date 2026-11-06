import assert from "node:assert/strict";
import { test } from "node:test";
import { CYCLE_SECONDS, PARTICLE_COUNT, evaluateParticle } from "../src/verification/evaluateParticles.ts";

test("連続発生は最初の周期の未来の粒子を表示しない", () => {
    assert.equal(evaluateParticle(0, 0, "continuous", false).isVisible, true);
    assert.equal(evaluateParticle(PARTICLE_COUNT - 1, 0, "continuous", false).isVisible, false);
    assert.equal(evaluateParticle(PARTICLE_COUNT - 1, CYCLE_SECONDS, "continuous", false).isVisible, true);
});

test("Burstは同時に発生し、寿命終了後は次の周期まで表示しない", () => {
    for (let index = 0; index < PARTICLE_COUNT; index++) {
        assert.equal(evaluateParticle(index, 0, "burst", true).isVisible, true);
        assert.equal(evaluateParticle(index, 1.5, "burst", true).isVisible, false);
        assert.deepEqual(evaluateParticle(index, CYCLE_SECONDS, "burst", true), evaluateParticle(index, 0, "burst", true));
    }
});

test("2Dと3Dで同じ時刻のXY・透明度を保ち、3Dだけ奥行きを持つ", () => {
    const flat = evaluateParticle(3, 0.75, "burst", false); // 平面上の検証値
    const spatial = evaluateParticle(3, 0.75, "burst", true); // 奥行き付きの検証値
    assert.equal(flat.z, 0);
    assert.notEqual(spatial.z, 0);
    assert.deepEqual({ ...spatial, z: 0 }, flat);
});
