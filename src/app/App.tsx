import { useState } from "react";

////////////////////
// Reactの表示とイベント処理を確認するための最小画面
export function App() {
    const [isConfirmed, setIsConfirmed] = useState(false); // 操作確認の実行状態

    return (
        <main className="verification">
            <p className="verification__label">T01 検証用UI · Phase 1</p>
            <h1>VFXCraft</h1>
            <p>最小Webアプリの起動を確認しています。</p>
            <p className="verification__note">
                この画面は技術検証用です。製品版の画面配置は今後設計します。
            </p>
            <button type="button" onClick={() => setIsConfirmed(true)}>
                操作を確認する
            </button>
            <p role="status">
                {isConfirmed
                    ? "操作を確認しました。Reactの画面更新が動作しています。"
                    : "起動しました。ボタンで画面更新を確認できます。"}
            </p>
            <p className="verification__note">
                描画・保存・出力の検証は次のPhaseで実施します。
            </p>
        </main>
    );
}
