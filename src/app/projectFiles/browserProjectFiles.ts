import type { VerifyImage } from "../../core/persistence/vcrArchive.ts";
import type { FileTarget, SaveRoute } from "./projectFileFlow.ts";

type BrowserHandle = { getFile(): Promise<File>; createWritable(): Promise<FileSystemWritableFileStream> };
type PickerOptions = { types: { description: string; accept: Record<string, string[]> }[]; suggestedName?: string };
const VCR_TYPES = [{ description: "VFXCraft project", accept: { "application/zip": [".vcr"] } }]; // ピッカーの候補形式
const pickers = window as Window & {
    showSaveFilePicker?: (options: PickerOptions) => Promise<BrowserHandle>;
    showOpenFilePicker?: (options: PickerOptions) => Promise<BrowserHandle[]>;
}; // 実行環境に存在するAPIだけを使用する

////////////////////
// ファイルハンドルの書き込み完了を待ち、途中失敗なら書き込みを中止する
function fileTarget(handle: BrowserHandle): FileTarget {
    return {
        async write(file) {
            const stream = await handle.createWritable(); // 変更を確定する前の書込ストリーム
            try {
                await stream.write(file);
                await stream.close();
            } catch (error) {
                await stream.abort().catch(() => undefined);
                throw error;
            }
        },
    };
}

export const canOverwrite = typeof pickers.showSaveFilePicker === "function"; // 保存ピッカーの利用可否
export const canPickOpen = typeof pickers.showOpenFilePicker === "function"; // 上書き先を保持できる読込方法

////////////////////
// 上書き可能なハンドル付きでファイルを選択する
export async function pickProject(): Promise<{ file: File; target: FileTarget }> {
    const handle = (await pickers.showOpenFilePicker!({ types: VCR_TYPES }))[0]; // ユーザーが選択したファイル
    if (!handle) throw new DOMException("ファイル選択が取り消されました。", "AbortError");
    return { file: await handle.getFile(), target: fileTarget(handle) };
}

////////////////////
// 上書き経路と明示的なダウンロード経路を生成する
export function browserSaveRoute(name: string, download: boolean, confirm: () => Promise<boolean>): SaveRoute {
    if (!download) {
        return { kind: "overwrite", getTarget: async () =>
            fileTarget(await pickers.showSaveFilePicker!({ suggestedName: name, types: VCR_TYPES })) };
    }
    return {
        kind: "download",
        confirm,
        download(file) {
            const url = URL.createObjectURL(file); // ダウンロード開始に必要な一時URL
            const link = document.createElement("a"); // ブラウザへ保存開始を指示するリンク
            link.href = url;
            link.download = name;
            document.body.append(link);
            try { link.click(); }
            finally {
                link.remove();
                window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            }
        },
    };
}

////////////////////
// 実画像をデコードして、登録寸法との一致を確認する
export const verifyBrowserImage: VerifyImage = async (image, asset) => {
    const bitmap = await createImageBitmap(image, { imageOrientation: "none" }); // 検証用ビットマップ
    try {
        if (bitmap.width !== asset.width || bitmap.height !== asset.height) throw new Error("画像の寸法が一致しません。");
    } finally {
        bitmap.close();
    }
};
