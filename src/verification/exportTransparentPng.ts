const CHANNELS = 4; // RGBAの成分数
const BYTE_MAX = 255; // 8bitチャンネルの最大値
const HALO_FLOOR = 8; // 黒背景での極低輝度の裾を除く境界（8bit値）

////////////////////
// 黒背景での発光色を保てる最小アルファを求め、PNG用の非乗算RGBAへ変換する
export function recoverGlowAlpha(black: Uint8ClampedArray, coverage: Uint8ClampedArray): void {
    for (let offset = 0; offset < black.length; offset += CHANNELS) {
        const peak = Math.max(black[offset]!, black[offset + 1]!, black[offset + 2]!); // 黒背景で最も強い色成分
        const baseAlpha = coverage[offset + 3]!; // 粒子本体のアルファ
        // 極低輝度の裾で空白全体が半透明になるのを抑え、明るい発光はそのまま残す。
        const halo = Math.max(0, Math.min(1, (peak - HALO_FLOOR) / HALO_FLOOR)); // 裾の減衰係数
        const weight = Math.max(halo, baseAlpha / BYTE_MAX); // 粒子本体がある位置の色を優先する係数
        const red = black[offset]! * weight; // 減衰を適用した赤成分
        const green = black[offset + 1]! * weight; // 減衰を適用した緑成分
        const blue = black[offset + 2]! * weight; // 減衰を適用した青成分
        const alpha = Math.round(Math.max(red, green, blue, baseAlpha)); // 発光と粒子本体を残す被覆率
        if (alpha > 0) {
            black[offset] = (red * BYTE_MAX) / alpha;
            black[offset + 1] = (green * BYTE_MAX) / alpha;
            black[offset + 2] = (blue * BYTE_MAX) / alpha;
        }
        else black.fill(0, offset, offset + CHANNELS);
        black[offset + 3] = alpha;
    }
}

////////////////////
// 同じ時刻の描画結果を2Dキャンバスに複製し、画面の描画ループから切り離す
export function captureTransparentFrame(
    source: HTMLCanvasElement,
    drawCoverage: () => void,
    drawGlow: (() => void) | undefined,
): HTMLCanvasElement {
    drawCoverage();
    const canvas = document.createElement("canvas"); // PNGエンコード専用の描画先
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext("2d", { willReadFrequently: Boolean(drawGlow) }); // RGBAの複製先
    if (!context) throw new Error("PNG用キャンバスを初期化できません。");
    context.drawImage(source, 0, 0);
    if (drawGlow) {
        const coverage = context.getImageData(0, 0, canvas.width, canvas.height); // 本体の透過情報
        drawGlow();
        context.globalCompositeOperation = "copy";
        context.drawImage(source, 0, 0);
        const glow = context.getImageData(0, 0, canvas.width, canvas.height); // 黒背景での発光色
        recoverGlowAlpha(glow.data, coverage.data);
        context.putImageData(glow, 0, 0);
    }
    return canvas;
}

////////////////////
// 検証用の1フレームをPNG Blobにする
export function encodePng(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob && blob.size > 0) resolve(blob);
            else reject(new Error("透過PNGを生成できませんでした。"));
        }, "image/png");
    });
}

////////////////////
// 生成したPNGをローカルにダウンロードする
export function downloadPng(blob: Blob): void {
    const url = URL.createObjectURL(blob); // ダウンロード中だけ有効な参照
    const link = document.createElement("a"); // ブラウザの保存操作を開始するリンク
    link.href = url;
    link.download = "vfxcraft-t01-frame.png";
    try {
        link.click();
    } finally {
        // クリック処理がBlobを取得してから参照を解放する。
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
    }
}
