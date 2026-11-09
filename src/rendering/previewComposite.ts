import type { BackgroundSettings } from "../core/document/model.ts";
import { toSrgb } from "../core/materials/materialEvaluation.ts";

const CHECKER_SIZE = 12; // チェッカーの表示px
const GRID_SIZE = 32; // グリッドの表示px

////////////////////
// 背景を描画パス専用のCanvasへ用意する。発光源や出力では使わない
export function paintBackground(canvas: HTMLCanvasElement, width: number, height: number, settings: BackgroundSettings): void {
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!; // プレビュー背景
    ctx.fillStyle = "rgb(" + settings.color.map((value) => Math.round(toSrgb(value) * 255)).join(",") + ")";
    ctx.fillRect(0, 0, width, height);
    if (settings.checker) {
        ctx.fillStyle = "rgba(128,128,128,0.24)";
        for (let y = 0; y < height; y += CHECKER_SIZE) {
            for (let x = y % (2 * CHECKER_SIZE); x < width; x += CHECKER_SIZE * 2) ctx.fillRect(x, y, CHECKER_SIZE, CHECKER_SIZE);
        }
    }
    if (settings.grid && settings.gridOpacity > 0) {
        ctx.fillStyle = "rgba(128,128,128," + settings.gridOpacity + ")";
        for (let x = 0; x < width; x += GRID_SIZE) ctx.fillRect(x, 0, 1, height);
        for (let y = 0; y < height; y += GRID_SIZE) ctx.fillRect(0, y, width, 1);
    }
}

////////////////////
// 発光だけをぼかして本体に加える。ピクセル方式は論理解像度を整数倍で復元する
export function compositeBloom(destination: CanvasRenderingContext2D, emission: HTMLCanvasElement, buffer: HTMLCanvasElement,
    width: number, height: number, pixelScale: number, radius: number, light: boolean): void {
    const divisor = light ? 2 : 1; // 軽量時にぼかす画素数を約1/4へ減らす
    const w = Math.ceil(width / divisor), h = Math.ceil(height / divisor); // 発光バッファ寸法
    if (buffer.width !== w || buffer.height !== h) { buffer.width = w; buffer.height = h; }
    const blur = buffer.getContext("2d")!; // 発光専用のぼかし先
    blur.clearRect(0, 0, w, h);
    blur.imageSmoothingEnabled = pixelScale === 1;
    blur.filter = radius > 0 ? "blur(" + radius / divisor + "px)" : "none";
    blur.drawImage(emission, 0, 0, w, h);
    blur.filter = "none";
    destination.save();
    destination.globalCompositeOperation = "lighter";
    destination.imageSmoothingEnabled = pixelScale === 1;
    destination.drawImage(buffer, 0, 0, width * pixelScale, height * pixelScale);
    destination.restore();
}
