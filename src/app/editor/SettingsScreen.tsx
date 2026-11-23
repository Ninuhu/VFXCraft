import { useState } from "react";
import { ACTION_LABELS, assignShortcut, DEFAULT_SHORTCUTS, shortcutKey, type ShortcutAction, type Shortcuts } from "./shortcuts.ts";
import { DEFAULT_LAYOUT, PANEL_IDS, type PanelLayout } from "./preferences.ts";
import { PANEL_LABELS } from "./Workspace.tsx";

////////////////////
// 共通設定をプロジェクトのUndo・保存形式から独立して編集する。
export function SettingsScreen({ shortcuts, layout, setShortcuts, setLayout, confirm, report }: {
    shortcuts: Shortcuts; layout: PanelLayout; setShortcuts: (value: Shortcuts) => void; setLayout: (value: PanelLayout) => void;
    confirm: (title: string, choices: readonly string[]) => Promise<number>; report: (error: unknown) => void;
}) {
    const [capture, setCapture] = useState<ShortcutAction | null>(null); // 登録中は通常ショートカットを処理しない
    return <><h1>設定</h1><div className="screen-columns"><aside>表示・操作<br />ショートカット<br />パネル配置</aside><section>
        <h2>ワークスペース</h2><p>ユーザー共通設定です。.vcrには含まれません。見出しのドラッグでもパネルを移動できます。</p>
        {PANEL_IDS.map((id) => <label key={id}><input aria-label={PANEL_LABELS[id]} type="checkbox" checked={layout[id].visible} onChange={(event) => setLayout({ ...layout, [id]: { ...layout[id], visible: event.target.checked } })} />{PANEL_LABELS[id]}
            <select aria-label={PANEL_LABELS[id] + "配置"} value={layout[id].region} onChange={(event) => setLayout({ ...layout, [id]: { ...layout[id], region: event.target.value as typeof layout[typeof id]["region"] } })}>
                <option value="left">左</option><option value="right">右</option><option value="center">中央</option><option value="bottom">下</option></select></label>)}
        <button onClick={() => setLayout(structuredClone(DEFAULT_LAYOUT))}>初期配置に戻す</button>
        <h2>ショートカット</h2><p>登録ボタンを押してからキーを入力します。Escapeで取消。ブラウザ・OSが優先する操作は上書きを保証しません。</p>
        <button onClick={() => setShortcuts(structuredClone(DEFAULT_SHORTCUTS))}>ショートカットを初期設定に戻す</button>
        <table><thead><tr><th>機能</th><th>現在の割当</th><th>変更</th></tr></thead><tbody>
            {(Object.keys(ACTION_LABELS) as ShortcutAction[]).map((action) => <tr key={action}><td>{ACTION_LABELS[action]}</td><td>{shortcuts[action].join(" / ") || "未割当"}</td><td>
                <button aria-label={ACTION_LABELS[action] + "のキー登録"} onClick={() => setCapture(action)} onKeyDown={(event) => {
                    if (capture !== action) return;
                    event.preventDefault(); event.stopPropagation();
                    if (event.key === "Escape") { setCapture(null); return; }
                    const key = shortcutKey(event.nativeEvent); // 同じ形式で登録・実行・説明する
                    if (!key) return;
                    setCapture(null);
                    const conflict = (Object.keys(shortcuts) as ShortcutAction[]).find((item) => item !== action && shortcuts[item].includes(key)); // 確認前は変更しない
                    void (async () => {
                        try {
                            if (conflict && await confirm(`${key} は「${ACTION_LABELS[conflict]}」に割当済みです。`, ["既存割当を解除して登録"]) !== 0) return;
                            setShortcuts(assignShortcut(shortcuts, action, key, Boolean(conflict)));
                        } catch (error) { report(error); }
                    })();
                }}>{capture === action ? "キーを入力…" : "登録"}</button>
                <button aria-label={ACTION_LABELS[action] + "の割当解除"} onClick={() => setShortcuts({ ...shortcuts, [action]: [] })}>解除</button>
            </td></tr>)}
        </tbody></table>
    </section></div></>;
}
