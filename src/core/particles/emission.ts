import type { Emitter } from "../document/model.ts";
import { MICROS_PER_SECOND } from "../document/time.ts";

const MAX_EVALUATED_PARTICLES = 200_000; // 評価1回の安全上限。製品性能目標とは分ける
export type EmissionWindow = { first: number; last: number; rate: number };

////////////////////
// 生存する粒子番号の範囲を絶対時刻から求める
export function emissionWindow(emitter: Emitter, elapsed: number): EmissionWindow {
    if (elapsed < 0 || (emitter.emission.kind === "burst" && elapsed >= emitter.lifetimeUs)) return { first: 0, last: -1, rate: 0 };
    const rate = emitter.emission.kind === "continuous" ? emitter.emission.ratePerSecond : 0; // 発生率
    if (emitter.emission.kind === "continuous" && rate === 0) return { first: 0, last: -1, rate };
    const first = emitter.emission.kind === "burst" ? 0
        : Math.max(0, Math.floor((elapsed - emitter.lifetimeUs) / MICROS_PER_SECOND * rate) + 1); // 終端は寿命外
    const last = emitter.emission.kind === "burst" ? emitter.emission.count - 1
        : Math.floor(elapsed / MICROS_PER_SECOND * rate); // 粒子番号0は時刻0
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last - first + 1 > MAX_EVALUATED_PARTICLES) {
        throw new RangeError("粒子数が検証用の安全上限を超えています。");
    }
    return { first, last, rate };
}
