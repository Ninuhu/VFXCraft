import { frameToTimeUs, isNonNegativeSafeInteger, isProductionFps, MICROS_PER_SECOND } from "./time.ts";

export const PLAYBACK_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2] as const; // 検証済みの倍率候補
export type PlaybackSpeed = typeof PLAYBACK_SPEEDS[number];

////////////////////
// 壁時計の差から時刻を求める。ループは終端を除き、停止する場合は終端に固定する
export function playbackPosition(startUs: number, elapsedUs: number, durationUs: number, loop: boolean): number {
    if (!isNonNegativeSafeInteger(startUs) || !isNonNegativeSafeInteger(elapsedUs)
        || !isNonNegativeSafeInteger(durationUs) || durationUs === 0 || startUs > durationUs) {
        throw new RangeError("再生時刻が不正です。");
    }
    const remaining = durationUs - startUs; // 足し算で安全整数を超えないよう差で比較
    if (elapsedUs < remaining) return startUs + elapsedUs;
    return loop ? (elapsedUs - remaining) % durationUs : durationUs;
}

////////////////////
// 表示用の最近傍フレーム番号を整数演算で得る
export function timeUsToFrame(timeUs: number, fps: number): number {
    if (!isNonNegativeSafeInteger(timeUs) || !isProductionFps(fps)) throw new RangeError("フレーム時刻が不正です。");
    return Number((2n * BigInt(timeUs) * BigInt(fps) + BigInt(MICROS_PER_SECOND)) / (2n * BigInt(MICROS_PER_SECOND)));
}

////////////////////
// ドラッグだけで使う制作フレームへの丸め。制限位置を越える候補は手前のフレームを使う
export function snapTimeUs(timeUs: number, fps: number, maximum: number, minimum = 0): number {
    const frame = timeUsToFrame(timeUs, fps); // 近い制作フレーム
    let result = frameToTimeUs(frame, fps); // ADR-003の整数µsへ戻す
    if (result > maximum && frame > 0) result = frameToTimeUs(frame - 1, fps);
    if (result < minimum) result = frameToTimeUs(frame + 1, fps);
    return Math.max(minimum, Math.min(maximum, result));
}

////////////////////
// 秒は整数µsへ一度だけ丸め、フレーム入力は整数番号を要求する
export function parseTimelineTime(input: string, unit: "seconds" | "frames", fps: number): number {
    const value = Number(input); // 入力された秒または番号
    if (!input.trim() || !Number.isFinite(value) || value < 0) throw new RangeError("時刻を正の数値または0で入力してください。");
    if (unit === "frames") return frameToTimeUs(value, fps);
    const result = Math.round(value * MICROS_PER_SECOND); // 保存時刻
    if (!isNonNegativeSafeInteger(result)) throw new RangeError("時刻が安全整数範囲を超えています。");
    return result;
}
