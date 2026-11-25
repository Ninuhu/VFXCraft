import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { Mode } from "../../core/document/model.ts";
import { advancePlaybackClock, timeUsToFrame, type PlaybackClock } from "../../core/document/playback.ts";
import { frameToTimeUs } from "../../core/document/time.ts";
import type { EditCommand } from "../../core/editing/command.ts";
import { ProjectFileFlow } from "../projectFiles/projectFileFlow.ts";
import { browserSaveRoute, canOverwrite, canPickOpen, pickProject, verifyBrowserImage } from "../projectFiles/browserProjectFiles.ts";
import { REVIEW_VCR_LIMITS } from "../../core/persistence/vcrArchive.ts";
import { DEFAULT_BACKGROUND, DEFAULT_PREVIEW } from "../../core/materials/materialEvaluation.ts";
import { TimelineDialog } from "../timeline/timelineControls.tsx";
import type { TimelineActions } from "../timeline/TimelineReview.tsx";
import { EditorContext, type EditorContextValue } from "./EditorContext.tsx";
import { newEditorProject, type ProjectTemplate } from "./projectFactory.ts";
import { EMPTY_SELECTION, firstLayerSelection, pruneSelection, type LayerSelection } from "./selection.ts";
import { DEFAULT_LAYOUT, parseLayout, PANEL_IDS } from "./preferences.ts";
import { ACTION_LABELS, parseShortcuts, shortcutKey, type ShortcutAction } from "./shortcuts.ts";
import { listRecoveryReport, readRecovery, type RecoveryEntry } from "./recovery.ts";
import { AutosaveController, type AutosaveState } from "./autosave.ts";
import { persistenceErrorMessage } from "./persistenceErrors.ts";
import { HierarchyPanel } from "./HierarchyPanel.tsx";
import { PropertiesPanel } from "./PropertiesPanel.tsx";
import type { PreviewActions } from "./PreviewPanel.tsx";
import { Workspace, PANEL_LABELS } from "./Workspace.tsx";
import { SettingsScreen } from "./SettingsScreen.tsx";
import { BackgroundControls } from "./BackgroundControls.tsx";
import { EditorTooltips } from "./EditorTooltips.tsx";
import { groupLayerCommand, ungroupLayerCommand } from "./grouping.ts";
import { layerValuesAt } from "../../core/document/animation.ts";
import { propertyCommand } from "./propertyEditing.ts";
import { AssetsScreen, ExportScreen, HelpScreen, PresetsScreen } from "./AuxiliaryScreens.tsx";
import { importProjectImage } from "../projectFiles/projectImages.ts";
import "./editor.css";

const TimelineReview = lazy(() => import("../timeline/TimelineReview.tsx").then((module) => ({ default: module.TimelineReview }))); // ホームでは時間編集UIを構築しない
const PreviewPanel = lazy(() => import("./PreviewPanel.tsx").then((module) => ({ default: module.PreviewPanel }))); // GPU依存をホーム起動から外す
const TemplatePreview = lazy(() => import("./TemplatePreview.tsx").then((module) => ({ default: module.TemplatePreview }))); // 新規フォームだけの見本

type Screen = "home" | "new" | "editor" | "presets" | "assets" | "export" | "settings" | "help";
type Prompt = { title: string; choices: readonly string[]; resolve: (answer: number) => void };
const NAVIGATION: readonly [Screen, string][] = [["home", "ホーム"], ["new", "新規作成"], ["editor", "エディタ"], ["presets", "プリセットLibrary"], ["assets", "素材管理"], ["export", "エクスポート"], ["settings", "設定"], ["help", "ヘルプ"]];

////////////////////
// 共通設定の破損・アクセス拒否は初期値で起動する。書込失敗は操作時に通知する。
function stored(key: string): unknown {
    try { return JSON.parse(localStorage.getItem(key) ?? "null") as unknown; } catch { return null; }
}

////////////////////
// 正式UIの画面遷移と一つの編集セッションだけを所有し、処理は既存の公開APIへ渡す。
export function EditorApp() {
    const [flow, setFlow] = useState(() => new ProjectFileFlow(newEditorProject("2d", "empty", "新しいエフェクト"), REVIEW_VCR_LIMITS, verifyBrowserImage, "0.0.0")); // 単一プロジェクト
    const [hasProject, setHasProject] = useState(false), [screen, setScreen] = useState<Screen>("home"); // 初期画面は未作成
    const [selection, setSelection] = useState<LayerSelection>(EMPTY_SELECTION); // 選択は保存しない
    const [layout, setLayout] = useState(() => parseLayout(stored("vfxcraft.editor.layout"))); // 利用者共通の配置
    const [shortcuts, setShortcuts] = useState(() => parseShortcuts(stored("vfxcraft.editor.shortcuts"))); // 現在割当の正本
    const [autoKey, setAutoKey] = useState(false), [space, setSpace] = useState<"world" | "parent">("world"); // 操作状態
    const [snap, setSnap] = useState(false), [intervals, setIntervals] = useState(() => {
        const result = { "2d": 16, "3d": 0.5 }, input = stored("vfxcraft.editor.positionSnap"); // T09と共通の保存先
        if (input && typeof input === "object") for (const mode of ["2d", "3d"] as const) {
            const value = (input as Record<string, unknown>)[mode]; // 非有限値と極小値を拒否
            if (typeof value === "number" && Number.isFinite(value) && value >= 1e-6 && value <= 1e9) result[mode] = value;
        }
        return result;
    }); // 2Dと3Dを区別
    const [tool, setTool] = useState<EditorContextValue["tool"]>("select"), [light, setLight] = useState(false); // 描画品質はプロジェクトに含めない
    const [download, setDownload] = useState(!canOverwrite), [busy, setBusy] = useState(false); // ファイル操作の排他
    const [message, setMessage] = useState(""), [prompt, setPrompt] = useState<Prompt | null>(null); // 失敗理由と安全な確認
    const [mode, setMode] = useState<Mode>("2d"), [template, setTemplate] = useState<ProjectTemplate>("basic"), [name, setName] = useState("新しいエフェクト"); // 新規作成フォーム
    const [candidates, setCandidates] = useState<RecoveryEntry[]>([]); // 選択するまで展開しない復元候補
    const [autosaveState, setAutosaveState] = useState<AutosaveState>("waiting"); // 明示保存と区別する状態
    const autosave = useRef<AutosaveController | null>(null), fileBusy = useRef(false); // 同一イベント内の二重操作も排他
    const [tick, setTick] = useState(0); // 文書編集時だけReactへ通知
    const time = useRef(0), previewActions = useRef<PreviewActions | null>(null), timelineActions = useRef<TimelineActions | null>(null); // 共通の再生位置と操作窓口
    const clock = useRef<PlaybackClock>({ time: 0, anchor: 0, wall: 0, playing: false, speed: 1, loop: true }); // パネルを隠しても破棄しない時計
    const fileInput = useRef<HTMLInputElement>(null), live = useRef(flow), promptRef = useRef<Prompt | null>(null); // 非同期処理の対象確認
    live.current = flow;
    const project = flow.history.preview; // 確定前の有効な候補も正式UIへ表示
    const refresh = useCallback(() => setTick((value) => value + 1), []); // 毎フレームのReact更新には使わない
    const report = useCallback((error: unknown) => setMessage(String(error)), []); // 例外を成功扱いにしない
    const confirm = useCallback((title: string, choices: readonly string[]) => new Promise<number>((resolve) => {
        if (promptRef.current) { resolve(-1); return; }
        const next = { title, choices, resolve }; // 二重ダイアログを拒否する
        promptRef.current = next; setPrompt(next);
    }), []);

    ////////////////////
    // 確認結果は一度だけ返し、Escape・初期フォーカスは取消を選ぶ。
    function answer(choice: number) { const active = promptRef.current; promptRef.current = null; setPrompt(null); active?.resolve(choice); }
    ////////////////////
    // コマンド失敗で履歴や保存状態を変更しない。
    function execute(command: EditCommand): boolean {
        try { const changed = flow.history.execute(command); flow.collectImages(); setMessage(""); refresh(); return changed; }
        catch (error) { report(error); return false; }
    }
    ////////////////////
    // 上書きとダウンロードを明示的に区別し、後者は利用者確認を待つ。
    function saveRoute() {
        return browserSaveRoute(flow.history.snapshot.project.name + ".vcr", download,
            async () => await confirm("ファイルのダウンロード保存が完了しましたか。利用者確認であり、アプリによる完全性検証ではありません。", ["保存完了を確認"]) === 0);
    }
    ////////////////////
    // 保存中に加わった編集はスナップショット識別子で未保存のまま残す。
    async function save(saveAs = false): Promise<boolean> {
        if (flow.history.isContinuousEditing) { report("編集中の入力を確定または取消してから保存してください。"); return false; }
        try { const result = await flow.save(saveRoute(), saveAs); setMessage(result ? "保存処理が完了しました。" : "保存確認を取り消しました。"); refresh(); return result; }
        catch (error) { report(persistenceErrorMessage(error)); return false; }
    }
    ////////////////////
    // 新規作成・復元による破棄の直前に、保存・破棄・取消を提示する。
    async function mayReplace(): Promise<boolean> {
        if (flow.history.isContinuousEditing) { report("編集中の入力を確定または取消してから切り替えてください。"); return false; }
        const initial = flow.history.snapshot; // 自動保存待機中の追加編集も破棄しない
        if (hasProject) await autosave.current?.flush().catch((error: unknown) => report(persistenceErrorMessage(error)));
        if (initial !== flow.history.snapshot) { report("自動保存中に編集が追加されたため、切替を中止しました。"); return false; }
        if (!hasProject || flow.history.isSaved) return true;
        const before = flow.history.snapshot, choice = await confirm("現在のプロジェクトに未保存変更があります。", ["保存して続行", "保存せず続行"]); // -1は取消
        if (choice === -1) return false;
        if (choice === 0 && !await save()) return false;
        if (flow !== live.current || flow.history.snapshot !== before) { report("確認中に編集が追加されたため、切替を中止しました。"); return false; }
        return true;
    }
    ////////////////////
    // 新しい文書へ成功時のみ切替え、選択・時間・履歴・描画資源を初期化する。
    function replace(next: ProjectFileFlow) {
        clock.current = { time: 0, anchor: 0, wall: 0, playing: false, speed: 1, loop: true };
        setFlow(next); setHasProject(true); setSelection(firstLayerSelection(next.history.preview.layers.map((item) => item.id))); time.current = 0; setAutoKey(false); setScreen("editor"); refresh();
    }
    ////////////////////
    // 排他中でも編集は可能だが、別のファイル操作を重ねない。
    async function run(operation: () => Promise<void>) {
        if (fileBusy.current) return;
        fileBusy.current = true;
        setBusy(true); try { await operation(); } catch (error) { if (!(error instanceof DOMException && error.name === "AbortError")) report(persistenceErrorMessage(error)); }
        finally { fileBusy.current = false; setBusy(false); refresh(); }
    }
    ////////////////////
    // T04の検証付き読込が失敗した場合、文書・素材・履歴を保持する。
    async function open(file: File, target?: Awaited<ReturnType<typeof pickProject>>["target"]) {
        if (flow.history.isContinuousEditing) { report("編集中の入力を確定または取消してから開いてください。"); return; }
        const before = flow.history.snapshot; // 読込前の自動保存中も文書を保護
        if (hasProject) await autosave.current?.flush().catch((error: unknown) => report(persistenceErrorMessage(error)));
        if (before !== flow.history.snapshot) { report("自動保存中に編集が追加されたため、切替を中止しました。"); return; }
        const decision = !hasProject || flow.history.isSaved ? 1 : await confirm("開く前に未保存変更をどうしますか。", ["保存して開く", "保存せず開く"]);
        if (decision < 0) return;
        if (before !== flow.history.snapshot) { report("確認中に編集が追加されたため、切替を中止しました。"); return; }
        const result = await flow.open(file, target, decision === 0 ? "save" : "discard", saveRoute()); // 途中編集もT04が検出
        if (result === "opened") { clock.current = { time: 0, anchor: 0, wall: 0, playing: false, speed: 1, loop: true }; setHasProject(true); time.current = 0; setSelection(firstLayerSelection(flow.history.preview.layers.map((item) => item.id))); setAutoKey(false); setScreen("editor"); }
        else setMessage("切替を取り消しました。確認中の追加編集は保持されています。");
    }
    ////////////////////
    // ファイルピッカーはユーザー操作から直接開始し、非対応時だけ入力要素を使う。
    function openPicker() { if (canPickOpen) void run(async () => { const chosen = await pickProject(); await open(chosen.file, chosen.target); }); else fileInput.current?.click(); }
    ////////////////////
    // 素材は検証済みメタデータとBlobを分けて登録し、未使用の画像も保存対象へ含める。
    async function importImage(file: File) {
        await importProjectImage(flow, file, verifyBrowserImage);
        refresh();
    }

    useEffect(() => {
        try { localStorage.setItem("vfxcraft.editor.layout", JSON.stringify(layout)); localStorage.setItem("vfxcraft.editor.shortcuts", JSON.stringify(shortcuts)); localStorage.setItem("vfxcraft.editor.positionSnap", JSON.stringify(intervals)); }
        catch (error) { report("共通設定を保存できませんでした: " + String(error)); }
    }, [layout, shortcuts, intervals, report]);
    useEffect(() => { setSelection((current) => pruneSelection(current, project.layers.map((item) => item.id))); }, [project]);
    useEffect(() => {
        let handle = 0; // 再生位置だけを更新しReactへは通知しない
        const update = (now: number) => {
            const state = clock.current, duration = flow.history.preview.durationUs; // 尺の編集にも追従
            if (!state.playing) state.time = Math.min(time.current, duration);
            advancePlaybackClock(state, now, duration); time.current = state.time;
            handle = requestAnimationFrame(update);
        };
        handle = requestAnimationFrame(update); return () => cancelAnimationFrame(handle);
    }, [flow, project.id]);
    useEffect(() => { if (screen !== "editor") clock.current.playing = false; }, [screen]);
    useEffect(() => {
        const leave = (event: BeforeUnloadEvent) => {
            if (hasProject && (!flow.history.isSaved || flow.history.preview !== flow.history.snapshot.project)) {
                event.preventDefault(); event.returnValue = ""; // 確定前の有効な編集も保護する
            }
        }; // 標準文言に従う
        window.addEventListener("beforeunload", leave); return () => window.removeEventListener("beforeunload", leave);
    }, [flow, hasProject]);
    ////////////////////
    // 候補の破損を個別に通知する。保留は削除操作にしない。
    async function refreshCandidates() {
        const result = await listRecoveryReport(); // アーカイブ全件の展開は避ける
        setCandidates(result.entries);
        if (result.invalidCount) report(`${result.invalidCount}件の復元候補情報が破損しています。正常な候補は利用できます。`);
    }
    useEffect(() => { let cancelled = false; void listRecoveryReport().then((result) => {
        if (!cancelled) { setCandidates(result.entries); if (result.invalidCount) report(`${result.invalidCount}件の復元候補情報が破損しています。正常な候補は利用できます。`); }
    }).catch((error: unknown) => { if (!cancelled) report(persistenceErrorMessage(error)); }); return () => { cancelled = true; }; }, [report]);
    useEffect(() => {
        const controller = new AutosaveController(flow, verifyBrowserImage, { onState: (state, error) => {
            setAutosaveState(state); if (error) report(persistenceErrorMessage(error));
        } }); // 効果ごとに生成しStrictModeの再マウントにも対応
        autosave.current = controller;
        return () => { controller.dispose(); if (autosave.current === controller) autosave.current = null; };
    }, [flow, report]);
    useEffect(() => { if (hasProject) autosave.current?.observe(); }, [flow, tick, hasProject]);

    ////////////////////
    // メニューとショートカットが同じ操作を呼ぶ。複数選択でも対象はアクティブ層一つ。
    function action(id: ShortcutAction) {
        const active = flow.history.preview.layers.find((item) => item.id === selection.active); // 削除済みの選択を使わない
        if (id === "new") { setScreen("new"); return; }
        if (id === "open") { openPicker(); return; }
        if (id === "save" || id === "saveAs") { if (hasProject) void run(async () => { await save(id === "saveAs"); }); return; }
        if (id === "hierarchy" || id === "properties" || id === "timeline") { setLayout({ ...layout, [id]: { ...layout[id], visible: !layout[id].visible } }); return; }
        if (id === "undo" || id === "redo") { flow.history[id](); refresh(); return; }
        if (id === "select" || id === "move" || id === "rotate" || id === "scale") { setTool(id); return; }
        if (id === "space") { setSpace(space === "world" ? "parent" : "world"); return; }
        if (id === "snap") { setSnap(!snap); return; }
        if (id === "reset" || id === "frame") { previewActions.current?.[id](); return; }
        if (id === "play") {
            if (timelineActions.current) timelineActions.current.toggle();
            else { advancePlaybackClock(clock.current, performance.now(), project.durationUs); clock.current.anchor = clock.current.time; clock.current.wall = performance.now(); clock.current.playing = !clock.current.playing; }
            return;
        }
        if (id === "previous" || id === "next") {
            if (timelineActions.current) timelineActions.current.step(id === "next" ? 1 : -1);
            else { clock.current.playing = false; time.current = Math.min(project.durationUs, frameToTimeUs(Math.max(0, timeUsToFrame(time.current, project.productionFps) + (id === "next" ? 1 : -1)), project.productionFps)); }
            return;
        }
        if (id === "key") {
            if (timelineActions.current) timelineActions.current.addKey();
            else if (active) execute(propertyCommand(project, active, "position", layerValuesAt(project, active, time.current).position, time.current, true));
            return;
        }
        if (!active) return;
        if (id === "duplicate") { execute({ kind: "hierarchy.duplicate", layerId: active.id }); return; }
        if (id === "delete") { void confirm("選択した親と子孫を削除しますか。", ["親と子孫を削除"]).then((answer) => { if (answer === 0) execute({ kind: "layer.remove", layerId: active.id, descendants: true }); }); return; }
        if (id === "rename") { setLayout({ ...layout, properties: { ...layout.properties, visible: true } }); requestAnimationFrame(() => document.getElementById("editor-layer-name")?.focus()); return; }
        if (id === "group") {
            const grouped = groupLayerCommand(project, active.id, time.current); // 発生終了をグループへコピーしない
            if (execute(grouped.command)) setSelection({ ids: [grouped.groupId], active: grouped.groupId, anchor: grouped.groupId });
        }
        if (id === "ungroup" && active.content.kind === "group") execute(ungroupLayerCommand(project, active.id, time.current));
    }
    const tip = (id: ShortcutAction, description: string) => ACTION_LABELS[id] + "：" + description + (shortcuts[id].length ? "（" + shortcuts[id].join(" / ") + "）" : "（未割当）"); // 表示は現在の割当
    const context: EditorContextValue = { flow, time, selection, setSelection, refresh, execute, report, autoKey, space, snap, interval: intervals[project.mode], tool, light, shortcuts, tip, confirm };
    const active = project.layers.find((item) => item.id === selection.active); // 名前変更の対象

    return <EditorContext value={context}><div className={"vfx-app " + (screen === "editor" ? "is-editor" : "")} tabIndex={-1} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229 || prompt || busy || screen === "settings") return;
        const target = event.target as HTMLElement; // 入力中はブラウザ標準の編集を保護
        if (target.closest("input,textarea,select,[contenteditable=true],dialog")) return;
        const key = shortcutKey(event.nativeEvent), id = key && (Object.keys(shortcuts) as ShortcutAction[]).find((item) => shortcuts[item].includes(key));
        if (!id || (screen !== "editor" && !["new", "open", "save", "saveAs"].includes(id))) return;
        event.preventDefault(); action(id);
    }}>
        <header className="app-topbar"><a className="brand" href="#home" onClick={(event) => { event.preventDefault(); setScreen("home"); }}>✦ VFXCraft</a>
            <strong>{screen === "editor" ? project.mode.toUpperCase() + "エディタ" : "2D / 3D エフェクト制作ツール"}</strong>
            {screen === "editor" && <><details className="app-menu"><summary>ファイル</summary>{(["new", "open", "save", "saveAs"] as ShortcutAction[]).map((id) => <button key={id} title={tip(id, "プロジェクトのファイル操作")} disabled={busy} onClick={() => action(id)}>{ACTION_LABELS[id]}</button>)}</details>
                <details className="app-menu"><summary>編集</summary>{(["undo", "redo", "duplicate", "group", "ungroup", "delete", "rename"] as ShortcutAction[]).map((id) => <button key={id} title={tip(id, "アクティブレイヤーを操作")} onClick={() => action(id)}>{ACTION_LABELS[id]}</button>)}</details>
                <details className="app-menu"><summary>表示</summary>{PANEL_IDS.map((id) => <button key={id} onClick={() => setLayout({ ...layout, [id]: { ...layout[id], visible: !layout[id].visible } })}>{layout[id].visible ? "✓ " : ""}{PANEL_LABELS[id]}</button>)}<button onClick={() => setLayout(structuredClone(DEFAULT_LAYOUT))}>初期配置に戻す</button></details></>}
            <span className="top-spacer" /><button title={tip("undo", "直前の編集を取り消す")} disabled={!flow.history.canUndo} onClick={() => action("undo")}>↶ Undo</button>
            <button title={tip("redo", "取り消した編集をやり直す")} disabled={!flow.history.canRedo} onClick={() => action("redo")}>↷ Redo</button>
            <button className="primary" title={tip("save", "現在のプロジェクトを保存")} disabled={busy || !hasProject} onClick={() => action("save")}>保存</button>
            {hasProject && <div className="editor-actions" aria-live="polite"><span data-testid="autosave-state">{busy ? "ファイル処理中… ／ " : ""}{({ waiting: "自動保存待機中", saving: "自動保存中…", saved: "ブラウザ内に自動保存済み", failed: "自動保存失敗" })[autosaveState]}</span>
                {autosaveState === "failed" && <button onClick={() => void autosave.current?.flush().catch(() => {})}>自動保存を再試行</button>}</div>}
        </header>
        <input hidden ref={fileInput} aria-label="プロジェクトファイル" type="file" accept=".vcr" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void run(() => open(file)); }} />
        {screen !== "editor" && <nav className="app-sidebar" aria-label="メインナビゲーション">{NAVIGATION.map(([id, label]) => <button key={id} className={screen === id ? "active" : ""} disabled={id === "editor" && !hasProject} onClick={() => setScreen(id)}>{label}</button>)}</nav>}
        {message && <div role="status" className="app-notice">{message}<button onClick={() => setMessage("")}>閉じる</button></div>}
        {screen === "editor" ? <><div className="editor-toolbar"><button onClick={() => setScreen("home")}>⌂ ホーム</button><span>{project.name}{flow.history.isSaved ? "" : " *"}</span>
            {(["select", "move", "rotate", "scale"] as const).map((id) => <button key={id} className={tool === id ? "active" : ""} title={tip(id, "Transformギズモの操作モード")} onClick={() => setTool(id)}>{ACTION_LABELS[id]}</button>)}
            <button title={tip("space", "編集座標軸。粒子のSimulation Spaceとは別です")} onClick={() => action("space")}>{space === "world" ? "World" : "Parent Local"}</button>
            <label title={tip("snap", "位置を指定間隔に揃えます。2Dと3Dの間隔は別です")}><input type="checkbox" checked={snap} onChange={(event) => setSnap(event.target.checked)} />位置スナップ</label>
            <label>間隔<input aria-label="位置スナップ間隔" type="number" min={0.000001} max={1e9} step="any" value={intervals[project.mode]} onChange={(event) => { const value = event.target.valueAsNumber; if (Number.isFinite(value) && value >= 1e-6 && value <= 1e9) setIntervals({ ...intervals, [project.mode]: value }); }} /></label>
            <button onClick={() => action("reset")} title={tip("reset", "固定の初期視点へ戻す")}>視点リセット</button><button onClick={() => action("frame")} title={tip("frame", "現在時刻のエフェクトを画面内へ収める")}>全体表示</button>
            <label title="ONではアニメーション対応項目を現在時刻のキーへ登録。OFFでは基本値を変更。"><input type="checkbox" checked={autoKey} onChange={(event) => setAutoKey(event.target.checked)} />Auto Key</label>
            <label><input type="checkbox" checked={light} onChange={(event) => setLight(event.target.checked)} />軽量プレビュー</label>
            <button onClick={() => setScreen("settings")}>設定</button>
        </div>
        <Suspense fallback={<p>編集パネルを読み込み中…</p>}><Workspace layout={layout} onChange={setLayout} panels={{ hierarchy: <HierarchyPanel />, properties: <>
            {active && <label>名前<input id="editor-layer-name" key={active.id + active.name} defaultValue={active.name} onBlur={(event) => { if (event.target.value !== active.name) execute({ kind: "layer.update", layerId: active.id, patch: { name: event.target.value } }); }} /></label>}
            <PropertiesPanel key={active?.id ?? "none"} /><BackgroundControls /></>, preview: <><PreviewPanel key={flow.history.snapshot.project.id} actions={previewActions} />
                <div className="editor-actions"><button onClick={() => action("play")} title={tip("play", "現在位置から再生・一時停止")}>▶ 再生／一時停止</button><button onClick={() => { clock.current.playing = false; time.current = 0; timelineActions.current?.stop(); }}>■ 停止</button>
                    <button onClick={() => setScreen("assets")}>素材</button><button onClick={() => setScreen("presets")}>プリセット</button></div></>,
            timeline: <TimelineReview key={project.id} session={flow} embedded panelOnly sharedTime={time} sharedClock={clock} controller={timelineActions} activeLayer={selection.active} onChange={refresh}
                onSelectLayer={(id) => setSelection((current) => ({ ids: current.ids.includes(id) ? current.ids : [id], active: id, anchor: id }))}
                shortcutTips={{ play: tip("play", "再生／一時停止。停止位置から再開します"), previous: tip("previous", "制作FPSの一フレーム前へ移動"), next: tip("next", "制作FPSの一フレーム先へ移動") }} /> }} /></Suspense>
        </> : <main className="app-screen">
            {screen === "home" && <><section className="home-hero"><h1>✦ VFXCraft</h1><h2>2D / 3D ゲームエフェクト制作ツール</h2><p>ゲームで使えるエフェクトを、作って、編集して、保存。</p></section>
                <div className="home-cards"><button className="primary" onClick={() => setScreen("new")}>＋ 新規プロジェクトを作成</button><button disabled={busy} onClick={openPicker}>プロジェクトを開く（.vcr）</button>
                    {(["2d", "3d"] as const).map((item) => <button className="mode-card" key={item} onClick={() => { setMode(item); setScreen("new"); }}><strong>{item.toUpperCase()}エフェクト</strong><p>{item === "2d" ? "スプライト・パーティクルで制作" : "立体的な粒子とビルボードで制作"}</p></button>)}</div>
                {hasProject && <section><h2>編集中のプロジェクト</h2><button onClick={() => setScreen("editor")}>{project.name} — {flow.history.isSaved ? "保存済み" : "未保存"}</button><p>同じ文書を保持してエディタへ戻ります。</p></section>}
                <section><h2>作業の復元候補</h2><button disabled={busy} onClick={() => void run(refreshCandidates)}>復元候補を更新</button>{candidates.length === 0 ? <p>復元候補はありません。</p> : candidates.map((entry) => <div key={entry.id}><span>{entry.name} — {entry.mode?.toUpperCase() ?? "旧候補"} — {new Date(entry.savedAt).toLocaleString("ja-JP")} {entry.sessionId ? `／タブ ${entry.sessionId.slice(0, 8)}／世代 ${entry.sequence}` : ""}</span>
                    <button disabled={busy} onClick={() => void run(async () => {
                        const data = await readRecovery(entry, verifyBrowserImage); // 破損検証を破棄確認より先に行う
                        if (!await mayReplace()) return;
                        const next = new ProjectFileFlow(data.project, REVIEW_VCR_LIMITS, verifyBrowserImage, "0.0.0"); // 復元は明示保存済みとみなさない
                        for (const [id, image] of data.images) next.rememberImage(id, image);
                        replace(next);
                    })}>作業を復元</button></div>)}<button onClick={() => setCandidates([])}>復元を保留</button><p>復元は.vcrファイルを上書きせず、明示保存するまで未保存です。自動保存はブラウザ・プロファイル・オリジンごとに保存され、データ消去で失われます。恒久バックアップには.vcrへ保存してください。候補は自動削除しません。日時は端末の時計によるため、タブと世代も確認してください。</p></section>
            </>}
            {screen === "new" && <><h1>新規プロジェクト作成</h1><div className="screen-columns"><section>
                <label>プロジェクト名<input aria-label="プロジェクト名" value={name} onChange={(event) => setName(event.target.value)} /></label>
                <fieldset><legend>1 プロジェクトの種類</legend>{(["2d", "3d"] as const).map((item) => <button key={item} aria-pressed={mode === item} className={mode === item ? "active mode-card" : "mode-card"} onClick={() => setMode(item)}>{item.toUpperCase()}エフェクト</button>)}</fieldset>
                <fieldset><legend>2 作成方法</legend>{([ ["empty", "空のプロジェクト"], ["basic", "基本パーティクル入り"], ["sample", "サンプルプロジェクト"] ] as const).map(([id, label]) => <label key={id}><input type="radio" name="template" value={id} checked={template === id} onChange={() => setTemplate(id)} />{label}</label>)}</fieldset>
                <p>初期長さ4秒／制作60FPS。編集後にタイムラインで変更できます。2Dキャンバス640×360。</p>
                <button className="primary" disabled={busy || !name.trim()} onClick={() => void run(async () => { const next = newEditorProject(mode, template, name); if (await mayReplace()) replace(new ProjectFileFlow(next, REVIEW_VCR_LIMITS, verifyBrowserImage, "0.0.0")); })}>作成する</button>
                <button onClick={() => setScreen(hasProject ? "editor" : "home")}>キャンセル</button>
            </section><aside><Suspense fallback={<p>見本を読み込み中…</p>}><TemplatePreview mode={mode} template={template} /></Suspense><h2>プロジェクトの設定内容</h2><p>{name}</p><p>{mode.toUpperCase()}／{template}</p><p>モード変換・2D/3D混在は行いません。</p></aside></div></>}
            {screen === "settings" && <SettingsScreen shortcuts={shortcuts} layout={layout} setShortcuts={setShortcuts} setLayout={setLayout} confirm={confirm} report={report} />}
            {screen === "assets" && <AssetsScreen flow={flow} disabled={!hasProject || busy} onImport={(file) => void run(() => importImage(file))} />}
            {screen === "presets" && <PresetsScreen create={() => setScreen("new")} />}
            {screen === "export" && <ExportScreen />}
            {screen === "help" && <HelpScreen settings={() => setScreen("settings")} />}
        </main>}
        {screen === "editor" && <footer className="editor-footer"><label><input type="checkbox" checked={download} disabled={!canOverwrite || busy} onChange={(event) => setDownload(event.target.checked)} />ダウンロード方式</label>
            <label><input type="checkbox" checked={(project.preview?.background.grid ?? DEFAULT_BACKGROUND.grid)} onChange={(event) => execute({ kind: "project.preview", preview: { ...(project.preview ?? DEFAULT_PREVIEW), background: { ...project.preview?.background, grid: event.target.checked } } })} />グリッド</label>
            <button onClick={() => execute({ kind: "project.preview", preview: { ...(project.preview ?? DEFAULT_PREVIEW), background: { ...project.preview?.background, checker: !(project.preview?.background.checker ?? false) } } })}>チェッカー切替</button>
            {project.mode === "2d" && <><button onClick={() => execute({ kind: "drawing.update", drawing: project.drawing === "normal" ? "pixel" : "normal", pixelScale: project.pixelScale })}>{project.drawing === "pixel" ? "ピクセル表示" : "通常2D"}</button><select aria-label="ピクセル倍率" value={project.pixelScale} onChange={(event) => execute({ kind: "drawing.update", drawing: project.drawing, pixelScale: Number(event.target.value) })}>{[2, 4, 8].map((scale) => <option key={scale} value={scale}>{scale}倍</option>)}</select>
                <button onClick={() => execute({ kind: "project.preview", preview: { ...(project.preview ?? DEFAULT_PREVIEW), pixelBloom: project.preview?.pixelBloom === "smooth" ? "pixel" : "smooth" } })}>{project.preview?.pixelBloom === "smooth" ? "Smooth Bloom" : "Pixel Bloom"}</button></>}
            <span>共通配置・ショートカットは.vcrに含まれません</span></footer>}
        {prompt && <TimelineDialog label={prompt.title} onCancel={() => answer(-1)}>{prompt.choices.map((choice, index) => <button key={choice} onClick={() => answer(index)}>{choice}</button>)}</TimelineDialog>}
        <EditorTooltips />
    </div></EditorContext>;
}
