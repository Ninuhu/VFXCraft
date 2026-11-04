import {
    ACESFilmicToneMapping, AdditiveBlending, CanvasTexture, Color, LinearFilter,
    NearestFilter, NormalBlending, OrthographicCamera, PerspectiveCamera, Scene,
    Sprite, SpriteMaterial, SRGBColorSpace, Vector2, WebGLRenderer, type BufferGeometry,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { evaluateParticle, PARTICLE_COUNT, type Emission } from "./evaluateParticles";

export type PreviewMode = "2d" | "pixel" | "3d";
export type PreviewOptions = {
    mode: PreviewMode;
    emission: Emission;
    isAdditive: boolean;
    hasBloom: boolean;
    isPlaying: boolean;
};

const WIDTH = 640; // 検証用の通常描画幅（px）
const HEIGHT = 360; // 検証用の通常描画高（px）
const PIXEL_SCALE = 4; // ピクセルモードの内部解像度を下げる倍率
const TEXTURE_SIZE = 32; // 自作粒子テクスチャの辺長（px）
const BACKGROUND = 0x12101b; // Bloom比較用の不透明な背景色

////////////////////
// 透明な縁を持つ粒子画像を生成する
function createParticleTexture() {
    const canvas = document.createElement("canvas"); // 素材生成専用のキャンバス
    canvas.width = canvas.height = TEXTURE_SIZE;
    const context = canvas.getContext("2d"); // 画像生成に使う2Dコンテキスト
    if (!context) throw new Error("粒子画像の生成に失敗しました。");
    const center = TEXTURE_SIZE / 2; // 円形グラデーションの中心と半径（px）
    const gradient = context.createRadialGradient(center, center, 0, center, center, center); // 透明度分布
    gradient.addColorStop(0, "#ffffff");
    gradient.addColorStop(0.35, "#ffffffb0");
    gradient.addColorStop(1, "#ffffff00");
    context.fillStyle = gradient;
    context.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
    const texture = new CanvasTexture(canvas); // 全ビルボードで共有する画像
    texture.colorSpace = SRGBColorSpace;
    return texture;
}

/** 検証用シーンの描画・入力・GPU資源の寿命を管理する。 */
export class WebGlPreview {
    private readonly _renderer: WebGLRenderer; // キャンバスの描画器
    private readonly _scene = new Scene(); // 粒子の検証シーン
    private readonly _camera2d = new OrthographicCamera(-3.55, 3.55, 2, -2, 0.1, 50); // 2D用正射影
    private readonly _camera3d = new PerspectiveCamera(45, WIDTH / HEIGHT, 0.1, 50); // 3D用透視投影
    private readonly _controls: OrbitControls; // 3D用カメラ操作
    private readonly _texture: CanvasTexture; // 全粒子が共有する自作画像
    private readonly _particles: Sprite[] = []; // 再利用するビルボード
    private _geometry: BufferGeometry | undefined; // この描画器が所有する共有ジオメトリ
    private readonly _composer: EffectComposer; // Bloom用の描画ターゲット
    private readonly _renderPass: RenderPass; // カメラからシーンを描画する段階
    private readonly _bloom: UnrealBloomPass; // 発光抽出とぼかし
    private readonly _output = new OutputPass(); // 画面表示への色変換
    private _mode: PreviewMode | undefined; // 前回の解像度・カメラ設定
    private _isAdditive: boolean | undefined; // 前回の合成設定

    ////////////////////
    // 共有素材と固定数のビルボードを用意する
    constructor(canvas: HTMLCanvasElement) {
        this._texture = createParticleTexture();
        try {
            this._renderer = new WebGLRenderer({ canvas, antialias: false });
        } catch (error) {
            this._texture.dispose();
            throw error;
        }
        this._renderer.toneMapping = ACESFilmicToneMapping;
        this._scene.background = new Color(BACKGROUND);
        this._camera2d.position.z = 6;
        this._camera3d.position.set(2, 1.4, 5);
        this._controls = new OrbitControls(this._camera3d, canvas);
        this._controls.update();
        this._controls.saveState();

        for (let index = 0; index < PARTICLE_COUNT; index++) {
            const color = new Color(index % 2 === 0 ? 0x8e55ff : 0x52e7ff); // 2色で重なりを見分ける
            color.multiplyScalar(2); // 明部を発光しきい値より上へ押し上げる
            const material = new SpriteMaterial({
                map: this._texture, color, transparent: true, depthWrite: false,
            }); // 粒子ごとに強度を変えられる材質
            const sprite = new Sprite(material); // カメラを向く板ポリゴン
            this._geometry ??= sprite.geometry.clone();
            sprite.geometry = this._geometry;
            this._particles.push(sprite);
            this._scene.add(sprite);
        }

        this._composer = new EffectComposer(this._renderer);
        this._renderPass = new RenderPass(this._scene, this._camera2d);
        this._bloom = new UnrealBloomPass(new Vector2(WIDTH, HEIGHT), 1.1, 0.35, 0.45);
        this._composer.addPass(this._renderPass);
        this._composer.addPass(this._bloom);
        this._composer.addPass(this._output);
    }

    ////////////////////
    // 設定に応じて解像度・カメラを選び、指定時刻の粒子を描画する
    public render(seconds: number, options: PreviewOptions): void {
        const is3d = options.mode === "3d"; // 透視投影と奥行きの有無
        const camera = is3d ? this._camera3d : this._camera2d; // 描画用カメラ
        if (this._mode !== options.mode) {
            const scale = options.mode === "pixel" ? PIXEL_SCALE : 1; // 内部解像度の縮小倍率
            const filter = scale === 1 ? LinearFilter : NearestFilter; // 粒子素材の補間方式
            this._texture.minFilter = filter;
            this._texture.magFilter = filter;
            this._texture.needsUpdate = true;
            this._renderer.setSize(WIDTH / scale, HEIGHT / scale, false);
            this._composer.setSize(WIDTH / scale, HEIGHT / scale);
            this._controls.enabled = is3d;
            this._renderPass.camera = camera;
            this._mode = options.mode;
        }

        for (const [index, sprite] of this._particles.entries()) {
            const particle = evaluateParticle(index, seconds, options.emission, is3d); // 同一時刻の粒子状態
            if (this._isAdditive !== options.isAdditive) {
                sprite.material.blending = options.isAdditive ? AdditiveBlending : NormalBlending;
            }
            sprite.visible = particle.isVisible;
            sprite.material.opacity = particle.opacity;
            sprite.position.set(particle.x, particle.y, particle.z);
            sprite.scale.setScalar(0.12 + particle.opacity * 0.26);
        }
        this._isAdditive = options.isAdditive;
        if (options.hasBloom) this._composer.render();
        else this._renderer.render(this._scene, camera);
    }

    ////////////////////
    // カメラを開始時の視点へ戻す
    public resetCamera(): void {
        this._controls.reset();
    }

    ////////////////////
    // 所有する入力リスナーとGPU資源を解放する
    public dispose(): void {
        this._controls.dispose();
        for (const sprite of this._particles) sprite.material.dispose();
        this._geometry?.dispose();
        this._scene.clear();
        this._texture.dispose();
        this._renderPass.dispose();
        this._bloom.dispose();
        this._output.dispose();
        this._composer.dispose();
        this._renderer.dispose();
        // Reactの開発時再マウントは同じキャンバスを再利用するため、コンテキストは強制喪失させない。
    }
}
