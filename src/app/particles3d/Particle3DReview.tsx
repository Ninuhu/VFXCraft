import { useEffect, useRef, useState } from "react";
import { createProject } from "../../core/document/createProject.ts";
import { validateProject } from "../../core/document/validateDocument.ts";
import type { Emitter, Particle3D, Vec3 } from "../../core/document/model.ts";
import { quaternionFromEulerXyzDegrees } from "../../core/document/rotation.ts";
import { REVIEW_VCR_LIMITS } from "../../core/persistence/vcrArchive.ts";
import { ProjectFileFlow } from "../projectFiles/projectFileFlow.ts";
import { verifyBrowserImage } from "../projectFiles/browserProjectFiles.ts";
import { VcrReview } from "../projectFiles/VcrReview.tsx";
import { ParticleWebGL3D } from "../../rendering/ParticleWebGL3D.ts";
import { attachCameraInput } from "../../rendering/cameraInput3D.ts";

////////////////////
// 異なるレイヤー間の透明合成を確認できる独立した二つの発生器を用意する
export function create3DExample(count = 100) {
    const layers = [], emitters = [], materials = []; // 検証用の独立モデル
    for (let index = 0; index < 2; index++) {
        const id = crypto.randomUUID(), emitterId = crypto.randomUUID(), materialId = crypto.randomUUID(); // 衝突しない採番
        layers.push({ id, name: index === 0 ? "青い粒子" : "赤い粒子", parentId: null, order: index,
            isVisible: true, isLocked: false, startUs: 0,
            values: { position: [index * 0.3, 0, -index], rotation: [0, 0, 0, 1], size: [2, 3, 2], color: [1, 1, 1], opacity: 0.45 },
            content: { kind: "emitter", emitterId } });
        emitters.push({ id: emitterId, materialId, lifetimeUs: 2_000_000, emission: { kind: "continuous", ratePerSecond: count },
            particle3d: { speed: 1, direction: [index === 0 ? 1 : -1, 2, 0.5], acceleration: [0, -1, 0],
                space: "local", seed: 1, shape: "point", billboard: "camera" } });
        materials.push({ id: materialId, textureAssetId: null, blend: "alpha", color: index === 0 ? [0.1, 0.5, 1] : [1, 0.2, 0.1],
            hasBloom: false, gradient: [] });
    }
    return validateProject({ ...createProject({ id: crypto.randomUUID(), name: "T06 sample", mode: "3d", durationUs: 4_000_000 }),
        layers, emitters, materials });
}

////////////////////
// 3Dの描画・カメラ・編集・保存を検証する開発用画面
export function Particle3DReview() {
    const [flow] = useState(() => new ProjectFileFlow(create3DExample(), REVIEW_VCR_LIMITS, verifyBrowserImage, "0.0.0")); // 編集セッション
    const canvas = useRef<HTMLCanvasElement>(null); // WebGLの表示先
    const renderer = useRef<ParticleWebGL3D | undefined>(undefined); // マウントで所有する描画器
    const time = useRef(0), playing = useRef(false); // マイクロ秒時刻と再生状態
    const transaction = useRef<symbol | undefined>(undefined); // 数値入力をまとめるトークン
    const [selected, setSelected] = useState(0); // 編集するレイヤー
    const [, refresh] = useState(0); // 操作時だけReactを更新する
    const [message, setMessage] = useState(""); // 無効入力とファイル操作の説明
    const stats = useRef<HTMLParagraphElement>(null); // 毎フレームの表示更新先
    const project = flow.history.preview; // 連続入力中の有効な候補も表示する
    const selectedIndex = project.layers[selected] ? selected : 0; // 読込後に以前の選択番号が存在しない場合は先頭へ
    const layer = project.layers[selectedIndex]; // 選択レイヤー
    const content = layer?.content; // 発生器の参照
    const emitter = content?.kind === "emitter" ? project.emitters.find((item) => item.id.toLowerCase() === content.emitterId.toLowerCase()) : undefined; // 選択発生器
    const settings = emitter?.particle3d; // 3D設定

    ////////////////////
    // 連続入力を確定し、無効な最新入力なら開始前に戻す
    function finish(cancel = false) {
        const token = transaction.current; // 操作トークン
        if (!token) return;
        try {
            if (cancel || !flow.history.commitContinuousEdit(token)) {
                try { flow.history.cancelContinuousEdit(token); } catch { /* 無変更の確定済みなら終了している */ }
            }
        } finally { transaction.current = undefined; refresh((value) => value + 1); }
    }

    ////////////////////
    // 発生器の候補を既存トランザクション経路で検証する
    function change(patch: Partial<Emitter>, continuous = false) {
        if (!emitter) return;
        const command = { kind: "emitter.update" as const, emitterId: emitter.id, settings: {
            emission: emitter.emission, lifetimeUs: emitter.lifetimeUs, particle3d: settings!, ...patch } }; // 原子的な設定変更
        try {
            if (continuous) {
                transaction.current ??= flow.history.beginContinuousEdit();
                if (!flow.history.updateContinuousEdit(transaction.current, command)) throw new Error("入力値が不正です。確定値は保持しています。");
            } else { finish(); flow.history.execute(command); }
            setMessage("");
        } catch (error) { setMessage(String(error)); }
        refresh((value) => value + 1);
    }

    ////////////////////
    // 入力開始からフォーカス離脱までを1履歴として扱う
    function numeric(label: string, value: number, update: (value: number) => void) {
        return <label style={{ display: "inline-block", padding: 4 }}>{label}
            <input aria-label={label} type="number" value={value} onChange={(event) => update(event.currentTarget.valueAsNumber)}
                onBlur={() => finish()} onKeyDown={(event) => { if (event.key === "Escape") finish(true); }} /></label>;
    }

    ////////////////////
    // WebGL、入力イベント、ResizeObserverと描画ループの寿命を一つのマウントで管理する
    useEffect(() => {
        const view = new ParticleWebGL3D(canvas.current!); // 描画資源の所有者
        renderer.current = view;
        const detach = attachCameraInput(canvas.current!, view.view, (error) => setMessage(String(error))); // マウス入力
        const resize = new ResizeObserver((entries) => {
            const size = entries[0]?.contentRect; // CSS上の表示サイズ
            if (size && size.width > 0 && size.height > 0) view.resize(size.width, size.height);
        });
        resize.observe(canvas.current!);
        let frame = 0, previous = performance.now(), cancelled = false; // ループ状態
        ////////////////////
        // Reactの描画周期に依存せず、指定時刻の文書を評価して描く
        function draw(now: number) {
            if (cancelled) return;
            const document = flow.history.preview; // 編集のプレビュー
            if (playing.current) time.current = Math.round((time.current + (now - previous) * 1000) % document.durationUs);
            previous = now;
            try {
                if (document.mode === "3d") {
                    const value = view.draw(document, time.current); // 計測値と描画
                    if (stats.current) stats.current.textContent = "時刻 " + (time.current / 1e6).toFixed(2)
                        + "秒 / 粒子 " + value.count + " / sort " + value.sortMs.toFixed(2) + "ms / GL " + view.glError;
                } else {
                    view.clear();
                    if (stats.current) stats.current.textContent = "2Dプロジェクトを開いたため3Dプレビューを停止しました。文書は保存できます。";
                }
            } catch (error) { playing.current = false; setMessage(String(error)); }
            frame = requestAnimationFrame(draw);
        }
        frame = requestAnimationFrame(draw);
        return () => { cancelled = true; cancelAnimationFrame(frame); resize.disconnect(); detach(); view.dispose(); renderer.current = undefined; };
    }, [flow]);

    return <main style={{ background: "#171524", color: "#eee", padding: "1rem" }}>
        <h1>T06 3Dパーティクル・カメラ検証</h1>
        <p>左ドラッグで回転、右またはShift＋ドラッグで平行移動、ホイールでズーム。カメラ操作は編集履歴に含めません。</p>
        <canvas aria-label="3Dプレビュー" ref={canvas} style={{ width: "min(100%,900px)", height: "min(55vh,500px)", display: "block", touchAction: "none" }} />
        <p ref={stats} role="status" />
        <button onClick={() => { playing.current = !playing.current; }}>再生・一時停止</button>
        <button onClick={() => { playing.current = false; time.current = 0; }}>停止・先頭へ</button>
        <label>シーク<input aria-label="シーク" type="range" min="0" max={project.durationUs} step="10000" defaultValue="0"
            onChange={(event) => { playing.current = false; time.current = Number(event.currentTarget.value); }} /></label>
        <button onClick={() => renderer.current?.view.reset()}>視点リセット</button>
        <button onClick={() => { try { const current = flow.history.preview; // ボタン操作時の正確なプレイヘッドを評価
            if (current.mode === "3d") renderer.current?.draw(current, time.current); else renderer.current?.clear();
            setMessage(renderer.current?.frame() ? "" : "現在時刻には粒子がありません。"); } catch (error) { setMessage(String(error)); } }}>全体表示</button>
        <label>編集レイヤー<select aria-label="編集レイヤー" value={selectedIndex} onChange={(event) => { finish(); setSelected(Number(event.currentTarget.value)); }}>
            {project.layers.map((entry, index) => <option key={entry.id} value={index}>{entry.name}</option>)}</select></label>
        {emitter && settings && <fieldset><legend>3D発生器（形状は点）</legend>
            <label>発生方式<select aria-label="発生方式" value={emitter.emission.kind} onChange={(event) =>
                change({ emission: event.currentTarget.value === "burst" ? { kind: "burst", count: 100 } : { kind: "continuous", ratePerSecond: 100 } })}>
                <option value="continuous">連続</option><option value="burst">一括</option></select></label>
            {numeric(emitter.emission.kind === "burst" ? "一括個数" : "発生率", emitter.emission.kind === "burst" ? emitter.emission.count : emitter.emission.ratePerSecond,
                (value) => change({ emission: emitter.emission.kind === "burst" ? { kind: "burst", count: value } : { kind: "continuous", ratePerSecond: value } }, true))}
            {numeric("寿命（秒）", emitter.lifetimeUs / 1e6, (value) => change({ lifetimeUs: value * 1e6 }, true))}
            {numeric("初速", settings.speed, (value) => change({ particle3d: { ...settings, speed: value } }, true))}
            {(["direction", "acceleration"] as const).map((field) => <span key={field}>{[0, 1, 2].map((axis) =>
                <span key={axis}>{numeric((field === "direction" ? "方向" : "加速度") + ["X", "Y", "Z"][axis], settings[field][axis]!,
                    (value) => change({ particle3d: { ...settings, [field]: settings[field].map((item, index) => index === axis ? value : item) as unknown as Vec3 } }, true))}</span>)}</span>)}
            <label>空間<select aria-label="空間" value={settings.space} onChange={(event) => change({ particle3d: { ...settings, space: event.currentTarget.value as Particle3D["space"] } })}>
                <option value="local">ローカル（生成後も追従）</option><option value="world">ワールド（発生時に固定）</option></select></label>
            <label>ビルボード<select aria-label="ビルボード" value={settings.billboard}
                onChange={(event) => change({ particle3d: { ...settings, billboard: event.currentTarget.value as Particle3D["billboard"] } })}>
                <option value="camera">全面カメラ追従</option><option value="world-y">ワールドY軸固定</option></select></label>
        </fieldset>}
        {layer && project.mode === "3d" && <fieldset><legend>レイヤー変換</legend>
            {[0, 1, 2].map((axis) => <span key={axis}>{numeric("位置" + ["X", "Y", "Z"][axis], layer.values.position[axis]!, (value) => {
                try {
                    transaction.current ??= flow.history.beginContinuousEdit();
                    const position = layer.values.position.map((item, index) => index === axis ? value : item) as unknown as Vec3; // 座標候補
                    if (!flow.history.updateContinuousEdit(transaction.current, { kind: "layer.update", layerId: layer.id, patch: { values: { position } } })) setMessage("位置が不正です。");
                } finally { refresh((current) => current + 1); }
            })}</span>)}
            <button onClick={() => { finish(); flow.history.execute({ kind: "layer.update", layerId: layer.id,
                patch: { values: { rotation: quaternionFromEulerXyzDegrees([0, 45, 0]) } } }); refresh((value) => value + 1); }}>Y軸45度に回転</button>
        </fieldset>}
        <p role="alert">{message}</p>
        <VcrReview session={flow} onChange={() => { time.current = 0; refresh((value) => value + 1); }} />
    </main>;
}
