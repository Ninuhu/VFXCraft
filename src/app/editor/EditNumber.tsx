import { useEffect, useRef, useState } from "react";
import { useEditor } from "./EditorContext.tsx";
import type { EditCommand } from "../../core/editing/command.ts";

////////////////////
// 一時文字列は文書へ保存しない。有効な入力を即時反映し、フォーカス一回を一履歴にまとめる。
export function EditNumber({ label, value, command, min, max, step = "any" }: {
    label: string; value: number; command: (value: number, timeUs: number) => EditCommand; min?: number; max?: number; step?: number | "any";
}) {
    const editor = useEditor(), token = useRef<symbol | undefined>(undefined); // 一つの入力が所有する編集
    const [text, setText] = useState<string | null>(null); // 符号・小数点だけの途中文字列も保持
    const valid = useRef(true); // 不正な末尾入力で確定しない
    const editTime = useRef(0); // 再生中の入力も開始時刻の一つのキーへ集約する
    useEffect(() => () => {
        if (token.current) {
            try { editor.flow.history.cancelContinuousEdit(token.current); } catch { /* 文書の切替で既に終了した操作 */ }
            token.current = undefined;
        }
    }, [editor.flow]);
    ////////////////////
    // 入力の所有を終了する。キャンセル・不正入力では開始前へ戻す。
    function finish(cancel: boolean) {
        if (token.current) {
            if (cancel || !valid.current) editor.flow.history.cancelContinuousEdit(token.current);
            else editor.flow.history.commitContinuousEdit(token.current);
        }
        token.current = undefined; setText(null); editor.refresh();
    }
    return <label>{label}<input aria-label={label} title={label + "。入力中に反映。Enterで確定、Escapeで取消。"}
        type="number" step={step} {...(min === undefined ? {} : { min })} {...(max === undefined ? {} : { max })}
        value={text ?? String(value)} onFocus={() => { try { editTime.current = editor.time.current; token.current = editor.flow.history.beginContinuousEdit(); valid.current = true; editor.refresh(); }
            catch (error) { editor.report(error); } }} onChange={(event) => {
            setText(event.currentTarget.value);
            const number = event.currentTarget.valueAsNumber; // 文書へ渡す前の入力検証
            valid.current = Number.isFinite(number) && (min === undefined || number >= min) && (max === undefined || number <= max);
            if (!valid.current || !token.current) return;
            try { valid.current = editor.flow.history.updateContinuousEdit(token.current, command(number, editTime.current)); editor.refresh(); }
            catch (error) { valid.current = false; editor.report(error); }
        }} onBlur={() => finish(false)} onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); finish(true); event.currentTarget.blur(); }
            if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        }} /></label>;
}
