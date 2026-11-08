import { useState } from "react";
import packageInfo from "../../../package.json";
import { createProject } from "../../core/document/createProject.ts";
import { readImageDimensions } from "../../core/persistence/imageDimensions.ts";
import { imageMediaType, REVIEW_VCR_LIMITS } from "../../core/persistence/vcrArchive.ts";
import { browserSaveRoute, canOverwrite, canPickOpen, pickProject, verifyBrowserImage } from "./browserProjectFiles.ts";
import { ProjectFileFlow, type FileTarget, type OpenDecision } from "./projectFileFlow.ts";

type Pending = { file: File; target?: FileTarget };

////////////////////
// T04の保存と読込を既存の描画検証から独立した画面で確認する
export function VcrReview({ session, onChange }: { session?: ProjectFileFlow; onChange?: () => void } = {}) {
    const [flow] = useState(() => session ?? new ProjectFileFlow(createProject({ id: crypto.randomUUID(), name: "T04 sample",
        mode: "2d", drawing: "normal", canvasWidth: 640, canvasHeight: 360, durationUs: 2_000_000 }),
    REVIEW_VCR_LIMITS, verifyBrowserImage, packageInfo.version)); // 検証セッション
    const [, refresh] = useState(0); // 履歴の表示更新用
    const [download, setDownload] = useState(!canOverwrite); // 明示的な保存方式
    const [pending, setPending] = useState<Pending>(); // 開こうとしているファイル
    const [busy, setBusy] = useState(false); // 操作中の二重入力防止
    const [message, setMessage] = useState(""); // 結果と失敗理由
    const project = flow.history.snapshot.project; // 現在の文書

    ////////////////////
    // 保存方式を現在の選択から決定する
    function route() {
        const filename = project.name.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").slice(0, 100) + ".vcr"; // 安全な初期ファイル名
        return browserSaveRoute(filename, download, async () => window.confirm(
            "ダウンロードを開始しました。保存先でファイルの保存完了を確認したらOKを押してください。アプリはファイルを検証していません。"));
    }

    ////////////////////
    // 結果または原因を表示し、失敗後も同じ操作を再試行できるようにする
    async function run(action: () => Promise<void>) {
        setBusy(true);
        setMessage("");
        try { await action(); }
        catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
        finally {
            setBusy(false);
            refresh((value) => value + 1);
            onChange?.();
        }
    }

    ////////////////////
    // 読込対象を選び、保存済みなら直ちに検証し、未保存なら選択を待つ
    async function selectOpen(candidate: Pending) {
        if (flow.history.isSaved) {
            await flow.open(candidate.file, candidate.target, "discard");
            setMessage("プロジェクトを開きました。");
        } else {
            setPending(candidate);
        }
    }

    ////////////////////
    // 未保存変更の選択を読込処理へ渡す
    function openPending(decision: OpenDecision, saveAs = false) {
        if (!pending) return;
        if (decision === "cancel") { setPending(undefined); return; }
        void run(async () => {
            const result = await flow.open(pending.file, pending.target, decision, decision === "save" ? route() : undefined, saveAs); // 切替結果
            if (result === "opened") {
                setPending(undefined);
                setMessage("プロジェクトを開きました。");
            } else {
                setMessage(result === "changed" ? "追加編集があるため、再度確認してください。" : "保存を確認できませんでした。");
            }
        });
    }

    ////////////////////
    // 画像を検証し、履歴に素材登録を記録する
    async function addImage(file: File) {
        if (file.size > REVIEW_VCR_LIMITS.entryBytes) throw new Error("画像容量が検証上限を超えています。");
        const mediaType = await imageMediaType(file); // 実バイトから識別した画像形式
        const dimensions = await readImageDimensions(file, mediaType, REVIEW_VCR_LIMITS.imagePixels); // デコード前の寸法
        const asset = { id: crypto.randomUUID(), name: file.name, mediaType, ...dimensions }; // 検証済みメタデータ
        await verifyBrowserImage(file.slice(0, file.size, mediaType), asset);
        flow.history.execute({ kind: "asset.add", asset });
        flow.rememberImage(asset.id, file);
        flow.collectImages();
    }

    return <main style={{ padding: "2rem" }}>
        <h1>T04 .vcr 保存・読込検証</h1>
        <p><a href="./">T01検証へ戻る</a></p>
        <p>{project.name}（{project.mode}） / {flow.history.isSaved ? "保存済み" : "未保存"}</p>
        <fieldset disabled={busy || pending !== undefined}>
            <legend>ファイル操作</legend>
            <label><input type="checkbox" checked={download} disabled={!canOverwrite}
                onChange={(event) => setDownload(event.currentTarget.checked)} />ダウンロード方式</label>
            {!canOverwrite && <p>ファイルハンドルが使えないため、ダウンロード方式で保存します。</p>}
            <button onClick={() => void run(async () => setMessage(await flow.save(route()) ? "保存済みとして記録しました。" : "保存確認を取り消しました。"))}>
                {download ? "ダウンロードして保存" : "保存"}
            </button>
            {!download && <button onClick={() => void run(async () => {
                if (await flow.save(route(), true)) setMessage("別の場所に保存しました。");
            })}>別の場所に保存</button>}
            {canPickOpen && <button onClick={() => void run(async () => selectOpen(await pickProject()))}>上書き先を保持して開く</button>}
            <label>ファイルから開く <input type="file" accept=".vcr" onChange={(event) => {
                const file = event.currentTarget.files?.[0]; // 開く対象
                event.currentTarget.value = "";
                if (file) void run(() => selectOpen({ file }));
            }} /></label>
        </fieldset>
        {pending && <section role="group" aria-label="未保存変更の確認">
            <p>未保存の変更があります。{pending.file.name} を開く前に選択してください。</p>
            <label><input type="checkbox" checked={download} disabled={busy || !canOverwrite}
                onChange={(event) => setDownload(event.currentTarget.checked)} />ダウンロード方式</label>
            <button disabled={busy} onClick={() => openPending("save")}>保存して開く</button>
            {!download && <button disabled={busy} onClick={() => openPending("save", true)}>別の場所に保存して開く</button>}
            <button disabled={busy} onClick={() => openPending("discard")}>保存せずに開く</button>
            <button disabled={busy} onClick={() => openPending("cancel")}>キャンセル</button>
        </section>}
        <fieldset disabled={busy || pending !== undefined}>
            <legend>登録画像と履歴</legend>
            <label>画像を追加 <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
                const file = event.currentTarget.files?.[0]; // 登録する画像
                event.currentTarget.value = "";
                if (file) void run(() => addImage(file));
            }} /></label>
            <button disabled={!flow.history.canUndo} onClick={() => { flow.history.undo(); refresh((value) => value + 1); onChange?.(); }}>Undo</button>
            <button disabled={!flow.history.canRedo} onClick={() => { flow.history.redo(); refresh((value) => value + 1); onChange?.(); }}>Redo</button>
            <ul>{project.assets.map((asset) => <li key={asset.id}>{asset.name} ({asset.width}×{asset.height})</li>)}</ul>
        </fieldset>
        <p role="status">{message}</p>
    </main>;
}
