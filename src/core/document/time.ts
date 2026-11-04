import type { Project } from "./model.ts";

export const MICROS_PER_SECOND = 1_000_000; // マイクロ秒と秒の変換倍率
const MAX_SAFE_TIME = BigInt(Number.MAX_SAFE_INTEGER); // JSON数値で正確に表現できる時刻上限

////////////////////
// 保存できる非負の整数を判定する
export function isNonNegativeSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

////////////////////
// 制作フレームを整数マイクロ秒で区別できるFPSか判定する
export function isProductionFps(value: unknown): value is number {
    return isNonNegativeSafeInteger(value) && value > 0 && value <= MICROS_PER_SECOND;
}

////////////////////
// 絶対フレーム番号から最寄りのマイクロ秒を求め、中間値は上へ丸める
export function frameToTimeUs(frame: number, fps: number): number {
    if (!isNonNegativeSafeInteger(frame)) throw new RangeError("フレーム番号が不正です。");
    if (!isProductionFps(fps)) throw new RangeError("制作FPSが不正です。");

    const numerator = BigInt(frame) * BigInt(MICROS_PER_SECOND); // 丸め前の時刻の分子
    const denominator = BigInt(fps); // 丸め前の時刻の分母
    const rounded = (2n * numerator + denominator) / (2n * denominator); // 整数演算による四捨五入
    if (rounded > MAX_SAFE_TIME) throw new RangeError("フレーム時刻が安全整数範囲を超えます。");
    return Number(rounded);
}

////////////////////
// 制作FPSだけを変更し、既存のマイクロ秒値は保持する
export function withProductionFps(project: Project, productionFps: number): Project {
    if (!isProductionFps(productionFps)) throw new RangeError("制作FPSが不正です。");
    return { ...project, productionFps };
}
