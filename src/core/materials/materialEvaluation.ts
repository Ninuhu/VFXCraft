import type { BackgroundSettings, Gradient, GradientStop, LinearRgb, MaterialAppearance, ProjectPreview } from "../document/model.ts";

export const WHITE: LinearRgb = [1, 1, 1]; // RGBの乗算単位元
export const DEFAULT_APPEARANCE: MaterialAppearance = { opacity: 1, lifetime: { colors: [], alphas: [] },
    spatial: { colors: [], alphas: [] }, bloomStrength: 0 }; // 未編集の新しい材質
export const DEFAULT_PREVIEW: ProjectPreview = { background: {}, bloom: { radius: 8, threshold: 0.5 }, pixelBloom: "pixel" };
export const DEFAULT_BACKGROUND: BackgroundSettings = { color: [0.02, 0.02, 0.03], checker: false, grid: false, gridOpacity: 0.25 };
export type Rgba = readonly [number, number, number, number];

////////////////////
// 項目ごとに共通設定へフォールバックする
export function resolveBackground(common: BackgroundSettings, override: Partial<BackgroundSettings>): BackgroundSettings {
    return { color: override.color ?? common.color, checker: override.checker ?? common.checker,
        grid: override.grid ?? common.grid, gridOpacity: override.gridOpacity ?? common.gridOpacity };
}

////////////////////
// 端点の外側は端点値を保ち、二点の間だけ線形補間する
function interpolate<T>(stops: readonly GradientStop<T>[], offset: number, neutral: T,
    mix: (a: T, b: T, weight: number) => T): T {
    if (stops.length === 0) return neutral;
    const right = stops.findIndex((stop) => offset <= stop.offset); // 右側の制御点
    if (right === -1) return stops[stops.length - 1]!.value;
    if (right === 0) return stops[0]!.value;
    const a = stops[right - 1]!, b = stops[right]!; // 検証済みの異なる位置
    return mix(a.value, b.value, (offset - a.offset) / (b.offset - a.offset));
}

////////////////////
// Linear sRGBと非乗算アルファを独立に補間する
export function evaluateGradient(gradient: Gradient, offset: number): Rgba {
    const rgb = interpolate<LinearRgb>(gradient.colors, offset, WHITE, (a, b, w) =>
        [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w]); // 線形色
    return [...rgb, interpolate(gradient.alphas, offset, 1, (a, b, w) => a + (b - a) * w)];
}

////////////////////
// Straight RGBAを成分ごとに乗算する
export function multiplyRgba(a: Rgba, b: Rgba): Rgba {
    return [a[0] * b[0], a[1] * b[1], a[2] * b[2], a[3] * b[3]];
}

////////////////////
// Linear sRGBを画面用sRGBへ変換する
export function toSrgb(value: number): number {
    return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
}

////////////////////
// 画面・画像のsRGBを演算用の線形値に戻す
export function toLinear(value: number): number {
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
