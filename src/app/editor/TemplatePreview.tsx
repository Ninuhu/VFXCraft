import { useEffect, useRef } from "react";
import type { Mode } from "../../core/document/model.ts";
import { MaterialPreview } from "../../rendering/MaterialPreview.ts";
import { DEFAULT_BACKGROUND } from "../../core/materials/materialEvaluation.ts";
import { newEditorProject, type ProjectTemplate } from "./projectFactory.ts";

////////////////////
// 新規作成の見本も実際の文書と描画器で表示し、選択方式と食い違う架空画像を使わない。
export function TemplatePreview({ mode, template }: { mode: Mode; template: ProjectTemplate }) {
    const canvas = useRef<HTMLCanvasElement>(null); // 見本だけの一時描画先
    useEffect(() => {
        let preview: MaterialPreview | undefined; // 見本を切り替えるとGPUを解放
        try {
            preview = new MaterialPreview(canvas.current!);
            preview.draw(newEditorProject(mode, template, "見本"), 1_000_000, { light: false, images: new Map(), background: { ...DEFAULT_BACKGROUND, checker: true } });
        } catch { /* WebGL不可でも新規フォームとエラー説明を操作可能に保つ */ }
        return () => preview?.dispose();
    }, [mode, template]);
    return <><h2>プレビュー（1秒時点）</h2><canvas ref={canvas} aria-label="新規プロジェクトの見本" style={{ width: "100%", height: "auto" }} /></>;
}
