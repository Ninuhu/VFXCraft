import type { Gradient, GradientStop, LinearRgb } from "../../core/document/model.ts";
import { toLinear, toSrgb } from "../../core/materials/materialEvaluation.ts";
import type { ReactNode } from "react";

////////////////////
// HTML色入力の表示用sRGBを作る
export function colorHex(rgb: LinearRgb): string {
    return "#" + rgb.map((value) => Math.round(toSrgb(value) * 255).toString(16).padStart(2, "0")).join("");
}

////////////////////
// HTML色入力をモデルのLinear sRGBへ変換する
export function fromHex(value: string): LinearRgb {
    return [1, 3, 5].map((index) => toLinear(parseInt(value.slice(index, index + 2), 16) / 255)) as unknown as LinearRgb;
}

////////////////////
// 数値入力はフォーカス離脱で一度確定し、途中のタイプを履歴に載せない
export function NumberField({ label, value, max = 1, onCommit }: {
    label: string; value: number; max?: number; onCommit: (value: number) => void;
}) {
    return <label>{label}<input key={value} type="number" min={0} max={max} step="any" defaultValue={value}
        onBlur={(event) => {
            const input = event.currentTarget; // 確定時だけ数値を読む
            if (input.valueAsNumber !== value) onCommit(input.valueAsNumber);
            input.value = String(value);
        }}
        onKeyDown={(event) => {
            if (event.key === "Escape") event.currentTarget.value = String(value);
            if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
        }} /></label>;
}

////////////////////
// 次の制御点は最も広い区間の中央に置き、既存の点と重複させない
function nextOffset(stops: readonly GradientStop<unknown>[]): number {
    const edges = [0, ...stops.map((stop) => stop.offset), 1]; // 候補となる区間の境界
    let best = 0; // 最大区間の左側
    for (let index = 1; index < edges.length - 1; index++) {
        if (edges[index + 1]! - edges[index]! > edges[best + 1]! - edges[best]!) best = index;
    }
    return (edges[best]! + edges[best + 1]!) / 2;
}

////////////////////
// 色と透明度の制御点を別々に編集する
export function GradientControls({ name, gradient, onChange, renderColor }: {
    name: string; gradient: Gradient; onChange: (gradient: Gradient) => void;
    renderColor?: (label: string, value: LinearRgb, replace: (value: LinearRgb) => Gradient) => ReactNode;
}) {
    ////////////////////
    // 一点を差し替え、整列や重複チェックは文書検証へ委ねる
    function replace<T>(stops: readonly GradientStop<T>[], index: number, stop: GradientStop<T>) {
        return stops.map((current, position) => position === index ? stop : current);
    }
    return <fieldset><legend>{name}</legend>
        <p>位置は0〜1。色と透明度は別々に設定できます。</p>
        {gradient.colors.map((stop, index) => <div key={index} className="material-fields">
            <NumberField label={name + " 色位置 " + (index + 1)} value={stop.offset} onCommit={(offset) =>
                onChange({ ...gradient, colors: replace(gradient.colors, index, { ...stop, offset }) })} />
            {renderColor ? renderColor(name + " 色 " + (index + 1), stop.value, (value) => ({ ...gradient, colors: replace(gradient.colors, index, { ...stop, value }) }))
                : <label>色 {index + 1}<input key={colorHex(stop.value)} type="color" defaultValue={colorHex(stop.value)} onBlur={(event) => {
                if (event.currentTarget.value !== colorHex(stop.value)) onChange({ ...gradient,
                    colors: replace(gradient.colors, index, { ...stop, value: fromHex(event.currentTarget.value) }) });
            }} /></label>}
            <button onClick={() => onChange({ ...gradient, colors: gradient.colors.filter((_, position) => position !== index) })}>色 {index + 1} を削除</button>
        </div>)}
        <button disabled={gradient.colors.length >= 64} onClick={() => onChange({ ...gradient,
            colors: [...gradient.colors, { offset: nextOffset(gradient.colors), value: [1, 1, 1] }] })}>色を追加</button>
        {gradient.alphas.map((stop, index) => <div key={index} className="material-fields">
            <NumberField label={name + " 透明度位置 " + (index + 1)} value={stop.offset} onCommit={(offset) =>
                onChange({ ...gradient, alphas: replace(gradient.alphas, index, { ...stop, offset }) })} />
            <NumberField label={name + " 透明度 " + (index + 1)} value={stop.value} onCommit={(value) =>
                onChange({ ...gradient, alphas: replace(gradient.alphas, index, { ...stop, value }) })} />
            <button onClick={() => onChange({ ...gradient, alphas: gradient.alphas.filter((_, position) => position !== index) })}>透明度 {index + 1} を削除</button>
        </div>)}
        <button disabled={gradient.alphas.length >= 64} onClick={() => onChange({ ...gradient,
            alphas: [...gradient.alphas, { offset: nextOffset(gradient.alphas), value: 1 }] })}>透明度を追加</button>
    </fieldset>;
}
