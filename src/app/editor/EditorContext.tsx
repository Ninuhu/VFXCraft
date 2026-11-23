import { createContext, useContext } from "react";
import type { EditCommand } from "../../core/editing/command.ts";
import type { ProjectFileFlow } from "../projectFiles/projectFileFlow.ts";
import type { LayerSelection } from "./selection.ts";
import type { ShortcutAction, Shortcuts } from "./shortcuts.ts";

export type EditorContextValue = {
    flow: ProjectFileFlow; time: { current: number }; selection: LayerSelection;
    setSelection: (value: LayerSelection) => void; refresh: () => void;
    execute: (command: EditCommand) => boolean; report: (error: unknown) => void;
    autoKey: boolean; space: "world" | "parent"; snap: boolean; interval: number;
    tool: "select" | "move" | "rotate" | "scale"; light: boolean;
    shortcuts: Shortcuts; tip: (action: ShortcutAction, description: string) => string;
    confirm: (title: string, choices: readonly string[]) => Promise<number>;
};
export const EditorContext = createContext<EditorContextValue | null>(null); // 一文書をすべてのパネルで共有

////////////////////
// 設定・一時状態と文書を所有する正式UIのセッションを取得する。
export function useEditor(): EditorContextValue {
    const value = useContext(EditorContext); // プロバイダー外の誤利用を検出
    if (!value) throw new Error("エディタセッションがありません。");
    return value;
}
