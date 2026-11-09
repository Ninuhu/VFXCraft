import { useEffect, useRef, useState } from "react";
import type { BackgroundSettings, Material, Mode, ProjectPreview } from "../../core/document/model.ts";
import { validateBackground, validateProject } from "../../core/document/validateDocument.ts";
import type { EditCommand } from "../../core/editing/command.ts";
import { DEFAULT_APPEARANCE, DEFAULT_BACKGROUND, DEFAULT_PREVIEW, resolveBackground } from "../../core/materials/materialEvaluation.ts";
import { REVIEW_VCR_LIMITS } from "../../core/persistence/vcrArchive.ts";
import { MaterialPreview } from "../../rendering/MaterialPreview.ts";
import { attachCameraInput } from "../../rendering/cameraInput3D.ts";
import { createParticleExample } from "../particles/ParticleReview.tsx";
import { create3DExample } from "../particles3d/Particle3DReview.tsx";
import { verifyBrowserImage } from "../projectFiles/browserProjectFiles.ts";
import { ProjectFileFlow } from "../projectFiles/projectFileFlow.ts";
import { VcrReview } from "../projectFiles/VcrReview.tsx";
import { colorHex, fromHex, GradientControls, NumberField } from "./GradientControls.tsx";
import "./materials.css";

const BACKGROUND_KEY = "vfxcraft.preview.background"; // 利用者共通の設定だけを保存

////////////////////
// 共通設定を検証して読み、無効なブラウザ設定では既定値を使う
function readCommon(): BackgroundSettings {
    try {
        const raw = localStorage.getItem(BACKGROUND_KEY); // ブラウザの保存値
        return resolveBackground(DEFAULT_BACKGROUND, raw ? validateBackground(JSON.parse(raw)) : {});
    } catch { return DEFAULT_BACKGROUND; }
}

////////////////////
// 2Dと3Dに別の履歴を用意し、複数材質を同時に確認できるサンプルを作る
function createSession(mode: Mode): ProjectFileFlow {
    const source = mode === "2d" ? createParticleExample() : create3DExample(50); // T05/T06のシミュレーションを再利用
    const materials: Material[] = source.materials.map((material, index) => ({ ...material,
        color: index === 0 ? [0.4, 0.65, 1] : [1, 0.32, 0.08],
        appearance: { ...DEFAULT_APPEARANCE, bloomStrength: index === 0 ? 1.5 : 0,
            spatial: { colors: [], alphas: [{ offset: 0, value: 1 }, { offset: 1, value: 0 }] } } }));
    const layers = [...source.layers]; // 検証用レイヤー
    const emitters = [...source.emitters]; // 検証用発生器
    if (source.mode === "2d") {
        const layer = source.layers[0]!, emitter = source.emitters[0]!, material = materials[0]!; // 複製元
        const id = crypto.randomUUID(), emitterId = crypto.randomUUID(), materialId = crypto.randomUUID();
        layers[0] = { ...layer, values: { ...layer.values, size: [2, 2] } };
        layers.push({ ...layer, id, order: 1, values: { ...layer.values, position: [340, 180], opacity: 0.75, size: [2, 2] },
            content: { kind: "emitter", emitterId } });
        emitters.push({ ...emitter, id: emitterId, materialId, emission: { kind: "continuous", ratePerSecond: 50 } });
        materials.push({ ...material, id: materialId, color: [1, 0.32, 0.08], appearance: { ...material.appearance!, bloomStrength: 0 } });
    }
    const project = validateProject({ ...source, name: "T07 " + mode.toUpperCase(), layers, emitters, materials });
    return new ProjectFileFlow(project, REVIEW_VCR_LIMITS, verifyBrowserImage, "0.0.0");
}

////////////////////
// T07の材質・発光・背景と既存の保存・履歴を実際に操作できる検証画面
export function MaterialsReview() {
    const [sessions] = useState(() => ({ "2d": createSession("2d"), "3d": createSession("3d") })); // モードごとの文書
    const [mode, setMode] = useState<Mode>("2d"); // 検証サンプルの選択
    const [selection, setSelection] = useState(0); // 材質の選択
    const [common, setCommon] = useState(readCommon); // 環境設定
    const [scope, setScope] = useState<"project" | "common">("project");
    const [light, setLight] = useState(false); // プレビュー品質
    const [message, setMessage] = useState(""); // 入力・描画エラー
    const [, setRevision] = useState(0); // 操作によるReact更新
    const canvas = useRef<HTMLCanvasElement>(null); // 表示先
    const stats = useRef<HTMLParagraphElement>(null); // 毎フレームの計測値
    const renderer = useRef<MaterialPreview | undefined>(undefined);
    const time = useRef(0), playing = useRef(false); // プレイヘッド
    const settings = useRef({ common, light }); // 描画ループが読むUI設定
    settings.current = { common, light };
    const flow = sessions[mode]; // アクティブな保存セッション
    const project = flow.history.snapshot.project; // 検証済みの表示文書
    const preview = project.preview ?? DEFAULT_PREVIEW;
    const material = project.materials[selection] ?? project.materials[0]; // 読込で選択が変わる場合の代替
    const appearance = material?.appearance ?? DEFAULT_APPEARANCE;
    const background = scope === "common" ? common : resolveBackground(common, preview.background);

    ////////////////////
    // 操作結果を再表示する
    function refresh() { setRevision((value) => value + 1); }

    ////////////////////
    // T03の履歴経路で設定を検証してから確定する
    function edit(command: EditCommand) {
        try { flow.history.execute(command); setMessage(""); }
        catch (error) { setMessage(String(error)); }
        refresh();
    }

    ////////////////////
    // 既存の材質に対して必要な項目だけを変更する
    function editMaterial(patch: Partial<Pick<Material, "appearance" | "blend" | "color" | "textureAssetId">>) {
        if (material) edit({ kind: "material.appearance", materialId: material.id, appearance,
            blend: material.blend, color: material.color, ...patch });
    }

    ////////////////////
    // プロジェクト固有設定の変更を履歴に追加する
    function editPreview(patch: Partial<ProjectPreview>) { edit({ kind: "project.preview", preview: { ...preview, ...patch } }); }

    ////////////////////
    // 個々の背景項目を継承または上書きする
    function editBackground<K extends keyof BackgroundSettings>(key: K, value?: BackgroundSettings[K]) {
        if (scope === "project") {
            const overrides = { ...preview.background }; // 変更対象以外の上書きを保持
            if (value === undefined) delete overrides[key]; else overrides[key] = value;
            editPreview({ background: overrides });
            return;
        }
        try {
            const validated = resolveBackground(DEFAULT_BACKGROUND, validateBackground({ ...common, [key]: value })); // 共通設定の検証
            localStorage.setItem(BACKGROUND_KEY, JSON.stringify(validated));
            setCommon(validated);
            setMessage("");
        } catch (error) { setMessage(String(error)); }
    }

    ////////////////////
    // 描画と画像の所有期間をマウントに揃え、Reactは粒子のフレーム更新を担当しない
    useEffect(() => {
        const output = canvas.current!; // 実際の描画先
        let view: MaterialPreview; // GPU描画の所有者
        try { view = new MaterialPreview(output); } catch (error) { setMessage(String(error)); return; }
        renderer.current = view;
        const images = new Map<string, ImageBitmap>(); // デコードした素材
        const blobs = new Map<string, Blob>(); // デコード中も含めた参照
        let disposed = false, frame = 0, last = performance.now(); // フレームの寿命と実時間
        const detach = attachCameraInput(output, view.view, (error) => setMessage(String(error)));
        let previousKey = "", previousProject: typeof project | undefined; // 停止中の再描画を省略する
        let imageRevision = 0; // デコード完了時に描き直す

        ////////////////////
        // 読込・Undo・Redoで変わった画像だけを差し替える
        function syncImages(document: typeof project) {
            const current = new Set(document.assets.map((asset) => asset.id.toLowerCase())); // 文書に存在する素材
            for (const [id] of blobs) {
                if (!current.has(id)) { blobs.delete(id); images.get(id)?.close(); images.delete(id); }
            }
            for (const asset of document.assets) {
                const id = asset.id.toLowerCase(), blob = flow.getImage(id); // 保存フローが所有する画像
                if (!blob || blobs.get(id) === blob) continue;
                blobs.set(id, blob);
                images.get(id)?.close();
                images.delete(id);
                void createImageBitmap(blob, { premultiplyAlpha: "none" }).then((bitmap) => {
                    if (disposed || blobs.get(id) !== blob) bitmap.close();
                    else { images.set(id, bitmap); imageRevision++; }
                }).catch((error: unknown) => { if (!disposed) setMessage(String(error)); });
            }
        }

        ////////////////////
        // 再生、シーク、編集、カメラ操作に応じて必要なフレームを描く
        function draw(now: number) {
            const document = flow.history.preview; // 最新の検証済み文書
            if (playing.current) time.current = (time.current + Math.round((now - last) * 1000)) % document.durationUs;
            last = now;
            const { common: background, light } = settings.current; // 画面固有の状態
            const key = JSON.stringify([time.current, background, light, imageRevision, document.mode === "3d" && view.view.basis()]);
            if (key !== previousKey || previousProject !== document) {
                previousKey = key;
                if (previousProject !== document) syncImages(document);
                previousProject = document;
                try {
                    const result = view.draw(document, Math.min(time.current, document.durationUs), { images, background, light });
                    if (stats.current) stats.current.textContent = (time.current / 1e6).toFixed(2) + "秒 / 粒子 " + result.count
                        + " / 描画呼出し " + result.calls + " / Bloom CPU " + result.bloomMs.toFixed(2) + "ms";
                } catch (error) { playing.current = false; setMessage(String(error)); }
            }
            frame = requestAnimationFrame(draw);
        }
        frame = requestAnimationFrame(draw);
        return () => {
            disposed = true;
            cancelAnimationFrame(frame);
            detach();
            view.dispose();
            renderer.current = undefined;
            for (const bitmap of images.values()) bitmap.close();
        };
    }, [flow]);

    return <div className="materials-review">
        <h1>T07 マテリアル・合成・背景・基本Bloom</h1>
        <p><a href="./">T01検証へ</a> · <a href="?particles-review">T05 2D</a> · <a href="?particles3d-review">T06 3D</a></p>
        <label>サンプル<select value={mode} onChange={(event) => {
            setMode(event.currentTarget.value === "3d" ? "3d" : "2d"); setSelection(0); time.current = 0; playing.current = false;
        }}><option value="2d">2D</option><option value="3d">3D</option></select></label>
        <div className="materials-layout">
            <section>
                <canvas aria-label="マテリアルプレビュー" ref={canvas} data-pixel={project.mode === "2d" && project.drawing === "pixel"} />
                <p ref={stats} aria-live="off" />
                <button onClick={() => { playing.current = !playing.current; }}>再生・一時停止</button>
                <button onClick={() => { playing.current = false; time.current = 0; }}>停止・先頭へ</button>
                <label>シーク<input key={mode} type="range" min="0" max={project.durationUs} step="10000" defaultValue={0}
                    onChange={(event) => { time.current = event.currentTarget.valueAsNumber; playing.current = false; }} /></label>
                <label>品質<select value={light ? "light" : "accurate"} onChange={(event) => setLight(event.currentTarget.value === "light")}>
                    <option value="accurate">正確</option><option value="light">軽量（Bloomの解像度を下げる）</option>
                </select></label>
                {project.mode === "3d" && <div>
                    <button onClick={() => renderer.current?.view.reset()}>視点リセット</button>
                    <button onClick={() => { try { renderer.current?.frame(); } catch (error) { setMessage(String(error)); } }}>全体表示</button>
                    <p>左ドラッグで回転、右ドラッグで移動、ホイールで拡大・縮小。</p>
                </div>}
                {project.mode === "2d" && <label>2D描画<select value={project.drawing === "normal" ? 0 : project.pixelScale}
                    onChange={(event) => { const scale = Number(event.currentTarget.value); // 整数倍率
                        edit({ kind: "drawing.update", drawing: scale ? "pixel" : "normal", pixelScale: scale || project.pixelScale }); }}>
                    <option value={0}>通常</option>{[2, 4, 8].map((scale) => <option key={scale} value={scale}>ピクセル {scale}倍</option>)}
                </select></label>}
                <p role="alert">{message}</p>
                <fieldset>
                    <legend>背景とグリッド</legend>
                    <label>設定先<select value={scope} onChange={(event) => setScope(event.currentTarget.value === "common" ? "common" : "project")}>
                        <option value="project">このプロジェクト</option><option value="common">利用者共通</option></select></label>
                    <div className="material-fields">
                        <label>背景色<input key={colorHex(background.color)} type="color" defaultValue={colorHex(background.color)}
                            onBlur={(event) => { if (event.currentTarget.value !== colorHex(background.color)) editBackground("color", fromHex(event.currentTarget.value)); }} /></label>
                        {scope === "project" && <button disabled={preview.background.color === undefined} onClick={() => editBackground("color")}>背景色を継承</button>}
                    </div>
                    {(["checker", "grid"] as const).map((key) => <div key={key} className="material-fields">
                        <label>{key === "checker" ? "チェッカー" : "グリッド"}<input type="checkbox" checked={background[key]}
                            onChange={(event) => editBackground(key, event.currentTarget.checked)} /></label>
                        {scope === "project" && <button disabled={preview.background[key] === undefined} onClick={() => editBackground(key)}>
                            {key === "checker" ? "チェッカー" : "グリッド"}を継承</button>}
                    </div>)}
                    <NumberField label="グリッド透明度" value={background.gridOpacity} onCommit={(value) => editBackground("gridOpacity", value)} />
                    {scope === "project" && <button disabled={preview.background.gridOpacity === undefined} onClick={() => editBackground("gridOpacity")}>グリッド透明度を継承</button>}
                </fieldset>
            </section>
            <section>
                <fieldset>
                    <legend>マテリアル</legend>
                    <label>編集対象<select value={material?.id ?? ""} onChange={(event) => setSelection(project.materials.findIndex((item) => item.id === event.currentTarget.value))}>
                        {project.materials.map((item, index) => <option key={item.id} value={item.id}>マテリアル {index + 1}</option>)}</select></label>
                    {material && <>
                        <label>基本色<input key={colorHex(material.color)} type="color" defaultValue={colorHex(material.color)}
                            onBlur={(event) => { if (event.currentTarget.value !== colorHex(material.color)) editMaterial({ color: fromHex(event.currentTarget.value) }); }} /></label>
                        <NumberField label="基本透明度" value={appearance.opacity} onCommit={(opacity) => editMaterial({ appearance: { ...appearance, opacity } })} />
                        <label>テクスチャ<select value={material.textureAssetId?.toLowerCase() ?? ""} onChange={(event) =>
                            editMaterial({ textureAssetId: event.currentTarget.value || null })}>
                            <option value="">なし</option>{project.assets.map((asset) => <option key={asset.id} value={asset.id.toLowerCase()}>{asset.name}</option>)}</select></label>
                        <label>合成<select value={material.blend} onChange={(event) => editMaterial({ blend: event.currentTarget.value as Material["blend"] })}>
                            <option value="alpha">通常</option><option value="additive">加算</option><option value="multiply">乗算</option></select></label>
                        <NumberField label="Bloom強度" value={appearance.bloomStrength} max={8}
                            onCommit={(bloomStrength) => editMaterial({ appearance: { ...appearance, bloomStrength } })} />
                        <GradientControls name="寿命グラデーション" gradient={appearance.lifetime}
                            onChange={(lifetime) => editMaterial({ appearance: { ...appearance, lifetime } })} />
                        <GradientControls name="空間グラデーション" gradient={appearance.spatial}
                            onChange={(spatial) => editMaterial({ appearance: { ...appearance, spatial } })} />
                    </>}
                </fieldset>
                <fieldset>
                    <legend>共通Bloom</legend>
                    <NumberField label="Bloom半径（px）" value={preview.bloom.radius} max={32}
                        onCommit={(radius) => editPreview({ bloom: { ...preview.bloom, radius } })} />
                    <NumberField label="Bloomしきい値" value={preview.bloom.threshold}
                        onCommit={(threshold) => editPreview({ bloom: { ...preview.bloom, threshold } })} />
                    {project.mode === "2d" && <label>ピクセル時のBloom<select value={preview.pixelBloom} onChange={(event) =>
                        editPreview({ pixelBloom: event.currentTarget.value === "smooth" ? "smooth" : "pixel" })}>
                        <option value="pixel">Pixel Bloom</option><option value="smooth">Smooth Bloom</option></select></label>}
                </fieldset>
            </section>
        </div>
        <VcrReview key={mode} session={flow} onChange={refresh} />
    </div>;
}
