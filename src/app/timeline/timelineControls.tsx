import { useEffect, useRef, type ReactNode } from "react";
import type { TrackProperty, TrackValue } from "../../core/document/model.ts";

export const TRACK_LABELS: Record<TrackProperty, string> = {
    position: "位置", rotation: "回転", size: "スケール", color: "レイヤー色", opacity: "レイヤー透明度",
    rate: "発生率", lifetimeUs: "寿命（µs）", speed: "初速度", direction: "発生方向", acceleration: "加速度",
    particleSize: "粒子サイズ倍率", materialColor: "材質色", materialOpacity: "材質透明度", bloomStrength: "Bloom強度",
}; // 発生器・材質ともレイヤーの下に表示する

////////////////////
// 数値を確定したときだけ履歴に送る
export function TimelineNumber({ label, value, onCommit }: { label: string; value: number; onCommit: (value: string) => void }) {
    return <label>{label}<input aria-label={label} key={value} type="number" step="any" defaultValue={value}
        onBlur={(event) => {
            const input = event.currentTarget; // 候補を送ってから表示を確定値へ戻す
            if (input.value !== String(value)) onCommit(input.value);
            input.value = String(value);
        }} onKeyDown={(event) => {
            if (event.key === "Escape") event.currentTarget.value = String(value);
            if (event.key === "Enter" || event.key === "Escape") {
                event.preventDefault(); // 同じEnterで直後の確認ダイアログを確定させない
                event.currentTarget.blur();
            }
        }} /></label>;
}

////////////////////
// 値型を崩さず、一つのスカラーまたはベクトル成分を編集する
export function KeyValueFields({ value, onCommit }: { value: TrackValue; onCommit: (value: TrackValue) => void }) {
    const parts = typeof value === "number" ? [value] : value; // モードと対象に応じた成分
    return <>{parts.map((part, index) => <TimelineNumber key={index} label={parts.length === 1 ? "キー値" : "キー値 " + (index + 1)}
        value={part} onCommit={(input) => {
            const parsed = input.trim() ? Number(input) : NaN; // 値域は既存の文書検証が確定する
            onCommit(typeof value === "number" ? parsed : value.map((entry, component) =>
                component === index ? parsed : entry) as unknown as TrackValue);
        }} />)}</>;
}

////////////////////
// ネイティブのモーダルでフォーカスを閉じ、Escapeは安全な取消へ戻す
export function TimelineDialog({ label, children, onCancel }: { label: string; children: ReactNode; onCancel: () => void }) {
    const dialog = useRef<HTMLDialogElement>(null); // フォーカストラップを所有する要素
    const cancel = useRef<HTMLButtonElement>(null); // 初期フォーカスは常に安全な操作
    useEffect(() => {
        const element = dialog.current!;
        element.showModal();
        cancel.current?.focus();
        return () => { element.close(); };
    }, []);
    return <dialog ref={dialog} aria-label={label} onCancel={(event) => { event.preventDefault(); onCancel(); }}>
        <h2>{label}</h2>
        <button ref={cancel} onClick={onCancel}>キャンセル</button>
        {children}
    </dialog>;
}
