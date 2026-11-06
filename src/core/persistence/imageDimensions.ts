import type { Asset } from "../document/model.ts";

type Dimensions = { width: number; height: number };
const JPEG_FRAME = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]); // SOFマーカー

////////////////////
// バイトをASCIIの識別子に変換する
function fourcc(bytes: Uint8Array, offset: number): string {
    return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

////////////////////
// 圧縮データの展開前にJPEGのフレーム寸法を得る
function jpegDimensions(bytes: Uint8Array): Dimensions | undefined {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); // JPEGのビッグエンディアン値
    let offset = 2; // SOIの直後
    while (offset + 4 <= bytes.length && bytes[offset++] === 0xff) {
        while (bytes[offset] === 0xff) offset++;
        const marker = bytes[offset++]; // セグメント種別
        if (marker === undefined || marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) break;
        const length = view.getUint16(offset); // 長さフィールドを含むセグメント長
        if (length < 2 || offset + length > bytes.length) break;
        if (JPEG_FRAME.has(marker) && length >= 8) {
            return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
        }
        offset += length;
    }
}

////////////////////
// WebPの先頭チャンクからキャンバス寸法を得る
function webpDimensions(bytes: Uint8Array): Dimensions | undefined {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); // WebPのリトルエンディアン値
    const tag = fourcc(bytes, 12); // 画像の先頭チャンク種別
    if (tag === "VP8X" && bytes.length >= 30) {
        return { width: (view.getUint32(24, true) & 0xffffff) + 1,
            height: view.getUint16(27, true) + (bytes[29]! << 16) + 1 };
    }
    if (tag === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
        const packed = view.getUint32(21, true); // 可逆WebPの14ビット寸法
        return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
    }
    if (tag === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
        return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
}

////////////////////
// デコード前に寸法を確認し、過大な画像バッファの割り当てを避ける
export async function readImageDimensions(image: Blob, format: Asset["mediaType"], pixelLimit: number): Promise<Dimensions> {
    const bytes = new Uint8Array(await (format === "image/jpeg" ? image : image.slice(0, 30)).arrayBuffer()); // 寸法ヘッダー
    let size: Dimensions | undefined; // 形式ごとの実寸法
    if (format === "image/jpeg") size = jpegDimensions(bytes);
    else if (format === "image/webp") size = webpDimensions(bytes);
    else if (bytes.length >= 24 && fourcc(bytes, 12) === "IHDR") {
        const view = new DataView(bytes.buffer); // PNGのIHDR
        size = { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (!size || size.width <= 0 || size.height <= 0 || size.width > pixelLimit / size.height) {
        throw new Error("画像の寸法が不正か、画素数が上限を超えています。");
    }
    return size;
}
