import { useEffect, useRef, useState } from "react";
import { createProject } from "../../core/document/createProject.ts";
import { validateProject } from "../../core/document/validateDocument.ts";
import type { Emitter, Particle2D } from "../../core/document/model.ts";
import { REVIEW_VCR_LIMITS } from "../../core/persistence/vcrArchive.ts";
import { ProjectFileFlow } from "../projectFiles/projectFileFlow.ts";
import { verifyBrowserImage } from "../projectFiles/browserProjectFiles.ts";
import { VcrReview } from "../projectFiles/VcrReview.tsx";
import { ParticleCanvas2D, type PreviewQuality } from "../../rendering/ParticleCanvas2D.ts";

////////////////////
// 外部素材を使わない、T05の操作検証用プロジェクトを生成する
export function createParticleExample() {
    const id = crypto.randomUUID(), emitterId = crypto.randomUUID(), materialId = crypto.randomUUID(); // 独立したモデルID
    return validateProject({
        ...createProject({ id: crypto.randomUUID(), name: "T05 sample", mode: "2d", drawing: "normal",
            canvasWidth: 640, canvasHeight: 360, durationUs: 4_000_000 }),
        layers: [{ id, name: "粒子", parentId: null, order: 0, isVisible: true, isLocked: false, startUs: 0,
            values: { position: [320,180], rotation: 0, size: [1,1], color: [1,1,1], opacity: 1 },
            content: { kind: "emitter", emitterId } }],
        emitters: [{ id: emitterId, materialId, lifetimeUs: 2_000_000, emission: { kind: "continuous", ratePerSecond: 100 },
            particle2d: { speed: 70, directionDegrees: 270, acceleration: [0,60], space: "local", seed: 1, shape: { kind: "circle", radius: 30 } } }],
        materials: [{ id: materialId, textureAssetId: null, blend: "alpha", color: [1,1,1], hasBloom: false, gradient: [] }],
    });
}

////////////////////
// T05の入力と描画ループを用意し、保存にはT04の共通経路を使う
export function ParticleReview() {
    const [flow] = useState(() => new ProjectFileFlow(createParticleExample(), REVIEW_VCR_LIMITS, verifyBrowserImage, "0.0.0")); // 編集セッション
    const canvas = useRef<HTMLCanvasElement>(null); // 描画先
    const time = useRef(0); // 描画ループの時刻（µs）
    const playing = useRef(false); // 再生状態
    const quality = useRef<PreviewQuality>("accurate"); // プレビュー固有の品質
    const [tick, refresh] = useState(0); // 編集時の入力表示の更新
    const [message, setMessage] = useState(""); // 不正入力と評価エラー
    const stats = useRef<HTMLParagraphElement>(null); // Reactを介さない負荷表示
    const project = flow.history.snapshot.project; // 確定済み文書
    const emitter = project.emitters[0]; // 検証用の先頭発生器
    const settings = emitter?.particle2d; // 2D設定

    ////////////////////
    // 設定変更はUndo可能な共通コマンドとして検証する
    function change(patch: Partial<Emitter>) {
        if (!emitter) return;
        try {
            flow.history.execute({ kind: "emitter.update", emitterId: emitter.id,
                settings: { emission: emitter.emission, lifetimeUs: emitter.lifetimeUs, particle2d: settings!, ...patch } });
            setMessage("");
        } catch (error) { setMessage(String(error)); }
        refresh((value) => value+1);
    }

    ////////////////////
    // 位置・寿命などの入力欄を作り、空入力を不正値として扱う
    function input(label: string, value: number, onChange: (value: number) => void) {
        return <label>{label}<input aria-label={label} type="number" value={value}
            onChange={(event) => onChange(event.currentTarget.valueAsNumber)} /></label>;
    }

    ////////////////////
    // 再描画はrequestAnimationFrameで進め、素材とタイマーを確実に解放する
    useEffect(() => {
        const renderer = new ParticleCanvas2D(canvas.current!); // Canvasの所有者
        const images = new Map<string, ImageBitmap>(); // このマウントで所有するデコード画像
        let disposed = false, frame = 0, previous = performance.now(); // 取消と実時間
        const doc = flow.history.snapshot.project; // デコード対象のスナップショット
        void Promise.all(doc.assets.map(async (asset) => {
            const blob = flow.getImage(asset.id); // 保存セッションの素材
            if (!blob) return;
            const bitmap = await createImageBitmap(blob); // 描画用画像
            if (disposed) bitmap.close(); else images.set(asset.id.toLowerCase(),bitmap);
        })).catch((error: unknown) => setMessage(String(error)));
        ////////////////////
        // 品質の切替は描画だけに適用し、文書の評価条件を維持する
        function draw(now: number) {
            if (disposed) return;
            const current = flow.history.snapshot.project; // 最新の編集をそのまま描く
            if (playing.current) time.current = Math.round((time.current+(now-previous)*1000) % current.durationUs);
            previous = now;
            try {
                if (current.mode === "2d") {
                    const start = performance.now(); // 評価と描画にかかるCPU時間
                    const count = renderer.draw(current,time.current,quality.current,images); // 描画結果
                    if (stats.current) stats.current.textContent = "時刻 " + (time.current/1e6).toFixed(2)
                        + "秒 / 粒子 " + count.total + " / 描画 " + count.drawn + " / CPU " + (performance.now()-start).toFixed(2) + "ms";
                }
            } catch (error) { playing.current=false; setMessage(String(error)); return; }
            frame=requestAnimationFrame(draw);
        }
        frame=requestAnimationFrame(draw);
        return () => { disposed=true; cancelAnimationFrame(frame); renderer.dispose(); for (const image of images.values()) image.close(); };
    }, [flow,tick]);

    return <main style={{ padding: "1rem", background: "#171524", color: "#eee" }}>
        <h1>T05 2Dパーティクル検証</h1><a href="./">T01検証へ</a>
        <p>方向は右が0度、下が90度。位置と速度は論理ピクセルと秒で指定します。</p>
        <canvas ref={canvas} style={{ width: "min(100%,640px)", background: "#292436", imageRendering: "pixelated" }} />
        <p ref={stats} role="status" />
        <button onClick={() => { playing.current=!playing.current; }}>再生・一時停止</button>
        <button onClick={() => { playing.current=false; time.current=0; }}>停止・先頭へ</button>
        <label>シーク<input type="range" min="0" max={project.durationUs} step="10000" defaultValue="0"
            onChange={(event) => { playing.current=false; time.current=Number(event.currentTarget.value); }} /></label>
        <label>品質<select aria-label="品質" onChange={(event) => { quality.current=event.currentTarget.value as PreviewQuality; }}>
            <option value="accurate">正確</option><option value="light">軽量（表示のみ間引く）</option>
        </select></label>
        {project.mode === "2d" && <label>描画<select aria-label="描画" value={project.drawing+":"+project.pixelScale}
            onChange={(event) => { const [drawing, scale] = event.currentTarget.value.split(":"); // 選択された描画方式
                flow.history.execute({ kind: "drawing.update", drawing: drawing as "normal" | "pixel", pixelScale: Number(scale) }); refresh((v)=>v+1); }}>
            <option value={"normal:"+project.pixelScale}>通常2D</option>{[2,4,8].map((scale)=><option key={scale} value={"pixel:"+scale}>ピクセル {scale}倍</option>)}
        </select></label>}
        {settings && emitter && <fieldset><legend>発生と運動</legend>
            <label>発生方式<select aria-label="発生方式" value={emitter.emission.kind}
                onChange={(event)=>change({ emission: event.currentTarget.value === "burst" ? {kind:"burst",count:100} : {kind:"continuous",ratePerSecond:100} })}>
                <option value="continuous">連続</option><option value="burst">一括</option></select></label>
            {input(emitter.emission.kind === "continuous" ? "発生率（個/秒）" : "一括個数",
                emitter.emission.kind === "continuous" ? emitter.emission.ratePerSecond : emitter.emission.count,
                (value)=>change({emission:emitter.emission.kind === "continuous" ? {kind:"continuous",ratePerSecond:value} : {kind:"burst",count:value}}))}
            {input("寿命（秒）",emitter.lifetimeUs/1e6,(value)=>change({lifetimeUs:value*1e6}))}
            {input("初速",settings.speed,(value)=>change({particle2d:{...settings,speed:value}}))}
            {input("方向（度）",settings.directionDegrees,(value)=>change({particle2d:{...settings,directionDegrees:value}}))}
            {[0,1].map((axis)=><span key={axis}>{input(axis===0?"加速度X":"加速度Y", settings.acceleration[axis]!,
                (value)=>change({particle2d:{...settings,acceleration:axis===0?[value,settings.acceleration[1]]:[settings.acceleration[0],value]}}))}</span>)}
            <label>シミュレーション空間<select aria-label="シミュレーション空間" value={settings.space}
                onChange={(event)=>change({particle2d:{...settings,space:event.currentTarget.value as Particle2D["space"]}})}>
                <option value="local">ローカル（生成後も追従）</option><option value="world">ワールド（発生時に固定）</option></select></label>
            <label>発生形状<select aria-label="発生形状" value={settings.shape.kind} onChange={(event)=>{
                const kind=event.currentTarget.value; // 選んだ形状
                change({particle2d:{...settings,shape:kind==="circle"?{kind,radius:30}:kind==="rectangle"?{kind,width:80,height:40}:{kind:"point"}}});
            }}><option value="point">点</option><option value="circle">円</option><option value="rectangle">長方形</option></select></label>
            {settings.shape.kind==="circle" && input("半径",settings.shape.radius,(radius)=>change({particle2d:{...settings,shape:{kind:"circle",radius}}}))}
            {settings.shape.kind==="rectangle" && <>
                {input("幅",settings.shape.width,(width)=>change({particle2d:{...settings,shape:{kind:"rectangle",width,height:settings.shape.kind==="rectangle"?settings.shape.height:0}}}))}
                {input("高さ",settings.shape.height,(height)=>change({particle2d:{...settings,shape:{kind:"rectangle",height,width:settings.shape.kind==="rectangle"?settings.shape.width:0}}}))}
            </>}
            {project.layers[0] && input("発生器X",project.layers[0].values.position[0],(value)=>{
                try { flow.history.execute({kind:"layer.update",layerId:project.layers[0]!.id,patch:{values:{position:[value,180]}}}); }
                catch(error){setMessage(String(error));} refresh((v)=>v+1);
            })}
        </fieldset>}
        {project.materials[0] && <label>粒子テクスチャ<select aria-label="粒子テクスチャ"
            value={project.materials[0].textureAssetId ?? ""}
            onChange={(event)=>{
                flow.history.execute({kind:"material.setTexture",materialId:project.materials[0]!.id,assetId:event.currentTarget.value || null});
                refresh((v)=>v+1);
            }}><option value="">白い粒子（素材なし）</option>{project.assets.map((asset)=><option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>}
        <p role="alert">{message}</p>
        <VcrReview session={flow} onChange={()=>refresh((value)=>value+1)} />
    </main>;
}
