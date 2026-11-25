import type { ProjectFileFlow } from "../projectFiles/projectFileFlow.ts";
import type { VerifyImage } from "../../core/persistence/vcrArchive.ts";
import { recoverySnapshot, storeRecovery, type RecoveryEntry } from "./recovery.ts";

export const AUTOSAVE_DELAY_MS = 2000; // 操作確定後の静穏期間。製品の保持上限とは別
export type AutosaveState = "waiting" | "saving" | "saved" | "failed";
type AutosaveOptions = { capture?: typeof recoverySnapshot; store?: (entry: RecoveryEntry) => Promise<void>;
    onState?: (state: AutosaveState, error?: unknown) => void; delayMs?: number };

/** 確定履歴の変更だけを直列保存し、画面操作とプレビュー更新では書き込まない。 */
export class AutosaveController {
    private _timer: ReturnType<typeof setTimeout> | undefined; // 所有するデバウンスタイマー
    private _running: Promise<void> | undefined; // 同じセッションの圧縮・DB書込を重ねない
    private _completed: symbol | undefined; // 直近に自動保存できた確定状態
    private _observed: symbol | undefined; // UI再描画で待ち時間を延ばさない
    private _failed: symbol | undefined; // 失敗の無限再試行を避け、明示再試行か次の編集を待つ
    private _disposed = false; // 旧UIへ遅延通知を届けない
    private readonly _flow: ProjectFileFlow; // 操作対象の文書・素材所有者
    private readonly _verify: VerifyImage; // 通常保存と同じ画像検証
    private readonly _options: AutosaveOptions; // 隔離テストではI/Oのみ差し替える

    ////////////////////
    // 一つの編集セッションに一つだけ作る。
    public constructor(flow: ProjectFileFlow, verify: VerifyImage, options: AutosaveOptions = {}) {
        this._flow = flow; this._verify = verify; this._options = options;
    }

    ////////////////////
    // 連続入力中は待機し、確定状態が変わった時だけタイマーを開始する。
    public observe(): void {
        if (this._disposed) return;
        if (this._flow.history.isContinuousEditing) { this.clearTimer(); return; }
        const revision = this._flow.history.snapshot.revision; // JSON比較や編集回数には依存しない
        if (revision === this._completed || revision === this._failed) return;
        if (revision === this._observed && (this._timer || this._running)) return;
        this._observed = revision; this.clearTimer(); this.notify("waiting");
        this._timer = setTimeout(() => { this._timer = undefined; void this.flush().catch(() => {}); }, this._options.delayMs ?? AUTOSAVE_DELAY_MS);
    }

    ////////////////////
    // 文書置換前と再試行で呼ぶ。保存中の編集も後続スナップショットとして直列に確保する。
    public async flush(): Promise<void> {
        this.clearTimer();
        if (this._running) { await this._running; return this.flush(); }
        if (this._disposed || this._flow.history.isContinuousEditing) return;
        const revision = this._flow.history.snapshot.revision; // captureは最初のawait前に同じ状態を固定
        if (revision === this._completed) return;
        this.notify("saving");
        this._running = (async () => {
            const entry = await (this._options.capture ?? recoverySnapshot)(this._flow, this._verify); // 文書・画像をまとめる
            await (this._options.store ?? storeRecovery)(entry); // 完了時だけ保存済み世代を更新
            this._completed = revision; this._failed = undefined;
            this.notify(this._flow.history.snapshot.revision === revision ? "saved" : "waiting");
        })();
        try { await this._running; }
        catch (error) { this._failed = revision; this.notify("failed", error); throw error; }
        finally { this._running = undefined; }
    }

    ////////////////////
    // アンマウントで待機タイマーを解放する。開始済みDB処理は原子的に完了させる。
    public dispose(): void { this._disposed = true; this.clearTimer(); }

    ////////////////////
    // 保留タイマーを必ず一つに保つ。
    private clearTimer(): void { if (this._timer !== undefined) clearTimeout(this._timer); this._timer = undefined; }

    ////////////////////
    // 旧画面への状態反映を止める。
    private notify(state: AutosaveState, error?: unknown): void { if (!this._disposed) this._options.onState?.(state, error); }
}
