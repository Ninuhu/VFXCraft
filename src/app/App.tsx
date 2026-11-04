import { useEffect, useRef, useState } from "react";
import { WebGlPreview, type PreviewOptions } from "../verification/WebGlPreview";
import { downloadPng } from "../verification/exportTransparentPng";
import { loadSnapshot, saveSnapshot } from "../verification/verificationStorage";

type FrameAction = "export" | "save" | "restore";

const INITIAL_OPTIONS: PreviewOptions = {
    mode: "2d",
    emission: "continuous",
    isAdditive: false,
    hasBloom: false,
    isPlaying: true,
}; // 起動時の検証条件

////////////////////
// 検証用の描画器をマウント時に作り、画面操作から設定だけを渡す
export function App() {
    const [options, setOptions] = useState(INITIAL_OPTIONS); // 検証UIの操作値
    const [error, setError] = useState(""); // WebGLや描画のエラー表示
    const [status, setStatus] = useState(""); // 保存・復元・出力の結果
    const [actionError, setActionError] = useState(""); // 失敗時に現在のプレビューと分けて表示する情報
    const [isBusy, setIsBusy] = useState(false); // 非同期処理中の二重操作を防ぐ状態
    const [savedImage, setSavedImage] = useState<Blob>(); // 確認用の保存済みPNG
    const [imageUrl, setImageUrl] = useState(""); // 保存画像を表示する一時参照
    const canvasRef = useRef<HTMLCanvasElement>(null); // 描画対象
    const previewRef = useRef<WebGlPreview | null>(null); // カメラリセットの操作先
    const optionsRef = useRef(options); // 次のフレームで使う最新設定
    const secondsRef = useRef(0); // 再生位置（秒）

    useEffect(() => {
        optionsRef.current = options;
    }, [options]);

    useEffect(() => {
        if (!savedImage) return;
        const url = URL.createObjectURL(savedImage); // この画像の表示期間だけ保持する参照
        setImageUrl(url);
        return () => URL.revokeObjectURL(url);
    }, [savedImage]);

    useEffect(() => {
        const canvas = canvasRef.current; // マウント済みのキャンバス
        if (!canvas) return;

        let preview: WebGlPreview; // このマウントが所有する描画器
        try {
            preview = new WebGlPreview(canvas);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "WebGL2を初期化できませんでした。");
            return;
        }

        previewRef.current = preview;
        let frameId = 0; // 停止時に取り消す描画予約
        let previousMs = performance.now(); // 前回フレームの実時刻（ms）

        ////////////////////
        // 経過時間だけを更新して描画し、失敗時はループを停止する
        function frame(nowMs: number) {
            const current = optionsRef.current; // このフレームの検証条件
            if (current.isPlaying) {
                // バックグラウンド復帰直後に大きく時刻が飛ぶのを抑える。
                secondsRef.current += Math.min((nowMs - previousMs) / 1000, 0.1);
            }
            previousMs = nowMs;
            try {
                preview.render(secondsRef.current, current);
                frameId = requestAnimationFrame(frame);
            } catch (cause) {
                setError(cause instanceof Error ? cause.message : "描画に失敗しました。");
            }
        }

        ////////////////////
        // GPUコンテキストが失われた場合は描画を停止し、状態を表示する
        function handleContextLost() {
            cancelAnimationFrame(frameId);
            setError("WebGLコンテキストが失われました。ページを再読み込みしてください。");
        }

        canvas.addEventListener("webglcontextlost", handleContextLost);
        frameId = requestAnimationFrame(frame);

        return () => {
            cancelAnimationFrame(frameId);
            canvas.removeEventListener("webglcontextlost", handleContextLost);
            previewRef.current = null;
            preview.dispose();
        };
    }, []);

    ////////////////////
    // 出力・保存の条件を固定し、復元は読込と画像検証に成功した後だけ反映する
    async function runFrameAction(action: FrameAction): Promise<void> {
        setIsBusy(true);
        setStatus("");
        setActionError("");
        try {
            if (action === "restore") {
                const snapshot = await loadSnapshot(); // 画像まで検証済みの保存値
                secondsRef.current = snapshot.seconds;
                optionsRef.current = snapshot.options;
                setOptions(snapshot.options);
                setSavedImage(snapshot.image);
                setStatus("検証データとPNG画像を復元しました。");
                return;
            }

            const preview = previewRef.current; // 現在の描画器
            if (!preview || error) throw new Error("プレビューが利用できません。");
            const seconds = secondsRef.current; // 出力するフレーム時刻（秒）
            const image = await preview.capturePng(seconds, options); // 固定した描画結果
            if (action === "save") {
                await saveSnapshot(options, seconds, image);
                setSavedImage(image);
                setStatus("検証データとPNG画像をブラウザに保存しました。");
            } else {
                downloadPng(image);
                setStatus("透過PNGのダウンロードを開始しました。");
            }
        } catch (cause) {
            setActionError(cause instanceof Error ? cause.message : "検証データの処理に失敗しました。");
        } finally {
            setIsBusy(false);
        }
    }

    return (
        <main className="verification">
            <p className="verification__label">T01 検証用UI · Phase 3</p>
            <h1>VFXCraft</h1>
            <fieldset className="verification__controls" disabled={isBusy}>
                <legend>描画設定</legend>
                <label>
                    描画方式
                    <select value={options.mode} onChange={(event) => {
                        const mode = event.currentTarget.value; // 選択された描画モード
                        if (mode === "2d" || mode === "pixel" || mode === "3d") {
                            setOptions({ ...options, mode });
                        }
                    }}>
                        <option value="2d">通常2D</option>
                        <option value="pixel">ピクセル2D</option>
                        <option value="3d">3Dビルボード</option>
                    </select>
                </label>
                <label>
                    発生
                    <select value={options.emission} onChange={(event) => {
                        const emission = event.currentTarget.value; // 選択された発生方式
                        if (emission === "continuous" || emission === "burst") {
                            setOptions({ ...options, emission });
                        }
                    }}>
                        <option value="continuous">連続</option>
                        <option value="burst">Burst</option>
                    </select>
                </label>
                <label>
                    <input type="checkbox" checked={options.isAdditive}
                        onChange={(event) => setOptions({ ...options, isAdditive: event.currentTarget.checked })} />
                    加算合成（オフ：アルファ合成）
                </label>
                <label>
                    <input type="checkbox" checked={options.hasBloom}
                        onChange={(event) => setOptions({ ...options, hasBloom: event.currentTarget.checked })} />
                    Bloom
                </label>
                <button type="button" onClick={() => setOptions({ ...options, isPlaying: !options.isPlaying })}>
                    {options.isPlaying ? "一時停止" : "再生"}
                </button>
                <button type="button" onClick={() => { secondsRef.current = 0; }}>時間リセット</button>
                {options.mode === "3d" && (
                    <button type="button" onClick={() => previewRef.current?.resetCamera()}>カメラリセット</button>
                )}
            </fieldset>
            {error && <p role="alert">描画を開始・継続できません。{error}</p>}
            <canvas ref={canvasRef} aria-label="粒子描画プレビュー"
                className={options.mode === "pixel" ? "verification__canvas verification__canvas--pixel" : "verification__canvas"} />
            {options.mode === "3d" && <p>左ドラッグで回転、右ドラッグで移動、ホイールでズーム。</p>}
            <fieldset className="verification__controls" disabled={isBusy}>
                <legend>保存・出力の検証</legend>
                <button type="button" onClick={() => void runFrameAction("export")}>透過PNGを出力</button>
                <button type="button" onClick={() => void runFrameAction("save")}>ブラウザに保存</button>
                <button type="button" onClick={() => void runFrameAction("restore")}>保存データを復元</button>
            </fieldset>
            {status && <p role="status">{status}</p>}
            {actionError && <p role="alert">{actionError}</p>}
            {imageUrl && (
                <figure className="verification__saved-image">
                    <figcaption>保存された透過PNG</figcaption>
                    <img src={imageUrl} alt="保存されたパーティクル画像" />
                </figure>
            )}
        </main>
    );
}
