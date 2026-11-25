import type { Project } from "../document/model.ts";
import { DocumentValidationError, validateProject } from "../document/validateDocument.ts";
import { applyEditCommand, type EditCommand } from "./command.ts";
import { shareValidatedProject } from "./snapshot.ts";

export const MAX_HISTORY_OPERATIONS = 100; // 一つのプロジェクトで取り消せる操作数

export type EditingSnapshot = {
    readonly revision: symbol;
    readonly project: Project;
};

type ContinuousEdit = {
    readonly token: symbol;
    preview: Project;
    isValid: boolean;
};

/** 編集を検証して確定し、現在のプロジェクトの履歴と保存位置を管理する。 */
export class EditingHistory {
    private _states: EditingSnapshot[] = []; // 先頭の基準状態と最大100操作の結果
    private _index = 0; // 現在位置
    private _sessionSnapshots = new WeakSet<EditingSnapshot>(); // 保存通知のプロジェクト境界
    private _savedRevision: symbol | undefined; // 最後に保存された状態の識別子
    private _continuous: ContinuousEdit | undefined; // 確定前の連続編集

    ////////////////////
    // 検証済みの初期状態から履歴を開始する
    public constructor(project: unknown, source: "new" | "loaded" = "new") {
        this.replaceProject(project, source);
    }

    ////////////////////
    // 保存処理に渡せる確定済みの文書と識別子を返す
    public get snapshot(): EditingSnapshot {
        return this._states[this._index]!;
    }

    ////////////////////
    // 連続入力中は最新の有効な候補をプレビューへ公開する
    public get preview(): Project {
        return this._continuous?.preview ?? this.snapshot.project;
    }

    ////////////////////
    // 保存制御が未確定の連続入力と確定済み文書を区別できるようにする
    public get isContinuousEditing(): boolean { return this._continuous !== undefined; }

    ////////////////////
    // 連続編集中は履歴移動を無効にする
    public get canUndo(): boolean {
        return !this._continuous && this._index > 0;
    }

    ////////////////////
    // 現在の分岐で進める状態があるか返す
    public get canRedo(): boolean {
        return !this._continuous && this._index < this._states.length - 1;
    }

    ////////////////////
    // 確定済み文書の履歴識別子で保存済みか判定する
    public get isSaved(): boolean {
        return this.snapshot.revision === this._savedRevision;
    }

    ////////////////////
    // 保存したスナップショットを記録し、旧プロジェクトの通知は無視する
    public markSaved(snapshot: EditingSnapshot): boolean {
        if (!this._sessionSnapshots.has(snapshot)) return false;
        this._savedRevision = snapshot.revision;
        return true;
    }

    ////////////////////
    // 読込・新規作成に成功したときだけ現在のプロジェクトを置き換える
    public replaceProject(input: unknown, source: "new" | "loaded"): void {
        const project = shareValidatedProject(undefined, validateProject(input)); // 独立した初期文書
        this._sessionSnapshots = new WeakSet();
        this._states = [this.createSnapshot(project)];
        this._index = 0;
        this._savedRevision = source === "loaded" ? this.snapshot.revision : undefined;
        this._continuous = undefined;
    }

    ////////////////////
    // 有効な単発操作だけを確定する
    public execute(command: EditCommand): boolean {
        if (this._continuous) throw new Error("連続編集を確定または取消してください。");
        return this.record(applyEditCommand(this.snapshot.project, command));
    }

    ////////////////////
    // 直前の履歴状態へ移動する
    public undo(): boolean {
        if (!this.canUndo) return false;
        this._index--;
        return true;
    }

    ////////////////////
    // 取り消した履歴状態を復元する
    public redo(): boolean {
        if (!this.canRedo) return false;
        this._index++;
        return true;
    }

    ////////////////////
    // ドラッグや数値入力のための排他的な編集を開始する
    public beginContinuousEdit(): symbol {
        if (this._continuous) throw new Error("既に連続編集中です。");
        const token = Symbol(); // 古いUIイベントが別の編集に触れないための識別子
        this._continuous = { token, preview: this.snapshot.project, isValid: true };
        return token;
    }

    ////////////////////
    // 有効な更新だけをプレビューに反映し、失敗時は確定を禁止する
    public updateContinuousEdit(token: symbol, command: EditCommand): boolean {
        const edit = this.requireContinuousEdit(token); // 現在進行中の編集
        try {
            edit.preview = applyEditCommand(edit.preview, command);
        } catch (error) {
            if (!(error instanceof DocumentValidationError)) throw error;
            edit.isValid = false;
            return false;
        }
        edit.isValid = true;
        return true;
    }

    ////////////////////
    // 最新の入力が有効な場合に連続操作を最大1件にまとめる
    public commitContinuousEdit(token: symbol): boolean {
        const edit = this.requireContinuousEdit(token); // 現在進行中の編集
        if (!edit.isValid) return false;
        const project = shareValidatedProject(this.snapshot.project, edit.preview); // 開始時と同じ値なら既存状態に戻す
        this._continuous = undefined;
        return this.record(project);
    }

    ////////////////////
    // プレビューだけを破棄して連続操作を取り消す
    public cancelContinuousEdit(token: symbol): void {
        this.requireContinuousEdit(token);
        this._continuous = undefined;
    }

    ////////////////////
    // 履歴・プレビューで再び使われ得る素材IDを回収判定用に返す
    public getRetainedAssetIds(): ReadonlySet<string> {
        const ids = new Set<string>(); // UUID比較規則に揃えた保持対象
        for (const { project } of this._states) {
            for (const asset of project.assets) ids.add(asset.id.toLowerCase());
        }
        for (const asset of this._continuous?.preview.assets ?? []) ids.add(asset.id.toLowerCase());
        return ids;
    }

    ////////////////////
    // 呼び出しが現在の連続操作に属しているか確認する
    private requireContinuousEdit(token: symbol): ContinuousEdit {
        if (this._continuous?.token !== token) throw new Error("対象の連続編集は既に終了しています。");
        return this._continuous;
    }

    ////////////////////
    // 有効な変更に一意の状態を割り当て、古い分岐と上限超過分を破棄する
    private record(project: Project): boolean {
        if (project === this.snapshot.project) return false;
        this._states.splice(this._index + 1);
        this._states.push(this.createSnapshot(project));
        if (this._states.length > MAX_HISTORY_OPERATIONS + 1) this._states.shift();
        this._index = this._states.length - 1;
        return true;
    }

    ////////////////////
    // 再利用しない識別子を発行し、同じプロジェクトの保存通知を受け付ける
    private createSnapshot(project: Project): EditingSnapshot {
        const snapshot = Object.freeze({ project, revision: Symbol() }); // 保存時にも渡す確定状態
        this._sessionSnapshots.add(snapshot);
        return snapshot;
    }
}
