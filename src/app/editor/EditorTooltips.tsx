import { useEffect, useState } from "react";

////////////////////
// titleを説明の正本とし、マウスとキーボードフォーカスの両方で画面内に表示する。
export function EditorTooltips() {
    const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null); // 表示だけの一時状態
    useEffect(() => {
        let owner: HTMLElement | null = null, previous: string | null = null; // aria-describedbyを元へ戻すために保持
        ////////////////////
        // 説明の所有権を返し、別の入力への説明残りを防ぐ。
        function clear() {
            if (owner) { if (previous === null) owner.removeAttribute("aria-describedby"); else owner.setAttribute("aria-describedby", previous); }
            owner = null; previous = null; setTooltip(null);
        }
        ////////////////////
        // 実際のタイトルを毎回読み、変更したショートカットも即時表示する。
        function show(event: Event) {
            const target = event.target instanceof Element ? event.target.closest<HTMLElement>(".vfx-app [title]") : null; // エディタ以外は対象外
            if (!target) { clear(); return; }
            const text = target.title; // ラベル・現在割当を同じデータから得る
            if (!text) { clear(); return; }
            if (owner !== target) { clear(); owner = target; previous = target.getAttribute("aria-describedby"); target.setAttribute("aria-describedby", "editor-tooltip"); }
            const rect = target.getBoundingClientRect(); // 狭い画面でもはみ出さない位置
            setTooltip({ text, x: Math.max(8, Math.min(innerWidth - 328, rect.left)), y: Math.max(8, Math.min(innerHeight - 100, rect.bottom + 8)) });
        }
        document.addEventListener("focusin", show); document.addEventListener("pointerover", show); document.addEventListener("focusout", clear);
        window.addEventListener("blur", clear);
        return () => { document.removeEventListener("focusin", show); document.removeEventListener("pointerover", show); document.removeEventListener("focusout", clear); window.removeEventListener("blur", clear); if (owner) { if (previous === null) owner.removeAttribute("aria-describedby"); else owner.setAttribute("aria-describedby", previous); } };
    }, []);
    return tooltip && <div id="editor-tooltip" role="tooltip" className="editor-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>{tooltip.text}</div>;
}
