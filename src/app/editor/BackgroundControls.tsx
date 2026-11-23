import { useState } from "react";
import { validateBackground } from "../../core/document/validateDocument.ts";
import type { BackgroundSettings } from "../../core/document/model.ts";
import { DEFAULT_BACKGROUND, DEFAULT_PREVIEW, resolveBackground } from "../../core/materials/materialEvaluation.ts";
import { colorHex, fromHex } from "../materials/GradientControls.tsx";
import { useEditor } from "./EditorContext.tsx";

////////////////////
// 共通背景と項目単位のプロジェクト上書きを区別し、継承解除も編集履歴へ載せる。
export function BackgroundControls() {
    const editor = useEditor(), project = editor.flow.history.preview; // 現在の文書
    const [scope, setScope] = useState<"common" | "project">("project"); // 一時的な編集先
    const [common, setCommon] = useState<BackgroundSettings>(() => {
        try { return resolveBackground(DEFAULT_BACKGROUND, validateBackground(JSON.parse(localStorage.getItem("vfxcraft.preview.background") ?? "{}"))); }
        catch { return DEFAULT_BACKGROUND; }
    });
    const preview = project.preview ?? DEFAULT_PREVIEW, current = scope === "common" ? common : resolveBackground(common, preview.background); // 実効値
    ////////////////////
    // 保存先に応じて更新し、falseと未設定を混同しない。
    function change(key: keyof BackgroundSettings, value?: BackgroundSettings[keyof BackgroundSettings]) {
        try {
            if (scope === "project") {
                const background = { ...preview.background }; // 未変更の項目は.vcrにコピーしない
                if (value === undefined) delete background[key]; else Object.assign(background, { [key]: value });
                editor.execute({ kind: "project.preview", preview: { ...preview, background } });
            } else {
                const next = resolveBackground(DEFAULT_BACKGROUND, validateBackground({ ...common, [key]: value })); // 保存前に外部入力と同じ検証
                localStorage.setItem("vfxcraft.preview.background", JSON.stringify(next)); setCommon(next);
            }
        } catch (error) { editor.report(error); }
    }
    return <details><summary>背景・チェッカー・グリッド（プレビュー補助）</summary>
        <label>設定先<select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="project">プロジェクト上書き（.vcr）</option><option value="common">利用者共通</option></select></label>
        <label>背景色<input type="color" value={colorHex(current.color)} onChange={(event) => change("color", fromHex(event.target.value))} /></label>
        {(["checker", "grid"] as const).map((key) => <label key={key}><input type="checkbox" checked={current[key]} onChange={(event) => change(key, event.target.checked)} />{key === "grid" ? "グリッド表示" : "チェッカー表示"}</label>)}
        <label>グリッド透明度<input type="range" min={0} max={1} step={0.05} value={current.gridOpacity} onChange={(event) => change("gridOpacity", event.target.valueAsNumber)} /></label>
        {scope === "project" && <>{(["color", "checker", "grid", "gridOpacity"] as const).map((key) => <button key={key} disabled={preview.background[key] === undefined} onClick={() => change(key)}>{key}の上書きを解除</button>)}</>}
    </details>;
}
