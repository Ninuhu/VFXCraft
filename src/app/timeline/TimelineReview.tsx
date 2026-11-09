import { useEffect, useRef, useState, type PointerEvent } from "react";
import { baseTrackValue, tracksFor } from "../../core/document/animation.ts";
import { evaluateTrack } from "../../core/document/evaluateTrack.ts";
import type { Keyframe, Mode, Project, TrackProperty } from "../../core/document/model.ts";
import { parseTimelineTime, playbackPosition, PLAYBACK_SPEEDS, snapTimeUs, timeUsToFrame, type PlaybackSpeed } from "../../core/document/playback.ts";
import { frameToTimeUs, MICROS_PER_SECOND } from "../../core/document/time.ts";
import type { EditCommand } from "../../core/editing/command.ts";
import { DEFAULT_BACKGROUND } from "../../core/materials/materialEvaluation.ts";
import { REVIEW_VCR_LIMITS } from "../../core/persistence/vcrArchive.ts";
import { MaterialPreview } from "../../rendering/MaterialPreview.ts";
import { createParticleExample } from "../particles/ParticleReview.tsx";
import { create3DExample } from "../particles3d/Particle3DReview.tsx";
import { verifyBrowserImage } from "../projectFiles/browserProjectFiles.ts";
import { ProjectFileFlow } from "../projectFiles/projectFileFlow.ts";
import { VcrReview } from "../projectFiles/VcrReview.tsx";
import { KeyValueFields, TimelineDialog, TimelineNumber, TRACK_LABELS } from "./timelineControls.tsx";
import "./timeline.css";

type Unit = "seconds" | "frames";
type Selection = { layerId: string; property: TrackProperty; offsetUs: number };
type Drag = { kind: "key"; selection: Selection } | { kind: "start" | "end"; layerId: string };
type Pending = { project: Project; kind: "move"; command: Extract<EditCommand, { kind: "key.update" }> }
    | { project: Project; kind: "duration"; durationUs: number };

////////////////////
// 時刻表示は整数µsから毎回作り、単位変更で文書を書き換えない
function displayTime(time: number, unit: Unit, fps: number): number {
    return unit === "seconds" ? time / MICROS_PER_SECOND : timeUsToFrame(time, fps);
}

////////////////////
// ファイル操作と同じ編集セッションを使う2D・3Dの検証画面
export function TimelineReview() {
    const [mode, setMode] = useState<Mode>("2d"); // サンプルの編集モード
    const [sessions] = useState(() => ({
        "2d": new ProjectFileFlow(createParticleExample(), REVIEW_VCR_LIMITS, verifyBrowserImage, "0.0.0"),
        "3d": new ProjectFileFlow(create3DExample(), REVIEW_VCR_LIMITS, verifyBrowserImage, "0.0.0"),
    }));
    const flow = sessions[mode]; // ファイル操作とタイムラインが共有する履歴
    const project = flow.history.snapshot.project; // 確定した文書
    const [unit, setUnit] = useState<Unit>("seconds");
    const [zoom, setZoom] = useState(1);
    const [snap, setSnap] = useState(true);
    const [loop, setLoop] = useState(true);
    const [speed, setSpeed] = useState<PlaybackSpeed>(1);
    const [layerId, selectLayer] = useState("");
    const [property, selectProperty] = useState<TrackProperty>("position");
    const [selection, selectKey] = useState<Selection>();
    const [pending, setPending] = useState<Pending>();
    const [message, setMessage] = useState("");
    const [, refresh] = useState(0); // 文書を編集したときだけReactを更新
    const clock = useRef({ time: 0, anchor: 0, wall: 0, playing: false, speed: 1 as PlaybackSpeed, loop: true }); // 再生時計
    const viewUnit = useRef(unit); // フレームループ用の表示単位
    viewUnit.current = unit;
    const canvas = useRef<HTMLCanvasElement>(null);
    const readout = useRef<HTMLOutputElement>(null);
    const status = useRef<HTMLParagraphElement>(null);
    const playhead = useRef<HTMLDivElement>(null);
    const scroll = useRef<HTMLDivElement>(null);
    const drag = useRef<{ target: Drag; pointer: number; startX: number; original: number; project: Project;
        marker: HTMLButtonElement; left: string } | undefined>(undefined); // 仮移動
    const layer = project.layers.find((item) => item.id === layerId) ?? project.layers[0]; // 選択が消えた場合の代替
    const emitterId = layer?.content.kind === "emitter" ? layer.content.emitterId : undefined;
    const emitter = project.emitters.find((item) => item.id.toLowerCase() === emitterId?.toLowerCase());
    const material = project.materials.find((item) => item.id.toLowerCase() === emitter?.materialId.toLowerCase());
    const track = layer && tracksFor(project, layer.id)?.get(property); // キー操作対象
    const key = track?.keys.find((item) => item.offsetUs === selection?.offsetUs && selection.layerId === layer?.id
        && selection.property === property);
    const choices = layer ? (Object.keys(TRACK_LABELS) as TrackProperty[]).filter((item) =>
        baseTrackValue(layer, emitter, material, item) !== undefined || tracksFor(project, layer.id)?.has(item)) : [];
    const outsideCount = project.tracks.reduce((count, item) => {
        const start = project.layers.find((entry) => entry.id.toLowerCase() === item.layerId.toLowerCase())!.startUs;
        return count + item.keys.filter((entry) => entry.offsetUs > project.durationUs - start).length;
    }, 0);

    ////////////////////
    // ドキュメント編集は検証済みの履歴へ送り、失敗時は表示値を保持する
    function execute(command: EditCommand): boolean {
        try { flow.history.execute(command); setMessage(""); refresh((value) => value + 1); return true; }
        catch (error) { setMessage(String(error)); return false; }
    }

    ////////////////////
    // 数値入力を現在の単位で解釈する
    function readTime(input: string, accept: (time: number) => void) {
        try { accept(parseTimelineTime(input, unit, project.productionFps)); }
        catch (error) { setMessage(String(error)); }
    }

    ////////////////////
    // 再生中の位置を壁時計アンカーから計算する
    function updateClock(now: number, duration: number) {
        const state = clock.current; // UIとは独立した時計
        if (!state.playing) return;
        const elapsed = Math.max(0, Math.round((now - state.wall) * 1000 * state.speed)); // 実時間を制作µsへ変換
        state.time = playbackPosition(Math.min(state.anchor, duration), elapsed, duration, state.loop);
        if (!state.loop && state.time === duration) state.playing = false;
    }

    ////////////////////
    // 手動シークはスナップと独立し、終端も表示できる
    function seek(time: number) {
        if (time > project.durationUs) { setMessage("制作尺の範囲内を指定してください。"); return; }
        clock.current.time = time;
        clock.current.playing = false;
    }

    ////////////////////
    // 速度やループを切り替える直前の位置を確定し、次の時計の起点にする
    function reanchor() {
        const now = performance.now(); // 同じ壁時計で位置と起点を揃える
        updateClock(now, project.durationUs);
        clock.current.anchor = clock.current.time;
        clock.current.wall = now;
    }

    ////////////////////
    // 選択中のキーを編集し、衝突時は確定済み文書を触らず確認を待つ
    function changeKey(target: Selection, next: Keyframe) {
        const source = tracksFor(project, target.layerId)?.get(target.property); // 対象のトラック
        const command = { kind: "key.update" as const, ...target, key: next };
        if (target.offsetUs !== next.offsetUs && source?.keys.some((item) => item.offsetUs === next.offsetUs)) {
            setPending({ kind: "move", command, project }); return;
        }
        if (execute(command)) selectKey({ ...target, offsetUs: next.offsetUs });
    }

    ////////////////////
    // ドラッグの移動量を制作時刻へ変換し、プレビューだけを更新する
    function dragTime(event: PointerEvent<HTMLButtonElement>): number {
        const active = drag.current!; // 取得済みのポインタ
        const lane = event.currentTarget.closest(".timeline-lane")!.getBoundingClientRect(); // 横スクロールを含む行の領域
        const target = project.layers.find((item) => item.id === (active.target.kind === "key" ? active.target.selection.layerId : active.target.layerId))!;
        const minimum = active.target.kind === "start" ? 0 : target.startUs;
        const maximum = active.target.kind === "start" ? Math.min(target.emissionEndUs ?? Infinity, project.durationUs - 1) : project.durationUs;
        const time = Math.max(minimum, Math.min(maximum, Math.round(active.original + (event.clientX - active.startX) / lane.width * project.durationUs)));
        return snap && minimum <= maximum ? snapTimeUs(time, project.productionFps, maximum, minimum) : time;
    }

    ////////////////////
    // 仮位置を元に戻し、確定・取消のどちらでもポインタ状態を解放する
    function clearDrag() {
        if (drag.current) drag.current.marker.style.left = drag.current.left;
        drag.current = undefined;
    }

    ////////////////////
    // マーカーの選択とドラッグをまとめる。移動しないクリックでは履歴を作らない
    function marker(target: Drag, time: number, label: string) {
        const selected = target.kind === "key" && selection?.layerId === target.selection.layerId
            && selection.property === target.selection.property && selection.offsetUs === target.selection.offsetUs;
        return <button type="button" className={"timeline-marker " + target.kind + (time > project.durationUs ? " outside" : "")
            + (selected ? " selected" : "")}
            aria-label={label} title={label} style={{ left: Math.min(100, time / project.durationUs * 100) + "%" }}
            onClick={(event) => {
                if (event.detail !== 0) return; // マウスはポインタダウンで選択済み
                if (target.kind === "key") {
                    selectLayer(target.selection.layerId); selectProperty(target.selection.property); selectKey(target.selection);
                } else selectLayer(target.layerId);
            }}
            onPointerDown={(event) => {
                if (event.button !== 0) return;
                if (target.kind === "key") {
                    selectLayer(target.selection.layerId); selectProperty(target.selection.property); selectKey(target.selection);
                } else selectLayer(target.layerId);
                const element = event.currentTarget; // 仮位置だけを更新する実際のマーカー
                drag.current = { target, pointer: event.pointerId, startX: event.clientX, original: time,
                    project, marker: element, left: element.style.left };
                event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
                if (drag.current?.pointer === event.pointerId) {
                    event.currentTarget.style.left = Math.abs(event.clientX - drag.current.startX) < 2
                        ? drag.current.left : Math.min(100, dragTime(event) / project.durationUs * 100) + "%";
                }
            }}
            onPointerCancel={clearDrag}
            onLostPointerCapture={() => { if (drag.current?.marker) clearDrag(); }}
            onPointerUp={(event) => {
                const active = drag.current; // 確定する仮移動
                if (!active || active.pointer !== event.pointerId) return;
                const destination = Math.abs(event.clientX - active.startX) < 2 ? time : dragTime(event);
                clearDrag();
                if (destination === time || active.project !== flow.history.snapshot.project) return;
                event.preventDefault();
                if (target.kind === "key") {
                    const start = project.layers.find((item) => item.id === target.selection.layerId)!.startUs;
                    const moving = tracksFor(project, target.selection.layerId)?.get(target.selection.property)?.keys.find((item) => item.offsetUs === target.selection.offsetUs);
                    if (moving) {
                        selectLayer(target.selection.layerId); selectProperty(target.selection.property);
                        changeKey(target.selection, { ...moving, offsetUs: destination - start });
                    }
                } else execute({ kind: "layer.update", layerId: target.layerId,
                    patch: target.kind === "start" ? { startUs: destination } : { emissionEndUs: destination } });
            }} />;
    }

    ////////////////////
    // フレーム評価と素材デコードを画面の寿命に合わせる。Reactは毎フレーム更新しない
    useEffect(() => {
        let renderer: MaterialPreview; // プレビューのGPU資源
        try { renderer = new MaterialPreview(canvas.current!); }
        catch (error) { setMessage(String(error)); return; }
        let handle = 0, disposed = false, lastTime = -1, imageVersion = 0, lastImageVersion = -1;
        let lastProject: Project | undefined; // 前回評価した文書
        const images = new Map<string, ImageBitmap>(); // 描画中の素材
        const blobs = new Map<string, Blob>(); // 同じ画像の再デコードを防ぐ
        let lastUnit: Unit | undefined; // 単位切替時に表示だけ更新する
        ////////////////////
        // 文書や時刻が変化した場合だけプレビューを描画する
        function render(now: number) {
            const current = flow.history.snapshot.project; // 最新の保存済み形式の文書
            updateClock(now, current.durationUs);
            const time = Math.min(clock.current.time, current.durationUs); // 短縮直後は終端に合わせる
            clock.current.time = time;
            if (lastProject !== current) {
                const active = new Set(current.assets.map((asset) => asset.id.toLowerCase())); // 現文書の素材
                for (const [id] of blobs) if (!active.has(id)) {
                    images.get(id)?.close(); images.delete(id); blobs.delete(id);
                }
                for (const id of active) {
                    const blob = flow.getImage(id); // ファイルフローが保持する本体
                    if (!blob || blob === blobs.get(id)) continue;
                    blobs.set(id, blob); images.get(id)?.close(); images.delete(id);
                    void createImageBitmap(blob, { premultiplyAlpha: "none" }).then((image) => {
                        if (disposed || blobs.get(id) !== blob) image.close(); else { images.set(id, image); imageVersion++; }
                    }).catch((error: unknown) => { if (!disposed) setMessage(String(error)); });
                }
            }
            const changed = time !== lastTime || current !== lastProject; // 表示とシミュレーションの更新条件
            if (changed || lastUnit !== viewUnit.current) {
                const fps = current.productionFps;
                let value = displayTime(time, viewUnit.current, fps); // 秒またはフレームの表示値
                if (viewUnit.current === "frames" && clock.current.playing && value > 0 && frameToTimeUs(value, fps) > time) value--;
                if (readout.current) readout.current.value = String(value) + (viewUnit.current === "seconds" ? " 秒" : " フレーム");
                if (playhead.current) playhead.current.style.left = (time / current.durationUs * 100) + "%";
                const viewport = scroll.current; // プレイヘッドが画面外へ出たときに追従
                if (clock.current.playing && viewport && playhead.current) {
                    const x = playhead.current.getBoundingClientRect().left - viewport.getBoundingClientRect().left;
                    if (x < 0 || x > viewport.clientWidth) viewport.scrollLeft += x - viewport.clientWidth / 3;
                }
            }
            if (changed || imageVersion !== lastImageVersion) {
                try {
                    const result = renderer.draw(current, time, { images, light: false, background: DEFAULT_BACKGROUND });
                    if (status.current) status.current.textContent = "粒子 " + result.count + " / GL " + renderer.glError;
                } catch (error) { clock.current.playing = false; setMessage(String(error)); }
            }
            lastTime = time; lastProject = current; lastUnit = viewUnit.current; lastImageVersion = imageVersion;
            handle = requestAnimationFrame(render);
        }
        handle = requestAnimationFrame(render);
        return () => {
            disposed = true; cancelAnimationFrame(handle); renderer.dispose();
            for (const bitmap of images.values()) bitmap.close();
        };
    }, [flow]);

    const divisions = 8 * zoom; // 拡大すると目盛りを細分化
    const marks = Array.from({ length: divisions + 1 }, (_, index) => Math.round(project.durationUs * (index / divisions)));
    return <div className="timeline-review" onKeyDown={(event) => {
        if (event.key === "Escape" && drag.current) clearDrag();
    }}>
        <h1>T08 タイムライン・キーフレーム・詳細再生</h1>
        <p><a href="?materials-review">T07 マテリアル検証</a></p>
        <label>サンプル<select aria-label="サンプル" value={mode} onChange={(event) => {
            seek(0); setMode(event.currentTarget.value as Mode); selectLayer(""); selectKey(undefined); selectProperty("position");
        }}><option value="2d">2D</option><option value="3d">3D</option></select></label>
        <canvas aria-label="タイムラインプレビュー" ref={canvas} />
        <p ref={status} aria-label="描画状態" />
        <fieldset className="timeline-toolbar"><legend>再生と時間表示</legend>
            <button onClick={() => { if (!clock.current.playing) { reanchor(); clock.current.playing = true; } }}>再生</button>
            <button onClick={() => { reanchor(); clock.current.playing = false; }}>一時停止</button>
            <button onClick={() => seek(0)}>停止</button>
            {[-1, 1].map((direction) => <button key={direction} onClick={() => {
                const frame = timeUsToFrame(clock.current.time, project.productionFps); // 現在位置に最も近い制作フレーム
                seek(Math.min(project.durationUs, frameToTimeUs(Math.max(0, frame + direction), project.productionFps)));
            }}>{direction < 0 ? "前のフレーム" : "次のフレーム"}</button>)}
            <label><input type="checkbox" checked={loop} onChange={(event) => {
                reanchor(); clock.current.loop = event.currentTarget.checked; setLoop(clock.current.loop);
            }} />ループ</label>
            <label>再生速度<select aria-label="再生速度" value={speed} onChange={(event) => {
                reanchor(); clock.current.speed = Number(event.currentTarget.value) as PlaybackSpeed; setSpeed(clock.current.speed);
            }}>{PLAYBACK_SPEEDS.map((value) => <option key={value} value={value}>{value}倍</option>)}</select></label>
            <label>表示単位<select aria-label="表示単位" value={unit} onChange={(event) => setUnit(event.currentTarget.value as Unit)}>
                <option value="seconds">秒</option><option value="frames">フレーム</option>
            </select></label>
            <output ref={readout} aria-label="現在時刻" aria-live="off" />
            <label>シーク時刻<input aria-label="シーク時刻" type="number" step="any" key={unit} defaultValue={0}
                onKeyDown={(event) => { if (event.key === "Enter") readTime(event.currentTarget.value, seek); }} /></label>
        </fieldset>
        <fieldset className="timeline-toolbar"><legend>タイムライン</legend>
            <TimelineNumber label="制作FPS" value={project.productionFps} onCommit={(input) =>
                execute({ kind: "timeline.fps", productionFps: Number(input) })} />
            <TimelineNumber label="制作尺" value={displayTime(project.durationUs, unit, project.productionFps)} onCommit={(input) =>
                readTime(input, (durationUs) => {
                    if (durationUs <= 0) { setMessage("制作尺は0より大きくしてください。"); return; }
                    const outside = project.tracks.some((item) => {
                        const target = project.layers.find((entry) => entry.id.toLowerCase() === item.layerId.toLowerCase())!;
                        return item.keys.some((entry) => entry.offsetUs > durationUs - target.startUs);
                    });
                    if (outside && durationUs < project.durationUs) setPending({ kind: "duration", durationUs, project });
                    else execute({ kind: "timeline.duration", durationUs });
                })} />
            <label><input type="checkbox" checked={snap} onChange={(event) => setSnap(event.currentTarget.checked)} />ドラッグをフレームにスナップ</label>
            <button disabled={zoom <= 1} onClick={() => setZoom(zoom / 2)}>時間軸を縮小</button>
            <button disabled={zoom >= 16} onClick={() => setZoom(zoom * 2)}>時間軸を拡大</button>
            <button onClick={() => { if (scroll.current && playhead.current) scroll.current.scrollLeft +=
                playhead.current.getBoundingClientRect().left - scroll.current.getBoundingClientRect().left - scroll.current.clientWidth / 2; }}>再生位置へスクロール</button>
        </fieldset>
        {outsideCount > 0 && <p role="note">制作尺の範囲外に {outsideCount} 個のキーがあります。編集欄から選択できます。</p>}
        <div className="timeline-scroll" ref={scroll} aria-label="時間軸スクロール">
            <div className="timeline-grid" style={{ width: (zoom * 100) + "%" }}>
                <div className="timeline-ruler" onPointerDown={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect(); // 表示の相対位置
                    seek(Math.max(0, Math.min(project.durationUs, Math.round((event.clientX - rect.left) / rect.width * project.durationUs))));
                }}>{marks.map((time, index) => <span key={index} style={{ left: time / project.durationUs * 100 + "%" }}>
                    {displayTime(time, unit, project.productionFps)}{unit === "seconds" ? "s" : "f"}
                </span>)}</div>
                {project.layers.map((item) => <div key={item.id}>
                    <div className="timeline-lane">
                        <span>{item.name}</span>
                        {marker({ kind: "start", layerId: item.id }, item.startUs, item.name + " 開始マーカー")}
                        {item.emissionEndUs !== undefined && marker({ kind: "end", layerId: item.id }, item.emissionEndUs, item.name + " 終了マーカー")}
                    </div>
                    {[...(tracksFor(project, item.id)?.values() ?? [])].map((row) => <div className="timeline-lane key-lane" key={row.property}>
                        <span>{TRACK_LABELS[row.property]}</span>
                        {row.keys.map((entry) => <span key={entry.offsetUs} className="timeline-marker-slot">
                            {marker({ kind: "key", selection: { layerId: item.id, property: row.property, offsetUs: entry.offsetUs } },
                                item.startUs + entry.offsetUs, item.name + " " + TRACK_LABELS[row.property] + " キー " + entry.offsetUs)}
                        </span>)}
                    </div>)}
                </div>)}
                <div className="timeline-playhead" ref={playhead} style={{ left: clock.current.time / project.durationUs * 100 + "%" }} />
            </div>
        </div>
        {layer && <fieldset className="timeline-toolbar"><legend>レイヤーとキーの編集</legend>
            <label>レイヤー<select aria-label="レイヤー" value={layer.id} onChange={(event) => {
                selectLayer(event.currentTarget.value); selectProperty("position"); selectKey(undefined);
            }}>{project.layers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <TimelineNumber label="発生開始" value={displayTime(layer.startUs, unit, project.productionFps)} onCommit={(input) =>
                readTime(input, (startUs) => execute({ kind: "layer.update", layerId: layer.id, patch: { startUs } }))} />
            {emitter && <TimelineNumber label="発生終了" value={displayTime(layer.emissionEndUs ?? project.durationUs, unit, project.productionFps)}
                onCommit={(input) => readTime(input, (emissionEndUs) => execute({ kind: "layer.update", layerId: layer.id, patch: { emissionEndUs } }))} />}
            {emitter && layer.emissionEndUs === undefined && <button onClick={() => execute({ kind: "layer.update", layerId: layer.id,
                patch: { emissionEndUs: project.durationUs } })}>終端に発生終了を設定</button>}
            <label>トラック<select aria-label="トラック" value={property} onChange={(event) => {
                selectProperty(event.currentTarget.value as TrackProperty); selectKey(undefined);
            }}>{choices.map((item) => <option key={item} value={item}>{TRACK_LABELS[item]}</option>)}</select></label>
            <button onClick={() => {
                const base = baseTrackValue(layer, emitter, material, property); // キーがないときの値
                const offsetUs = clock.current.time - layer.startUs;
                if (base === undefined) { setMessage("現在の発生方式では追加できないトラックです。"); return; }
                if (execute({ kind: "key.add", layerId: layer.id, property, key: { offsetUs, value: evaluateTrack(track, offsetUs, base) } })) {
                    selectKey({ layerId: layer.id, property, offsetUs });
                }
            }}>現在時刻にキーを追加</button>
            <label>キーを選択<select aria-label="キーを選択" value={key?.offsetUs ?? ""} onChange={(event) =>
                selectKey(event.currentTarget.value === "" ? undefined : { layerId: layer.id, property, offsetUs: Number(event.currentTarget.value) })}>
                <option value="">未選択</option>
                {track?.keys.map((entry) => <option key={entry.offsetUs} value={entry.offsetUs}>
                    {displayTime(layer.startUs + entry.offsetUs, unit, project.productionFps)}{entry.offsetUs > project.durationUs - layer.startUs ? "（範囲外）" : ""}
                </option>)}
            </select></label>
            {key && selection && <>
                <TimelineNumber label="キー時刻" value={displayTime(layer.startUs + key.offsetUs, unit, project.productionFps)} onCommit={(input) =>
                    readTime(input, (time) => changeKey(selection, { ...key, offsetUs: time - layer.startUs }))} />
                <KeyValueFields value={key.value} onCommit={(value) => changeKey(selection, { ...key, value })} />
                <label>次のキーまで<select aria-label="補間方式" value={key.interpolation ?? track!.interpolation}
                    onChange={(event) => changeKey(selection, { ...key, interpolation: event.currentTarget.value === "step" ? "step" : "linear" })}>
                    <option value="linear">Linear</option><option value="step">Step</option>
                </select></label>
                <button onClick={() => { if (execute({ kind: "key.remove", ...selection })) selectKey(undefined); }}>キーを削除</button>
            </>}
        </fieldset>}
        <p role="alert">{message}</p>
        <VcrReview key={mode} session={flow} onChange={() => refresh((value) => value + 1)} />
        {pending?.kind === "move" && <TimelineDialog label="移動先にキーがあります" onCancel={() => setPending(undefined)}>
            <p>移動先のキーを置き換えますか。</p><button onClick={() => {
                setPending(undefined);
                if (pending.project === flow.history.snapshot.project && execute({ ...pending.command, overwrite: true })) {
                    selectKey({ ...pending.command, offsetUs: pending.command.key.offsetUs });
                }
            }}>上書きする</button>
        </TimelineDialog>}
        {pending?.kind === "duration" && <TimelineDialog label="制作尺外のキーがあります" onCancel={() => setPending(undefined)}>
            <p>新しい制作尺の範囲外にあるキーをどうしますか。</p>
            {(["keep", "delete"] as const).map((outside) => <button key={outside} onClick={() => {
                setPending(undefined);
                if (pending.project === flow.history.snapshot.project) execute({ kind: "timeline.duration", durationUs: pending.durationUs, outside });
            }}>{outside === "keep" ? "範囲外キーを残す" : "範囲外キーを削除する"}</button>)}
        </TimelineDialog>}
    </div>;
}
