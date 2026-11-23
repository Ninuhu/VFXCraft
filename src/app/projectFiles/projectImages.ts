import type { Asset } from "../../core/document/model.ts";
import { readImageDimensions } from "../../core/persistence/imageDimensions.ts";
import { imageMediaType, REVIEW_VCR_LIMITS, type VerifyImage } from "../../core/persistence/vcrArchive.ts";
import type { ProjectFileFlow } from "./projectFileFlow.ts";

////////////////////
// T04と正式UIで同じ取り込み経路を使い、拡張子やMIME申告に頼らずデコード前にも検証する。
export async function importProjectImage(flow: ProjectFileFlow, file: File, verify: VerifyImage): Promise<Asset> {
    if (file.size > REVIEW_VCR_LIMITS.entryBytes) throw new Error("画像容量が検証上限を超えています。");
    const mediaType = await imageMediaType(file); // 実バイトから識別したPNG/JPEG/WebP
    const dimensions = await readImageDimensions(file, mediaType, REVIEW_VCR_LIMITS.imagePixels); // 巨大な寸法をデコード前に拒否
    const asset: Asset = { id: crypto.randomUUID(), name: file.name, mediaType, ...dimensions }; // 元のファイル名は保持
    await verify(file.slice(0, file.size, mediaType), asset);
    flow.history.execute({ kind: "asset.add", asset });
    flow.rememberImage(asset.id, file); // 本体は複製せず履歴から参照する
    flow.collectImages();
    return asset;
}
