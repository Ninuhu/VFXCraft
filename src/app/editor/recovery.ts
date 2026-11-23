import type { ProjectFileFlow } from "../projectFiles/projectFileFlow.ts";
import { readVcr, REVIEW_VCR_LIMITS, writeVcr, type VerifyImage } from "../../core/persistence/vcrArchive.ts";

export type RecoveryEntry = { id: string; name: string; savedAt: number; archive: Blob };
const DATABASE = "vfxcraft-project-recovery"; // T01検証用DBと分離する
const STORE = "snapshots"; // 完成した.vcrと日時を同一トランザクションで保存
let lastCaptureTime = 0; // 同一ミリ秒に始まった保存の前後も識別する

////////////////////
// 自動保存も手動保存と同じシリアライズと検証を通し、保存済み位置には通知しない。
export async function recoverySnapshot(flow: ProjectFileFlow, verify: VerifyImage): Promise<RecoveryEntry> {
    const project = flow.history.snapshot.project; // 開始時点の不変スナップショット
    const savedAt = Math.max(Date.now(), lastCaptureTime + 1); // 非同期完了順で新しい候補を古くしない
    lastCaptureTime = savedAt;
    const images = new Map<string, Blob>(); // 未使用の登録素材も同梱する
    for (const asset of project.assets) {
        const image = flow.getImage(asset.id); // 履歴が所有する素材を複製せず参照保持
        if (!image) throw new Error("自動保存に必要な画像がありません: " + asset.name);
        images.set(asset.id.toLowerCase(), image);
    }
    return { id: project.id, name: project.name, savedAt,
        archive: await writeVcr({ project, images }, REVIEW_VCR_LIMITS, verify, "0.0.0") };
}

////////////////////
// 復元候補を検証してからセッションを生成できるデータを返す。
export async function readRecovery(entry: RecoveryEntry, verify: VerifyImage) {
    if (!(entry.archive instanceof Blob) || !Number.isFinite(entry.savedAt)) throw new Error("復元データが破損しています。");
    return readVcr(entry.archive, REVIEW_VCR_LIMITS, verify);
}

////////////////////
// IndexedDBの寿命は処理単位で閉じ、使用不可・容量不足は呼出側へ通知する。
async function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE, 1); // プロジェクト専用のストレージ
        request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("自動保存DBが他のタブで使用中です。"));
    });
}

////////////////////
// 最新の三プロジェクト分を保持する技術上の暫定ポリシー。世代の本格管理はT11。
export async function storeRecovery(entry: RecoveryEntry): Promise<void> {
    const db = await openDatabase(); // この操作だけが所有する接続
    try {
        await new Promise<void>((resolve, reject) => {
            const transaction = db.transaction(STORE, "readwrite"), store = transaction.objectStore(STORE); // 書込と古い候補回収を原子的に行う
            const previous = store.get(entry.id); // 遅れて完了した古い保存で最新候補を上書きしない
            previous.onsuccess = () => {
                const old = previous.result as RecoveryEntry | undefined; // 同一プロジェクトの既存日時
                if (!old || old.savedAt < entry.savedAt) store.put(entry);
                const request = store.getAll(); // 書込後の同一トランザクションで回収する
                request.onsuccess = () => {
                    const entries = request.result as RecoveryEntry[]; // このDBが生成した候補
                    entries.sort((a, b) => b.savedAt - a.savedAt);
                    for (const old of entries.slice(3)) store.delete(old.id);
                };
            };
            transaction.oncomplete = () => resolve();
            transaction.onabort = () => reject(transaction.error ?? new Error("自動保存を中断しました。"));
            transaction.onerror = () => reject(transaction.error);
        });
    } finally { db.close(); }
}

////////////////////
// 候補の読込は失敗してもアプリの初期画面を妨げないよう、呼出側で例外を扱う。
export async function listRecovery(): Promise<RecoveryEntry[]> {
    const db = await openDatabase(); // 復元候補一覧の接続
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE, "readonly"), request = transaction.objectStore(STORE).getAll(); // Blobは表示するまで展開しない
            request.onsuccess = () => resolve((request.result as RecoveryEntry[]).sort((a, b) => b.savedAt - a.savedAt));
            request.onerror = () => reject(request.error);
        });
    } finally { db.close(); }
}
