////////////////////
// ブラウザの代表的な保存失敗を操作可能な説明へ変換する。文書内容はログに出さない。
export function persistenceErrorMessage(error: unknown): string {
    const name = error instanceof Error || error instanceof DOMException ? error.name : ""; // 発生元に依存しない例外名
    if (name === "QuotaExceededError") return "自動保存用ストレージの容量が不足しています。編集内容は保持されています。.vcrへ保存してください。";
    if (name === "NotAllowedError" || name === "SecurityError") return "保存先またはブラウザ内ストレージへのアクセスが許可されていません。権限を確認するか、別名保存・ダウンロード方式を選んでください。";
    if (name === "AbortError") return "保存・読込処理が中断されました。現在の編集内容は保持されています。";
    return error instanceof Error ? error.message : "保存・復元処理に失敗しました。現在の編集内容を保持して再試行してください。";
}
