import type { Project } from "../../core/document/model.ts";
import { EditingHistory } from "../../core/editing/history.ts";
import { readVcr, writeVcr, type VcrLimits, type VerifyImage } from "../../core/persistence/vcrArchive.ts";

export type FileTarget = { write(file: Blob): Promise<void> };
export type OpenDecision = "save" | "discard" | "cancel";
export type SaveRoute =
    | { readonly kind: "overwrite"; readonly getTarget: () => Promise<FileTarget> }
    | { readonly kind: "download"; readonly download: (file: Blob) => void; readonly confirm: () => Promise<boolean> };

/** 確定済み文書、素材、保存先を同じセッションで管理する。 */
export class ProjectFileFlow {
    public readonly history: EditingHistory;
    private _images = new Map<string, Blob>(); // 素材本体。履歴とスナップショットはIDのみを保持
    private _target: FileTarget | undefined; // 現在のプロジェクトの上書き先
    private _busy = false; // ファイル操作の排他制御
    private readonly _limits: VcrLimits;
    private readonly _verify: VerifyImage;
    private readonly _appVersion: string;

    ////////////////////
    // 検証済みの初期文書から保存セッションを開始する
    public constructor(project: Project, limits: VcrLimits, verify: VerifyImage, appVersion: string) {
        this.history = new EditingHistory(project);
        this._limits = limits;
        this._verify = verify;
        this._appVersion = appVersion;
    }

    ////////////////////
    // 新規登録済み画像を保持し、履歴に残るIDの内容の差し替えを防ぐ
    public rememberImage(id: string, image: Blob): void {
        const key = id.toLowerCase(); // ドメインの参照比較規則に揃える
        if (!this.history.getRetainedAssetIds().has(key)) throw new Error("素材が文書に登録されていません。");
        const existing = this._images.get(key); // 同じIDの履歴が参照する既存画像
        if (existing && existing !== image) throw new Error("同じ素材IDの内容を変更できません。");
        this._images.set(key, image);
    }

    ////////////////////
    // 描画側に不変の素材Blobを渡す
    public getImage(id: string): Blob | undefined { return this._images.get(id.toLowerCase()); }

    ////////////////////
    // 履歴から不要になった素材を回収する
    public collectImages(): void {
        const retained = this.history.getRetainedAssetIds(); // Undo、Redoとプレビューを含む
        for (const id of this._images.keys()) if (!retained.has(id)) this._images.delete(id);
    }

    ////////////////////
    // 保存対象を固定し、確認または書き込みが成功した時だけ保存済みにする
    private async saveSnapshot(route: SaveRoute): Promise<boolean> {
        const snapshot = this.history.snapshot; // 保存開始時の確定済み文書
        const images = new Map(this._images); // 保存中の回収に影響されない参照
        const target = route.kind === "overwrite" ? await route.getTarget() : undefined; // 操作直後にピッカーを開く
        const file = await writeVcr({ project: snapshot.project, images }, this._limits, this._verify, this._appVersion); // 完成した保存ファイル
        if (route.kind === "download") {
            route.download(file);
            if (!await route.confirm()) return false;
        } else {
            await target!.write(file);
        }
        if (!this.history.markSaved(snapshot)) return false;
        this._target = target;
        return true;
    }

    ////////////////////
    // 同時実行を防ぎ、失敗時にも次の試行を可能にする
    private async run<T>(operation: () => Promise<T>): Promise<T> {
        if (this._busy) throw new Error("別のファイル操作が進行中です。");
        this._busy = true;
        try {
            return await operation();
        } finally {
            this._busy = false;
        }
    }

    ////////////////////
    // 通常保存では既存ハンドルを使い、別名保存では新しい保存先を要求する
    public save(route: SaveRoute, saveAs = false): Promise<boolean> {
        return this.run(() => this.saveSnapshot(this.reuseTarget(route, saveAs)));
    }

    ////////////////////
    // 指定がなければ同じファイルへ書き込む
    private reuseTarget(route: SaveRoute, saveAs = false): SaveRoute {
        const target = this._target; // 現在の保存先
        return route.kind === "overwrite" && target && !saveAs
            ? { kind: "overwrite", getTarget: async () => target } : route;
    }

    ////////////////////
    // 未保存変更を確認し、文書と素材が揃った場合にだけ開く
    public open(file: Blob, target: FileTarget | undefined, decision: OpenDecision,
        saveRoute?: SaveRoute, saveAs = false): Promise<"opened" | "cancelled" | "changed"> {
        return this.run(async () => {
            if (decision === "cancel") return "cancelled";
            const before = this.history.snapshot; // この切替で破棄を許可された状態
            if (decision === "save" && !this.history.isSaved) {
                if (!saveRoute) throw new Error("現在のプロジェクトの保存方法を選んでください。");
                if (!await this.saveSnapshot(this.reuseTarget(saveRoute, saveAs))) return "cancelled";
            }
            if (this.history.snapshot !== before) return "changed";
            const loaded = await readVcr(file, this._limits, this._verify); // 一時領域で検証した文書と素材
            if (this.history.snapshot !== before) return "changed";
            this.history.replaceProject(loaded.project, "loaded");
            this._images = new Map(loaded.images);
            this._target = target;
            return "opened";
        });
    }
}
