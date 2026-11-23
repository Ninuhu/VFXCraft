export type LayerSelection = { readonly ids: readonly string[]; readonly active: string | null; readonly anchor: string | null };
export const EMPTY_SELECTION: LayerSelection = { ids: [], active: null, anchor: null }; // 文書を切り替えた時の選択

////////////////////
// 新規・読込後は最初の層を一つ選び、空文書は何も選択しない。
export function firstLayerSelection(ids: readonly string[]): LayerSelection {
    const id = ids[0] ?? null; // 文書切替前のIDは引き継がない
    return { ids: id ? [id] : [], active: id, anchor: id };
}

////////////////////
// Shiftの範囲は折りたたみ後の可視順を使う。編集対象は常に一つだけ保持する。
export function selectLayer(current: LayerSelection, id: string, visible: readonly string[], ctrl: boolean, shift: boolean): LayerSelection {
    if (!visible.includes(id)) return current;
    if (shift && current.anchor && visible.includes(current.anchor)) {
        const first = visible.indexOf(current.anchor), last = visible.indexOf(id); // 可視範囲の端
        const range = visible.slice(Math.min(first, last), Math.max(first, last) + 1); // 親子の非表示行は含めない
        return { ids: ctrl ? [...new Set([...current.ids, ...range])] : range, active: id, anchor: current.anchor };
    }
    const ids = ctrl ? current.ids.includes(id) ? current.ids.filter((item) => item !== id) : [...current.ids, id] : [id]; // Ctrlのトグル
    return { ids, active: ids.includes(id) ? id : ids.at(-1) ?? null, anchor: id };
}

////////////////////
// 削除・読込後に存在しないIDをUIへ残さない。
export function pruneSelection(current: LayerSelection, available: readonly string[]): LayerSelection {
    const ids = current.ids.filter((id) => available.includes(id)); // 保存対象ではない一時状態
    return { ids, active: current.active && ids.includes(current.active) ? current.active : ids.at(-1) ?? null,
        anchor: current.anchor && available.includes(current.anchor) ? current.anchor : null };
}
