import type { PreviewOptions } from "./WebGlPreview";

const DB_NAME = "vfxcraft-t01-validation"; // 技術検証専用のデータベース名
const STORE = "frames"; // 設定と画像をまとめて保存する場所
const SLOT = "latest"; // 検証用の保存枠
const VERSION = 1; // 検証用レコードの形式番号

export type VerificationSnapshot = {
    version: typeof VERSION;
    options: PreviewOptions;
    seconds: number;
    image: Blob;
};

////////////////////
// 外部保存値の型・版・時刻・PNGの基本条件を検証してから読み込む
export function validateSnapshot(value: unknown): VerificationSnapshot {
    if (!value || typeof value !== "object") throw new Error("復元できる検証データがありません。");
    const record = value as Partial<VerificationSnapshot>; // 読み込んだ未検証レコード
    const options = record.options; // 描画設定の候補
    if (
        record.version !== VERSION ||
        !options || (options.mode !== "2d" && options.mode !== "pixel" && options.mode !== "3d") ||
        (options.emission !== "continuous" && options.emission !== "burst") ||
        typeof options.isAdditive !== "boolean" || typeof options.hasBloom !== "boolean" ||
        typeof options.isPlaying !== "boolean" ||
        typeof record.seconds !== "number" || !Number.isFinite(record.seconds) || record.seconds < 0 ||
        !(record.image instanceof Blob) || record.image.type !== "image/png" || record.image.size === 0
    ) {
        throw new Error("検証データの形式、設定、または画像が不正です。");
    }
    return { version: VERSION, options, seconds: record.seconds, image: record.image };
}

////////////////////
// 保存先を開き、初回だけ検証用ストアを作る
function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, VERSION); // DBを開くリクエスト
        let isBlocked = false; // ブロック後に到着する接続を閉じるための状態
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => {
            if (isBlocked) request.result.close();
            else resolve(request.result);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => {
            isBlocked = true;
            reject(new Error("別のタブが検証用データベースを使用しています。"));
        };
    });
}

////////////////////
// レコード操作をトランザクション完了まで待ち、DB接続を解放する
async function runTransaction<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
    const database = await openDatabase(); // 今回の保存・復元で使う接続
    try {
        return await new Promise((resolve, reject) => {
            const transaction = database.transaction(STORE, mode); // 画像と設定を一括で扱う境界
            transaction.onabort = () => reject(transaction.error ?? new Error("保存処理が中断されました。"));
            const request = operation(transaction.objectStore(STORE)); // 保存枠への読み書き
            transaction.oncomplete = () => resolve(request.result);
        });
    } finally {
        database.close();
    }
}

////////////////////
// 設定と画像を同じ保存枠に書き込み、完了時だけ成功とする
export async function saveSnapshot(options: PreviewOptions, seconds: number, image: Blob): Promise<void> {
    const snapshot = validateSnapshot({ version: VERSION, options, seconds, image }); // 保存する一貫した状態
    await runTransaction("readwrite", (store) => store.put(snapshot, SLOT));
}

////////////////////
// PNGを実際に復号できることまで確認し、適用可能な状態だけを返す
export async function loadSnapshot(): Promise<VerificationSnapshot> {
    const value: unknown = await runTransaction("readonly", (store) => store.get(SLOT)); // 保存済みの未検証値
    const snapshot = validateSnapshot(value); // 型と版を確認した候補
    const bitmap = await createImageBitmap(snapshot.image); // PNGが壊れていないか確認する画像
    bitmap.close();
    return snapshot;
}
