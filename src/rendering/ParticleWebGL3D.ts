import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Float32BufferAttribute, Mesh, Scene, ShaderMaterial, WebGLRenderer } from "three";
import { evaluateParticles3D, type Project3D, type ParticleSample3D } from "../core/particles/evaluate3D.ts";
import { Camera3D } from "./Camera3D.ts";
import { fillParticleVertices, sortParticles3D } from "./particleDrawData3D.ts";

export type Frame3DStats = { count: number; simulationMs: number; sortMs: number; buildMs: number; submitMs: number;
    bufferBytes: number; geometries: number; textures: number; calls: number };

/** 全レイヤーを横断した粒子順で一つの再利用バッファを描画する。 */
export class ParticleWebGL3D {
    public readonly view = new Camera3D(); // UIと独立したカメラ状態
    private readonly _renderer: WebGLRenderer; // GPUとCanvasの所有者
    private readonly _geometry = new BufferGeometry(); // 再利用する描画データ
    private readonly _scene = new Scene(); // 単一Meshのシーン
    private readonly _material = new ShaderMaterial({
        transparent: true, depthWrite: false,
        vertexShader: `attribute vec4 tint; varying vec4 vTint;
            void main() { vTint=tint; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
        fragmentShader: `varying vec4 vTint;
            void main() { gl_FragColor=vTint;
                #include <colorspace_fragment>
            }`,
    }); // 基本アルファ合成。T07のマテリアル拡張は後続
    private _positions = new Float32Array(0); // 頂点座標のCPUバッファ
    private _colors = new Float32Array(0); // RGBAのCPUバッファ
    private _capacity = 0; // 最大同時描画数の確保容量
    private _disposed = false; // 二重解放・再描画の防止
    private _samples: ParticleSample3D[] = []; // 現在時刻の全体表示対象

    ////////////////////
    // GPU描画と基本の透明シーンを初期化する
    public constructor(canvas: HTMLCanvasElement) {
        this._renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true });
        this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        const mesh = new Mesh(this._geometry, this._material); // 全粒子の順序が一つの描画呼出しで保証される
        mesh.frustumCulled = false;
        this._scene.add(mesh);
        this.resize(640, 360);
    }

    ////////////////////
    // Canvasの表示領域とカメラの画角を同期する
    public resize(width: number, height: number): void {
        this.view.resize(width, height);
        this._renderer.setSize(width, height, false);
    }

    ////////////////////
    // 必要なときだけ容量を増やし、旧GPUバッファを破棄する
    private reserve(count: number): void {
        if (count <= this._capacity) return;
        this._capacity = Math.max(count, this._capacity * 2, 128);
        this._positions = new Float32Array(this._capacity * 18);
        this._colors = new Float32Array(this._capacity * 24);
        this._geometry.dispose();
        this._geometry.setAttribute("position", new Float32BufferAttribute(this._positions, 3).setUsage(DynamicDrawUsage));
        this._geometry.setAttribute("tint", new Float32BufferAttribute(this._colors, 4).setUsage(DynamicDrawUsage));
        // BufferAttributeが保持する配列を以後の書込先に揃える。
        this._positions = this._geometry.getAttribute("position").array as Float32Array<ArrayBuffer>;
        this._colors = this._geometry.getAttribute("tint").array as Float32Array<ArrayBuffer>;
    }

    ////////////////////
    // 評価、全体ソート、頂点構築、描画投入を別々のCPU時間として計測する
    public draw(project: Project3D, timeUs: number): Frame3DStats {
        if (this._disposed) throw new Error("描画器は解放済みです。");
        const start = performance.now(); // 評価開始
        this._samples = evaluateParticles3D(project, timeUs);
        const evaluated = performance.now(); // 評価完了
        const camera = this.view.basis(); // 現在のカメラ基底
        const sorted = sortParticles3D(this._samples, camera); // 全レイヤーの透明描画順
        const ordered = performance.now(); // ソート完了
        this.reserve(Math.max(1, sorted.length));
        fillParticleVertices(sorted, camera, this._positions, this._colors);
        this._geometry.setDrawRange(0, sorted.length * 6);
        for (const name of ["position", "tint"]) {
            const attribute = this._geometry.getAttribute(name); // 転送する属性
            if (attribute instanceof BufferAttribute) {
                attribute.clearUpdateRanges();
                attribute.addUpdateRange(0, sorted.length * (name === "position" ? 18 : 24));
                attribute.needsUpdate = true;
            }
        }
        const built = performance.now(); // 頂点データ構築完了
        this._renderer.render(this._scene, this.view.camera);
        const submitted = performance.now(); // GPU転送指示と描画指示のCPU時間
        return { count: sorted.length, simulationMs: evaluated - start, sortMs: ordered - evaluated, buildMs: built - ordered,
            submitMs: submitted - built, bufferBytes: this._positions.byteLength + this._colors.byteLength,
            geometries: this._renderer.info.memory.geometries, textures: this._renderer.info.memory.textures,
            calls: this._renderer.info.render.calls };
    }

    ////////////////////
    // 最後に評価したプレイヘッド時刻の粒子を全体表示する
    public frame(): boolean { return this.view.frame(this._samples); }

    ////////////////////
    // 別モードを開いた場合は前の3D画像と全体表示対象を残さない
    public clear(): void {
        this._samples = [];
        this._renderer.clear();
    }

    ////////////////////
    // GPUのエラー状態を検証UIとテストへ公開する
    public get glError(): number { return this._renderer.getContext().getError(); }

    ////////////////////
    // 直前の描画結果の中心画素を読み、透明ソートを実GPU描画で検証する
    public readCenterPixel(): Uint8Array {
        const context = this._renderer.getContext(); // 描画直後のバッファ
        const pixel = new Uint8Array(4); // RGBAの実測値
        context.readPixels(Math.floor(context.drawingBufferWidth / 2), Math.floor(context.drawingBufferHeight / 2),
            1, 1, context.RGBA, context.UNSIGNED_BYTE, pixel);
        return pixel;
    }

    ////////////////////
    // 再マウント時もGPUとバッファを解放する
    public dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        this._geometry.dispose();
        this._material.dispose();
        this._renderer.dispose();
        // Canvasのコンテキストはブラウザが所有する。StrictModeの再マウントで再利用するため強制喪失しない。
        this._samples = [];
        this._positions = new Float32Array(0);
        this._colors = new Float32Array(0);
    }
}
