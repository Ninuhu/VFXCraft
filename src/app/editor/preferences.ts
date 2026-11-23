export const PANEL_IDS = ["hierarchy", "properties", "timeline", "preview"] as const; // 初期構成に復帰できる固定パネル
export type PanelId = typeof PANEL_IDS[number];
export type PanelLayout = Record<PanelId, { visible: boolean; region: "left" | "right" | "center" | "bottom" }> &
    { leftWidth: number; rightWidth: number; bottomHeight: number };
export const DEFAULT_LAYOUT: PanelLayout = { hierarchy: { visible: true, region: "left" }, properties: { visible: true, region: "right" },
    timeline: { visible: true, region: "bottom" }, preview: { visible: true, region: "center" }, leftWidth: 250, rightWidth: 330, bottomHeight: 240 };

////////////////////
// 欠損・未知フィールドは既定値で補う。不正値は画面を隠す理由にしない。
export function parseLayout(input: unknown): PanelLayout {
    const result = structuredClone(DEFAULT_LAYOUT); // 既定値の共有を避ける
    if (!input || typeof input !== "object") return result;
    const data = input as Record<string, unknown>; // 検証前の設定
    for (const id of PANEL_IDS) {
        const panel = data[id]; // 新版で追加したパネルは初期表示
        if (!panel || typeof panel !== "object") continue;
        const value = panel as Record<string, unknown>; // 項目単位で復旧
        if (typeof value.visible === "boolean") result[id].visible = value.visible;
        if (["left", "right", "center", "bottom"].includes(String(value.region))) result[id].region = value.region as PanelLayout[PanelId]["region"];
    }
    for (const [key, min, max] of [["leftWidth", 180, 550], ["rightWidth", 240, 650], ["bottomHeight", 180, 650]] as const) {
        const value = data[key]; // 過去の極端なウィンドウサイズから復旧
        if (typeof value === "number" && Number.isFinite(value)) result[key] = Math.max(min, Math.min(max, value));
    }
    return result;
}
