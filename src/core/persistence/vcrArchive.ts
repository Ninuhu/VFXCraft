import { BlobReader, BlobWriter, ZipReader, ZipWriter, type FileEntry } from "@zip.js/zip.js";
import type { Asset, Project } from "../document/model.ts";
import { validateProject } from "../document/validateDocument.ts";
import { readImageDimensions } from "./imageDimensions.ts";

const FORMAT = "VFXCraft"; // .vcrの識別子
const CONTAINER_VERSION = 1; // ZIP内の物理形式版
const JSON_METADATA = "metadata.json"; // コンテナ情報
const JSON_PROJECT = "project.json"; // 編集ドキュメント
const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const; // 正規の素材拡張子
const ASSET_PATH = /^assets\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|webp)$/u; // 正規パスのみ許可

export type VcrLimits = {
    readonly archiveBytes: number;
    readonly totalBytes: number;
    readonly entryBytes: number;
    readonly jsonBytes: number;
    readonly entryCount: number;
    readonly imagePixels: number;
};

const MEBIBYTE = 1024 ** 2; // 容量換算
export const REVIEW_VCR_LIMITS: VcrLimits = Object.freeze({
    archiveBytes: 130 * MEBIBYTE, totalBytes: 128 * MEBIBYTE,
    entryBytes: 32 * MEBIBYTE, jsonBytes: 4 * MEBIBYTE,
    entryCount: 514, imagePixels: 4096 ** 2,
}); // 検証用の候補値。製品上限の確定とは分離する

export type VerifyImage = (image: Blob, asset: Asset) => Promise<void>;
export type VcrProject = { readonly project: Project; readonly images: ReadonlyMap<string, Blob> };

////////////////////
// 誤った容量ポリシーによる制限の無効化を防ぐ
function checkLimits(limits: VcrLimits): void {
    for (const value of [limits.archiveBytes, limits.totalBytes, limits.entryBytes,
        limits.jsonBytes, limits.entryCount, limits.imagePixels]) {
        if (!Number.isSafeInteger(value) || value <= 0) throw new Error("容量ポリシーが不正です。");
    }
}

////////////////////
// 形式とUUIDから格納パスを作る
function assetPath(asset: Asset): string {
    return "assets/" + asset.id.toLowerCase() + "." + EXTENSIONS[asset.mediaType];
}

////////////////////
// 画像の形式を拡張子やBlob.typeではなく先頭バイトで判定する
export async function imageMediaType(image: Blob): Promise<Asset["mediaType"]> {
    const bytes = new Uint8Array(await image.slice(0, 12).arrayBuffer()); // 形式識別用の先頭バイト
    if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return "image/png";
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
    const text = new TextDecoder().decode(bytes); // RIFFコンテナとWebP識別子
    if (text.startsWith("RIFF") && text.slice(8) === "WEBP") return "image/webp";
    throw new Error("対応する画像形式を識別できません。");
}

////////////////////
// 素材のサイズ、実形式、デコード結果を検証する
async function checkImage(image: Blob, asset: Asset, limits: VcrLimits, verify: VerifyImage): Promise<void> {
    if (image.size > limits.entryBytes || asset.width > limits.imagePixels / asset.height) {
        throw new Error("画像の容量または画素数が上限を超えています。");
    }
    if (await imageMediaType(image) !== asset.mediaType) throw new Error("画像の実形式が登録形式と異なります。");
    const dimensions = await readImageDimensions(image, asset.mediaType, limits.imagePixels); // デコード前の実寸法
    if (dimensions.width !== asset.width || dimensions.height !== asset.height) throw new Error("画像の寸法が一致しません。");
    await verify(image.slice(0, image.size, asset.mediaType), asset);
}

////////////////////
// ZIP内のJSONを厳格なUTF-8で読み取る
async function readJson(blob: Blob): Promise<unknown> {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await blob.arrayBuffer())) as unknown;
}

////////////////////
// 申告値に加え、実際に書き出されたバイト数も制限する
async function extract(entry: FileEntry, limit: number): Promise<Blob> {
    const parts: Uint8Array<ArrayBuffer>[] = []; // 検証済みの展開チャンク
    let actual = 0; // 実展開バイト数
    const sink = new WritableStream<Uint8Array>({
        write(chunk) {
            actual += chunk.byteLength;
            if (actual > limit || actual > entry.uncompressedSize) throw new Error("展開サイズが上限または申告値を超えています。");
            parts.push(new Uint8Array(chunk));
        },
    }); // zip.jsへ渡す上限付き出力先
    await entry.getData(sink, { checkCrc32: true, strictness: "strict", useWebWorkers: false });
    if (actual !== entry.uncompressedSize) throw new Error("展開サイズが申告値と異なります。");
    return new Blob(parts);
}

////////////////////
// コンテナ識別子と版を検証し、未知版では文書移行を開始しない
function checkMetadata(input: unknown): void {
    if (typeof input !== "object" || input === null || Array.isArray(input)
        || !("format" in input) || input.format !== FORMAT
        || !("createdByVersion" in input) || typeof input.createdByVersion !== "string" || !input.createdByVersion) {
        throw new Error("VFXCraftのプロジェクトファイルではありません。");
    }
    if (!("containerVersion" in input) || input.containerVersion !== CONTAINER_VERSION) {
        throw new Error("未対応の.vcrコンテナ版です。");
    }
}

////////////////////
// 全登録画像をZIPに書き込み、スナップショットから持ち出し可能なファイルを生成する
export async function writeVcr(data: VcrProject, limits: VcrLimits, verify: VerifyImage,
    createdByVersion: string): Promise<Blob> {
    checkLimits(limits);
    const project = validateProject(data.project); // 保存可能な論理文書
    const metadata = { format: FORMAT, containerVersion: CONTAINER_VERSION, createdByVersion }; // コンテナ識別情報
    checkMetadata(metadata);
    const entries = new Map([
        [JSON_METADATA, new Blob([JSON.stringify(metadata)])],
        [JSON_PROJECT, new Blob([JSON.stringify(project)])],
    ]); // 書込対象
    if (entries.size + project.assets.length > limits.entryCount) throw new Error("エントリ数が上限を超えています。");
    for (const blob of entries.values()) {
        if (blob.size > limits.jsonBytes || blob.size > limits.entryBytes) throw new Error("JSONの容量が上限を超えています。");
    }
    let total = [...entries.values()].reduce((sum, blob) => sum + blob.size, 0); // 書込予定の合計バイト数
    for (const asset of project.assets) {
        const image = data.images.get(asset.id.toLowerCase()); // 参照中・未使用を問わず必要な画像
        if (!image) throw new Error("素材が見つかりません: " + asset.name);
        total += image.size;
        if (total > limits.totalBytes) throw new Error("合計容量が上限を超えています。");
        await checkImage(image, asset, limits, verify);
        entries.set(assetPath(asset), image);
    }
    if (total > limits.totalBytes) throw new Error("合計容量が上限を超えています。");

    const writer = new ZipWriter(new BlobWriter("application/zip"), { level: 0, useWebWorkers: false }); // 元画像を再圧縮しない
    let result: Blob; // 完成したZIP
    try {
        for (const [path, blob] of entries) await writer.add(path, new BlobReader(blob));
    } finally {
        result = await writer.close();
    }
    if (result.size > limits.archiveBytes) throw new Error("ファイル容量が上限を超えています。");
    return result;
}

////////////////////
// ZIPを厳格に検証し、全素材を検証済みの一時データとして返す
export async function readVcr(file: Blob, limits: VcrLimits, verify: VerifyImage): Promise<VcrProject> {
    checkLimits(limits);
    if (file.size > limits.archiveBytes) throw new Error("ファイル容量が上限を超えています。");
    const reader = new ZipReader(new BlobReader(file), { strictness: "strict", filenameValidation: "strict",
        checkCrc32: true, useWebWorkers: false }); // 厳格な構造・CRC検査を行うZIPリーダー
    try {
        const entries = new Map<string, FileEntry>(); // 正規パスとZIPエントリの対応
        let total = 0; // 申告された合計展開サイズ
        for await (const entry of reader.getEntriesGenerator()) {
            const path = entry.filename; // ZIPに記載されたパス
            const isJson = path === JSON_METADATA || path === JSON_PROJECT; // 必須JSONか
            if (entry.directory || entry.encrypted || (!isJson && (!ASSET_PATH.test(path) || path.trim() !== path))
                || entries.has(path)) throw new Error("禁止された、暗号化された、または重複したZIPエントリです。");
            const size = entry.uncompressedSize; // 申告された展開サイズ
            const limit = isJson ? Math.min(limits.jsonBytes, limits.entryBytes) : limits.entryBytes; // 個別上限
            if (!Number.isSafeInteger(size) || size < 0 || size > limit
                || size > limits.totalBytes - total || entries.size >= limits.entryCount) {
                throw new Error("ZIPの展開容量またはエントリ数が上限を超えています。");
            }
            total += size;
            entries.set(path, entry);
        }
        const metadata = entries.get(JSON_METADATA); // コンテナの識別情報
        const document = entries.get(JSON_PROJECT); // 論理文書
        if (!metadata || !document) throw new Error("必須JSONが見つかりません。");
        checkMetadata(await readJson(await extract(metadata, limits.jsonBytes)));
        const project = validateProject(await readJson(await extract(document, limits.jsonBytes))); // 論理スキーマの検証・旧版移行
        const images = new Map<string, Blob>(); // 全検証が完了するまで外部に公開しない素材
        if (entries.size !== project.assets.length + 2) throw new Error("登録素材とZIPエントリ数が一致しません。");
        for (const asset of project.assets) {
            const entry = entries.get(assetPath(asset)); // UUIDで解決した素材
            if (!entry) throw new Error("素材が見つかりません: " + asset.name);
            const image = await extract(entry, limits.entryBytes); // CRCと展開サイズを確認した画像
            await checkImage(image, asset, limits, verify);
            images.set(asset.id.toLowerCase(), image.slice(0, image.size, asset.mediaType));
        }
        return { project, images };
    } finally {
        await reader.close();
    }
}
