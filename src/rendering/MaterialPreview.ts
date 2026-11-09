import { BufferAttribute, BufferGeometry, CanvasTexture, DynamicDrawUsage, Mesh, OrthographicCamera,
    Scene, SRGBColorSpace, WebGLRenderer, type ShaderMaterial } from "three";
import type { BackgroundSettings, Material, Project } from "../core/document/model.ts";
import { DEFAULT_PREVIEW, resolveBackground } from "../core/materials/materialEvaluation.ts";
import type { ParticleSample3D } from "../core/particles/evaluate3D.ts";
import { Camera3D } from "./Camera3D.ts";
import { ParticleSurface } from "./materialShader.ts";
import { collectMaterialParticles, SCREEN_BASIS, tintMaterialParticles } from "./materialParticleData.ts";
import { fillParticleVertices, sortParticles3D } from "./particleDrawData3D.ts";
import { compositeBloom, paintBackground } from "./previewComposite.ts";

const UV = [0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0]; // ImageBitmapは上端を0としてアップロードする
const VERTICES_PER_PARTICLE = 6;
const MAX_REVIEW_DIMENSION = 2048; // 検証画面でのGPUターゲットの上限

export type MaterialFrameOptions = { background?: BackgroundSettings; light: boolean;
    images: ReadonlyMap<string, ImageBitmap> };
export type MaterialFrameStats = { count: number; calls: number; simulationMs: number; sortMs: number; prepareMs: number;
    bodyMs: number; bloomMs: number; bufferBytes: number; textures: number };
type SurfaceEntry = { material: Material; bitmap: ImageBitmap | undefined; mode: Project["mode"]; surface: ParticleSurface };

/** T07の2D・3Dプレビューの描画バッファを管理し、本体と発光を別々に描画する。 */
export class MaterialPreview {
    public readonly view = new Camera3D(); // 3Dの操作対象
    private readonly _screenCamera = new OrthographicCamera(0, 1, 0, 1, 0.1, 10); // 2Dの左上原点
    private readonly _gl = new WebGLRenderer({ alpha: true, antialias: false }); // 本体と発光で再利用するGPUターゲット
    private readonly _scene = new Scene();
    private readonly _geometry = new BufferGeometry();
    private readonly _mesh = new Mesh<BufferGeometry, ShaderMaterial[]>(this._geometry, []);
    private readonly _background = document.createElement("canvas"); // プレビュー背景の画素
    private readonly _backgroundTexture = new CanvasTexture(this._background);
    private readonly _blur = document.createElement("canvas"); // 発光のぼかし先
    private readonly _output: CanvasRenderingContext2D; // 本体と発光の表示先
    private readonly _surfaces = new Map<string, SurfaceEntry>(); // 現在の文書に必要な材質資源
    private _backgroundKey = ""; // 背景の再転送を避ける
    private _positions = new Float32Array(0); // 頂点座標
    private _colors = new Float32Array(0); // Straight RGBA
    private _capacity = 0; // 再利用する粒子容量
    private _samples: ParticleSample3D[] = []; // カメラの全体表示用

    ////////////////////
    // プレビューのCanvasを一つだけ表示側で所有する
    public constructor(canvas: HTMLCanvasElement) {
        this._output = canvas.getContext("2d")!;
        this._screenCamera.position.z = 1;
        this._mesh.frustumCulled = false;
        this._scene.add(this._mesh);
        this._backgroundTexture.colorSpace = SRGBColorSpace;
    }

    ////////////////////
    // 同じ材質・画像が続くフレームではGPU資源をそのまま使う
    private syncSurfaces(project: Project, images: ReadonlyMap<string, ImageBitmap>): SurfaceEntry[] {
        const ids = new Set(project.materials.map((material) => material.id.toLowerCase())); // 有効な材質
        for (const [id, entry] of this._surfaces) {
            if (!ids.has(id)) { entry.surface.dispose(); this._surfaces.delete(id); }
        }
        return project.materials.map((material) => {
            const id = material.id.toLowerCase(); // 正規化した参照キー
            const bitmap = material.textureAssetId && (project.mode === "2d" || material.appearance)
                ? images.get(material.textureAssetId.toLowerCase()) : undefined; // 旧3Dは素材未使用
            const existing = this._surfaces.get(id); // 既存資源
            if (existing?.material === material && existing.bitmap === bitmap && existing.mode === project.mode) return existing;
            existing?.surface.dispose();
            const entry = { material, bitmap, mode: project.mode, surface: new ParticleSurface(material, bitmap, project.mode) };
            this._surfaces.set(id, entry);
            return entry;
        });
    }

    ////////////////////
    // 容量が足りないときだけGPUバッファを再確保する
    private reserve(count: number): void {
        if (count <= this._capacity) return;
        this._capacity = Math.max(128, this._capacity * 2, count);
        this._positions = new Float32Array(this._capacity * 18);
        this._colors = new Float32Array(this._capacity * 24);
        const uvs = new Float32Array(this._capacity * UV.length); // 粒子ごとに固定のUV
        for (let index = 0; index < this._capacity; index++) uvs.set(UV, index * UV.length);
        this._geometry.dispose();
        this._geometry.setAttribute("position", new BufferAttribute(this._positions, 3).setUsage(DynamicDrawUsage));
        this._geometry.setAttribute("tint", new BufferAttribute(this._colors, 4).setUsage(DynamicDrawUsage));
        this._geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
        this._geometry.setAttribute("particleBloom", new BufferAttribute(new Float32Array(this._capacity * VERTICES_PER_PARTICLE), 1).setUsage(DynamicDrawUsage));
    }

    ////////////////////
    // 同じ材質が隣接する区間だけをまとめ、3Dの全体深度順を維持する
    private buildGroups(samples: readonly ParticleSample3D[], indices: ReadonlyMap<string, number>): void {
        this._geometry.clearGroups();
        let first = 0; // 現在の区間の先頭
        while (first < samples.length) {
            const id = samples[first]!.materialId.toLowerCase(); // 区間の材質
            let last = first + 1; // 区間の終端
            while (last < samples.length && samples[last]!.materialId.toLowerCase() === id) last++;
            this._geometry.addGroup(first * VERTICES_PER_PARTICLE, (last - first) * VERTICES_PER_PARTICLE, indices.get(id)!);
            first = last;
        }
        this._geometry.setDrawRange(0, samples.length * VERTICES_PER_PARTICLE);
        for (const [name, stride] of [["position", 18], ["tint", 24], ["particleBloom", VERTICES_PER_PARTICLE]] as const) {
            const attribute = this._geometry.getAttribute(name) as BufferAttribute; // 有効な頂点だけを転送する
            attribute.clearUpdateRanges();
            if (samples.length > 0) { attribute.addUpdateRange(0, samples.length * stride); attribute.needsUpdate = true; }
        }
    }

    ////////////////////
    // 現在時刻の粒子を評価し、設定に応じて本体・発光・背景を描画する
    public draw(project: Project, timeUs: number, options: MaterialFrameOptions): MaterialFrameStats {
        const start = performance.now(); // 評価開始
        const preview = project.preview ?? DEFAULT_PREVIEW; // プロジェクト設定の既定値
        const width = project.mode === "2d" ? project.canvasWidth : 640;
        const height = project.mode === "2d" ? project.canvasHeight : 360;
        if (Math.max(width, height) > MAX_REVIEW_DIMENSION) throw new RangeError("T07検証画面の表示上限は2048pxです。");
        const scale = project.mode === "2d" && project.drawing === "pixel" ? project.pixelScale : 1;
        const bodyWidth = Math.ceil(width / scale), bodyHeight = Math.ceil(height / scale); // 整数拡大前の本体解像度
        const target = this._output.canvas; // 表示用Canvas
        if (target.width !== width || target.height !== height) { target.width = width; target.height = height; }
        const surface = this._gl.domElement; // 描画後すぐコピーするWebGL Canvas
        if (surface.width !== bodyWidth || surface.height !== bodyHeight) this._gl.setSize(bodyWidth, bodyHeight, false);
        const perspective = project.mode === "3d"; // 3Dは既存カメラを使用する
        if (perspective) {
            if (this.view.camera.aspect !== width / height) this.view.resize(width, height);
        } else if (this._screenCamera.right !== bodyWidth * scale || this._screenCamera.bottom !== bodyHeight * scale) {
            this._screenCamera.right = bodyWidth * scale;
            this._screenCamera.bottom = bodyHeight * scale;
            this._screenCamera.updateProjectionMatrix();
        }
        const camera = perspective ? this.view.camera : this._screenCamera;
        const basis = perspective ? this.view.basis() : SCREEN_BASIS;
        this._samples = collectMaterialParticles(project, timeUs);
        const evaluated = performance.now(); // シミュレーション完了
        const sorted = perspective ? sortParticles3D(this._samples, basis) : this._samples; // 全レイヤーの順序
        const sortedAt = performance.now(); // ソート完了
        const entries = this.syncSurfaces(project, options.images);
        const indices = new Map(entries.map((entry, index) => [entry.material.id.toLowerCase(), index]));
        const materials = new Map(entries.map((entry) => [entry.material.id.toLowerCase(), entry.material]));
        const ordered = tintMaterialParticles(sorted, materials);
        this.reserve(Math.max(1, ordered.length));
        fillParticleVertices(ordered, basis, this._positions, this._colors);
        const bloom = this._geometry.getAttribute("particleBloom").array as Float32Array; // 頂点に付随する発光値
        const emitting = new Set<string>(); // 発光パスで使用する材質
        ordered.forEach((sample, index) => {
            const strength = sample.bloomStrength ?? 0; // 同じ材質でもレイヤーで異なる
            bloom.fill(strength, index * VERTICES_PER_PARTICLE, (index + 1) * VERTICES_PER_PARTICLE);
            if (strength > 0) emitting.add(sample.materialId.toLowerCase());
        });
        this.buildGroups(ordered, indices);
        const background = options.background ? resolveBackground(options.background, preview.background) : undefined;
        this._scene.background = background ? this._backgroundTexture : null;
        if (background) {
            const key = JSON.stringify([bodyWidth, bodyHeight, background]); // 背景の更新条件
            if (key !== this._backgroundKey) {
                paintBackground(this._background, bodyWidth, bodyHeight, background);
                this._backgroundTexture.needsUpdate = true;
                this._backgroundKey = key;
            }
        }
        const prepared = performance.now(); // 描画順・頂点・設定の準備完了
        this._mesh.material = entries.map((entry) => entry.surface.body);
        this._gl.render(this._scene, camera);
        let calls = this._gl.info.render.calls; // 本体と発光のGPU呼び出し数
        this._output.clearRect(0, 0, width, height);
        this._output.imageSmoothingEnabled = false;
        this._output.drawImage(surface, 0, 0, bodyWidth * scale, bodyHeight * scale);
        const drawn = performance.now(); // WebGLの描画指示と本体Canvasへのコピー完了
        if (emitting.size > 0 && preview.bloom.threshold < 1) {
            for (const entry of entries) {
                entry.surface.emission.uniforms.threshold!.value = preview.bloom.threshold;
                entry.surface.emission.visible = emitting.has(entry.material.id.toLowerCase());
            }
            this._scene.background = null;
            this._mesh.material = entries.map((entry) => entry.surface.emission);
            this._gl.render(this._scene, camera);
            calls += this._gl.info.render.calls;
            const pixel = scale > 1 && preview.pixelBloom === "pixel"; // ピクセル発光だけを低解像度でぼかす
            compositeBloom(this._output, surface, this._blur, pixel ? bodyWidth : width, pixel ? bodyHeight : height,
                pixel ? scale : 1, pixel ? preview.bloom.radius / scale : preview.bloom.radius, options.light);
        }
        return { count: ordered.length, calls, simulationMs: evaluated - start, sortMs: sortedAt - evaluated, prepareMs: prepared - sortedAt,
            bodyMs: drawn - prepared, bloomMs: performance.now() - drawn, textures: this._gl.info.memory.textures,
            bufferBytes: this._positions.byteLength + this._colors.byteLength + this._capacity * (UV.length + VERTICES_PER_PARTICLE) * 4 };
    }

    ////////////////////
    // 現在時刻の粒子群をカメラに収める
    public frame(): boolean { return this.view.frame(this._samples); }

    ////////////////////
    // 検証終了時にWebGLエラーを確認する
    public get glError(): number { return this._gl.getContext().getError(); }

    ////////////////////
    // マウントが所有するGPU資源を解放する
    public dispose(): void {
        for (const entry of this._surfaces.values()) entry.surface.dispose();
        this._surfaces.clear();
        this._backgroundTexture.dispose();
        this._geometry.dispose();
        this._gl.dispose();
        this._gl.forceContextLoss();
        this._blur.width = this._blur.height = 0;
    }
}
