import type { ProjectFileFlow } from "../projectFiles/projectFileFlow.ts";
import { readVcr, REVIEW_VCR_LIMITS, writeVcr, type VerifyImage } from "../../core/persistence/vcrArchive.ts";

export type RecoveryEntry = { id: string; name: string; savedAt: number; archive: Blob;
    projectId?: string; mode?: "2d" | "3d"; sessionId?: string; sequence?: number };
export type RecoveryListing = { entries: RecoveryEntry[]; invalidCount: number };
const DATABASE = "vfxcraft-project-recovery"; // T01検証用DBと分離する
const LEGACY_STORE = "snapshots"; // T10の候補を削除・上書きせず読む
const STORE = "generations"; // タブ・世代ごとに独立した完成済みアーカイブ
const SESSION_ID = crypto.randomUUID(); // 別タブ・再起動後も衝突しない識別子
let sequence = 0; // 同一タブでは時計が戻っても取得順を識別できる
let databaseOpening: Promise<IDBDatabase> | undefined; // 再マウントの同時接続要求をまとめる

////////////////////
// 自動保存も既存シリアライズを通す。文書とBlob参照は最初のawaitより前に固定する。
export async function recoverySnapshot(flow: ProjectFileFlow, verify: VerifyImage): Promise<RecoveryEntry> {
    const project = flow.history.snapshot.project; // 確定状態のみ。ドラッグ候補は含めない
    const currentSequence = ++sequence; // 保存の完了順と独立した世代番号
    const savedAt = Date.now(); // 表示用日時。別タブの更新優先度には使わない
    const images = new Map<string, Blob>(); // Blob本体は複製しない
    for (const asset of project.assets) {
        const image = flow.getImage(asset.id); // 未使用の登録画像も復元対象
        if (!image) throw new Error("自動保存に必要な画像がありません: " + asset.name);
        images.set(asset.id.toLowerCase(), image);
    }
    return { id: SESSION_ID + ":" + currentSequence, projectId: project.id, mode: project.mode,
        sessionId: SESSION_ID, sequence: currentSequence, name: project.name, savedAt,
        archive: await writeVcr({ project, images }, REVIEW_VCR_LIMITS, verify, "0.0.0") };
}

////////////////////
// DB内のメタデータも外部入力として確認し、一つの不正候補で一覧を停止しない。
export function isRecoveryEntry(input: unknown): input is RecoveryEntry {
    if (!input || typeof input !== "object") return false;
    const value = input as Record<string, unknown>; // アーカイブ本体は選択時に厳格検証
    return typeof value.id === "string" && value.id.length > 0 && typeof value.name === "string"
        && typeof value.savedAt === "number" && Number.isSafeInteger(value.savedAt) && value.savedAt >= 0
        && value.archive instanceof Blob && value.archive.size > 0 && value.archive.size <= REVIEW_VCR_LIMITS.archiveBytes
        && (value.projectId === undefined || typeof value.projectId === "string")
        && (value.mode === undefined || value.mode === "2d" || value.mode === "3d")
        && (value.sessionId === undefined || typeof value.sessionId === "string")
        && (value.sequence === undefined || typeof value.sequence === "number" && Number.isSafeInteger(value.sequence) && value.sequence > 0);
}

////////////////////
// 復元は通常読込と同じ完全検証後に返す。候補の取り違えも拒否する。
export async function readRecovery(entry: RecoveryEntry, verify: VerifyImage) {
    if (!isRecoveryEntry(entry)) throw new Error("復元データの情報が破損しています。");
    const loaded = await readVcr(entry.archive, REVIEW_VCR_LIMITS, verify); // 文書・画像・参照を検証
    if (loaded.project.id !== (entry.projectId ?? entry.id) || entry.mode && loaded.project.mode !== entry.mode)
        throw new Error("復元候補とプロジェクト情報が一致しません。");
    return loaded;
}

////////////////////
// 接続は処理単位で所有する。blocked後の遅延成功と版更新でも接続を残さない。
async function openDatabase(): Promise<IDBDatabase> {
    if (databaseOpening) return databaseOpening;
    const request = indexedDB.open(DATABASE, 2); // 同期的なアクセス拒否はキャッシュしない
    databaseOpening = new Promise((resolve, reject) => {
        let rejected = false; // blocked後に成功しても利用しない
        request.onupgradeneeded = () => {
            const db = request.result; // 追加ストアだけを作る非破壊移行
            if (!db.objectStoreNames.contains(LEGACY_STORE)) db.createObjectStore(LEGACY_STORE, { keyPath: "id" });
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
        };
        request.onsuccess = () => {
            databaseOpening = undefined;
            const db = request.result; // 他タブの版更新を妨げない
            db.onversionchange = () => db.close();
            if (rejected) db.close(); else resolve(db);
        };
        request.onerror = () => { databaseOpening = undefined; reject(request.error); };
        // blockedでもnative要求は取消不能。解放まで同じ拒否を共有し、後続要求の永久待機を防ぐ。
        request.onblocked = () => { rejected = true; reject(new Error("自動保存DBの更新が他のタブで保留されています。他のVFXCraftタブを閉じて再試行してください。")); };
    });
    return databaseOpening;
}

////////////////////
// 完成した文書・画像を一レコードの原子トランザクションで追加する。既存世代は消さない。
export async function storeRecovery(entry: RecoveryEntry): Promise<void> {
    if (!isRecoveryEntry(entry)) throw new Error("自動保存データが不正です。");
    const db = await openDatabase(); // 成功・失敗ともfinallyで解放
    try {
        await new Promise<void>((resolve, reject) => {
            const transaction = db.transaction(STORE, "readwrite"); // 失敗で以前の正常世代を失わない
            transaction.objectStore(STORE).add(entry); // 同じIDの上書きも許可しない
            transaction.oncomplete = () => resolve();
            transaction.onabort = () => reject(transaction.error ?? new Error("自動保存を中断しました。"));
            transaction.onerror = () => reject(transaction.error ?? new Error("自動保存に失敗しました。"));
        });
    } finally { db.close(); }
}

////////////////////
// 古い候補も保護して読み出す。メタデータ破損数を返し、利用者へ警告できるようにする。
export async function listRecoveryReport(): Promise<RecoveryListing> {
    const db = await openDatabase(); // 一覧はアーカイブを展開しない
    try {
        const records = await new Promise<unknown[]>((resolve, reject) => {
            const transaction = db.transaction([LEGACY_STORE, STORE], "readonly"); // 同じ時点の二ストア
            const legacy = transaction.objectStore(LEGACY_STORE).getAll(), current = transaction.objectStore(STORE).getAll(); // v1互換
            transaction.oncomplete = () => resolve([...(legacy.result as unknown[]), ...(current.result as unknown[])]);
            transaction.onabort = () => reject(transaction.error ?? new Error("復元候補の読込を中断しました。"));
            transaction.onerror = () => reject(transaction.error);
        });
        const entries = records.filter(isRecoveryEntry); // 不正レコードは削除せず一覧から隔離
        entries.sort((a, b) => b.savedAt - a.savedAt
            || (a.sessionId === b.sessionId ? (b.sequence ?? 0) - (a.sequence ?? 0) : 0)
            || a.id.localeCompare(b.id)); // 同じ日時でも同一タブの後続世代を先にする
        return { entries, invalidCount: records.length - entries.length };
    } finally { db.close(); }
}

////////////////////
// 既存の一覧利用者向けAPIを維持する。
export async function listRecovery(): Promise<RecoveryEntry[]> { return (await listRecoveryReport()).entries; }
