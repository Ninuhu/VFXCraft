export const DEFAULT_SHORTCUTS = {
    new: ["Ctrl+Alt+N"], open: ["Ctrl+Alt+O"], save: ["Ctrl+S"], saveAs: ["Ctrl+Shift+S"],
    undo: ["Ctrl+Z"], redo: ["Ctrl+Y", "Ctrl+Shift+Z"], duplicate: ["Ctrl+D"], group: ["Ctrl+G"], ungroup: ["Ctrl+Shift+G"],
    delete: ["Delete"], rename: ["F2"], play: ["Space"], previous: ["ArrowLeft"], next: ["ArrowRight"], key: ["I"],
    select: ["Q"], move: ["W"], rotate: ["E"], scale: ["R"], frame: ["F"], reset: ["Shift+R"], space: ["X"], snap: ["Shift+G"],
    hierarchy: ["Alt+Shift+1"], properties: ["Alt+Shift+2"], timeline: ["Alt+Shift+3"],
}; // ツールチップ・設定一覧・実行判定の正本
export type ShortcutAction = keyof typeof DEFAULT_SHORTCUTS;
export type Shortcuts = Record<ShortcutAction, string[]>;
export const ACTION_LABELS: Record<ShortcutAction, string> = {
    new: "新規プロジェクト", open: "プロジェクトを開く", save: "保存", saveAs: "別名保存", undo: "Undo", redo: "Redo",
    duplicate: "レイヤー複製", group: "グループ化", ungroup: "グループ解除", delete: "削除", rename: "名前変更", play: "再生／一時停止",
    previous: "1フレーム戻る", next: "1フレーム進む", key: "キーフレーム追加", select: "選択", move: "移動", rotate: "回転", scale: "スケール",
    frame: "エフェクト全体表示", reset: "カメラリセット", space: "World／Parent Local", snap: "位置スナップ", hierarchy: "レイヤーパネル", properties: "インスペクター", timeline: "タイムライン",
};

////////////////////
// Windowsの修飾キー順を統一し、IME・単独の修飾キーは登録しない。
export function shortcutKey(event: { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey?: boolean; isComposing?: boolean }): string | null {
    if (event.isComposing || event.metaKey || ["Control", "Alt", "Shift", "Meta", "Process", "Dead"].includes(event.key)) return null;
    const key = event.key === " " ? "Space" : event.key.length === 1 ? event.key.toUpperCase() : event.key; // 表示と照合を共通化
    return [event.ctrlKey ? "Ctrl" : "", event.altKey ? "Alt" : "", event.shiftKey ? "Shift" : "", key].filter(Boolean).join("+");
}

////////////////////
// 明確にブラウザ・OSへ委ねるキーは登録拒否する。その他の競合も保証しない。
export function canAssignShortcut(key: string): boolean {
    return /^(?:(?:Ctrl|Alt|Shift)\+)*(?:[A-Z0-9]|F[1-9][0-2]?|Space|Delete|ArrowLeft|ArrowRight)$/.test(key)
        && !["Alt+F4", "Ctrl+W", "Ctrl+T", "Ctrl+N", "Ctrl+L", "Ctrl+R", "F5", "F11", "F12"].includes(key);
}

////////////////////
// 設定を検証し、重複割当は後勝ちにせず最初の一操作だけへ復旧する。
export function parseShortcuts(input: unknown): Shortcuts {
    const result = structuredClone(DEFAULT_SHORTCUTS) as Shortcuts; // 設定未作成時の初期割当
    if (!input || typeof input !== "object") return result;
    const data = input as Record<string, unknown>, used = new Set<string>(); // 外部設定と競合検査
    for (const action of Object.keys(result) as ShortcutAction[]) {
        const candidate = data[action]; // 欠けたアクションは初期値
        result[action] = (Array.isArray(candidate) ? candidate : result[action]).filter((value): value is string => {
            if (typeof value !== "string" || !canAssignShortcut(value) || used.has(value)) return false;
            used.add(value); return true;
        });
    }
    return result;
}

////////////////////
// ユーザーが競合の解除を確認した後でだけ、元の割当を外す。
export function assignShortcut(current: Shortcuts, action: ShortcutAction, key: string, replace: boolean): Shortcuts {
    if (!canAssignShortcut(key)) throw new Error("ブラウザ・OS予約キー、または未対応の組合せです。");
    const conflict = (Object.keys(current) as ShortcutAction[]).find((item) => item !== action && current[item].includes(key)); // 競合元
    if (conflict && !replace) throw new Error("既存の割当を解除する確認が必要です。");
    return Object.fromEntries(Object.entries(current).map(([id, keys]) => [id, id === action ? [key] : keys.filter((item) => item !== key)])) as Shortcuts;
}
