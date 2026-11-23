import { useEffect, useRef } from "react";
import type { LinearRgb } from "../../core/document/model.ts";
import type { EditCommand } from "../../core/editing/command.ts";
import { colorHex, fromHex } from "../materials/GradientControls.tsx";
import { useEditor } from "./EditorContext.tsx";

////////////////////
// 色選択中は即時描画し、色選択一回を一履歴にする。Escape・取り外しで開始前へ戻す。
export function EditColor({ label, value, command }: { label: string; value: LinearRgb; command: (value: LinearRgb, timeUs: number) => EditCommand }) {
    const editor = useEditor(), token = useRef<symbol | null>(null); // この入力の排他的な編集
    const editTime = useRef(0); // 再生中も操作開始時刻の一つのキーへまとめる
    useEffect(() => () => { if (token.current) { try { editor.flow.history.cancelContinuousEdit(token.current); } catch { /* 文書切替済み */ } } }, [editor.flow]);
    ////////////////////
    // 開いていた連続編集を一度だけ終了する。
    function finish(cancel = false) {
        if (token.current) {
            if (cancel) editor.flow.history.cancelContinuousEdit(token.current);
            else if (!editor.flow.history.commitContinuousEdit(token.current)) { try { editor.flow.history.cancelContinuousEdit(token.current); } catch { /* 無変更 */ } }
        }
        token.current = null; editor.refresh();
    }
    return <label>{label}<input aria-label={label} type="color" value={colorHex(value)} onFocus={() => {
        try { editTime.current = editor.time.current; token.current = editor.flow.history.beginContinuousEdit(); editor.refresh(); } catch (error) { editor.report(error); }
    }} onChange={(event) => {
        try {
            if (!token.current) { editTime.current = editor.time.current; token.current = editor.flow.history.beginContinuousEdit(); }
            editor.flow.history.updateContinuousEdit(token.current, command(fromHex(event.target.value), editTime.current)); editor.refresh();
        } catch (error) { editor.report(error); }
    }} onBlur={() => finish()} onKeyDown={(event) => { if (event.key === "Escape") { finish(true); event.currentTarget.blur(); } }} /></label>;
}
