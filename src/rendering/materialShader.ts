import { AddEquation, CustomBlending, DataTexture, DstColorFactor, LinearFilter, NearestFilter,
    NormalBlending, OneFactor, OneMinusSrcAlphaFactor, ShaderMaterial, SrcAlphaFactor, SRGBColorSpace, Texture, Vector2 } from "three";
import type { Material } from "../core/document/model.ts";
import { DEFAULT_APPEARANCE, evaluateGradient } from "../core/materials/materialEvaluation.ts";

const GRADIENT_RESOLUTION = 256; // 半径0〜1をサンプリングするテクスチャの幅

/** 一つの材質のGPU設定とテクスチャを所有する。 */
export class ParticleSurface {
    public readonly body: ShaderMaterial; // 背景へのマテリアル合成
    public readonly emission: ShaderMaterial; // 背景を含まない発光源
    private readonly _image?: Texture; // デコード済みBitmapのGPU側の所有物
    private readonly _gradient: DataTexture; // 線形色と独立アルファの空間グラデーション

    ////////////////////
    // 旧版の見た目を保ち、新しい材質だけに空間方向の設定を適用する
    public constructor(material: Material, bitmap: ImageBitmap | undefined, mode: "2d" | "3d") {
        const appearance = material.appearance ?? DEFAULT_APPEARANCE; // 旧版で発光を増やさない
        const pixels = new Uint8Array(GRADIENT_RESOLUTION * 4); // GPUへ渡すグラデーション表
        for (let index = 0; index < GRADIENT_RESOLUTION; index++) {
            pixels.set(evaluateGradient(appearance.spatial, index / (GRADIENT_RESOLUTION - 1))
                .map((value) => Math.round(value * 255)), index * 4);
        }
        this._gradient = new DataTexture(pixels, GRADIENT_RESOLUTION, 1);
        this._gradient.minFilter = this._gradient.magFilter = LinearFilter;
        this._gradient.needsUpdate = true;
        if (bitmap) {
            this._image = new Texture(bitmap);
            this._image.colorSpace = SRGBColorSpace;
            this._image.minFilter = this._image.magFilter = NearestFilter;
            this._image.generateMipmaps = false;
            this._image.needsUpdate = true;
        }
        const blend = mode === "3d" && !material.appearance ? "alpha" : material.blend; // 旧3Dは通常合成
        const uniforms = { spatial: { value: this._gradient }, imageMap: { value: this._image },
            imageSize: { value: new Vector2(bitmap?.width ?? 1, bitmap?.height ?? 1) },
            textured: { value: Boolean(bitmap) }, roundParticle: { value: !bitmap && (mode === "2d" || Boolean(material.appearance)) },
            bloomStrength: { value: appearance.bloomStrength }, threshold: { value: 0.5 } }; // 二つのパスで共通の入力
        const source = {
            transparent: true, depthWrite: false, depthTest: false, forceSinglePass: true,
            vertexShader: VERTEX_SHADER, fragmentShader: FRAGMENT_SHADER, uniforms,
        }; // 一度決めた順序を深度テストで変えない
        this.body = new ShaderMaterial({ ...source, defines: blend === "multiply" ? { MULTIPLY: 1 } : {},
            blending: blend === "alpha" ? NormalBlending : CustomBlending,
            blendEquation: AddEquation, blendSrc: blend === "multiply" ? DstColorFactor : SrcAlphaFactor,
            blendDst: blend === "multiply" ? OneMinusSrcAlphaFactor : OneFactor,
            blendEquationAlpha: AddEquation, blendSrcAlpha: OneFactor, blendDstAlpha: OneMinusSrcAlphaFactor });
        this.emission = new ShaderMaterial({ ...source, defines: { EMISSION: 1 }, blending: CustomBlending,
            blendEquation: AddEquation, blendSrc: OneFactor, blendDst: OneFactor,
            blendEquationAlpha: AddEquation, blendSrcAlpha: OneFactor, blendDstAlpha: OneFactor });
    }

    ////////////////////
    // GPUのプログラムとテクスチャを解放する。元のBitmapは呼び出し元が所有する
    public dispose(): void {
        this.body.dispose();
        this.emission.dispose();
        this._gradient.dispose();
        this._image?.dispose();
    }
}

const VERTEX_SHADER = `
attribute vec4 tint;
varying vec4 vTint;
varying vec2 vUv;
void main() {
    vTint = tint;
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`; // T06と同じ板の頂点に材質用UVを追加

const FRAGMENT_SHADER = `
varying vec4 vTint;
varying vec2 vUv;
uniform sampler2D spatial;
uniform sampler2D imageMap;
uniform vec2 imageSize;
uniform bool textured;
uniform bool roundParticle;
uniform float bloomStrength;
uniform float threshold;
// 透明画素のRGBが輪郭へ漏れないよう、線形色をアルファで重み付けして補間する。
vec4 readImagePixel(vec2 p) {
    vec4 value = texture2D(imageMap, (p + 0.5) / imageSize);
    return vec4(value.rgb * value.a, value.a);
}
vec4 sampleImage(vec2 uvPosition) {
    vec2 texel = uvPosition * imageSize - 0.5;
    vec2 lower = floor(texel);
    vec2 weight = fract(texel);
    vec4 upperRow = mix(readImagePixel(lower), readImagePixel(lower + vec2(1.0, 0.0)), weight.x);
    vec4 lowerRow = mix(readImagePixel(lower + vec2(0.0, 1.0)), readImagePixel(lower + 1.0), weight.x);
    vec4 value = mix(upperRow, lowerRow, weight.y);
    return vec4(value.a > 0.0 ? value.rgb / value.a : vec3(0.0), value.a);
}
void main() {
    float radial = length(vUv * 2.0 - 1.0);
    if (roundParticle && radial > 1.0) discard;
    vec4 localTint = texture2D(spatial, vec2((clamp(radial, 0.0, 1.0) * 255.0 + 0.5) / 256.0, 0.5));
    vec4 rgba = vTint * localTint;
    if (textured) rgba *= sampleImage(vUv);
    if (rgba.a <= 0.0) discard;
    #ifdef EMISSION
        float peak = max(rgba.r, max(rgba.g, rgba.b));
        if (bloomStrength <= 0.0 || peak <= threshold) discard;
        rgba.a *= (bloomStrength / (1.0 + bloomStrength)) * (peak - threshold) / max(1.0 - threshold, 0.0001);
    #endif
    gl_FragColor = rgba;
    #include <colorspace_fragment>
    #if defined(MULTIPLY) || defined(EMISSION)
        gl_FragColor.rgb *= gl_FragColor.a;
    #endif
}`; // テクスチャを線形色で評価し、画面色に戻してから各合成方式を適用
