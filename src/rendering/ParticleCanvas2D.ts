import type { Project2D } from "../core/particles/evaluate2D.ts";
import { evaluateParticles2D } from "../core/particles/evaluate2D.ts";

export type PreviewQuality = "accurate" | "light";
const LIGHT_PARTICLE_LIMIT = 1000; // 軽量表示で描く最大サンプル数

/** 2Dシミュレーションの結果をCanvasに描き、ピクセル描画用バッファを所有する。 */
export class ParticleCanvas2D {
    private readonly _canvas: HTMLCanvasElement; // 表示先
    private readonly _buffer = document.createElement("canvas"); // 低解像度描画用
    private _disposed = false; // 解放後の描画を防ぐ

    ////////////////////
    // Canvasを描画先として受け取る
    public constructor(canvas: HTMLCanvasElement) { this._canvas = canvas; }

    ////////////////////
    // 指定時刻を描画し、負荷表示に使う粒子数を返す
    public draw(project: Project2D, timeUs: number, quality: PreviewQuality,
        images: ReadonlyMap<string, ImageBitmap> = new Map()): { total: number; drawn: number } {
        if (this._disposed) throw new Error("描画資源は解放済みです。");
        const factor = project.drawing === "pixel" ? project.pixelScale : 1; // 保存された整数倍率
        const width = Math.ceil(project.canvasWidth/factor), height = Math.ceil(project.canvasHeight/factor); // 論理解像度
        if (this._canvas.width !== project.canvasWidth) this._canvas.width = project.canvasWidth;
        if (this._canvas.height !== project.canvasHeight) this._canvas.height = project.canvasHeight;
        if (this._buffer.width !== width) this._buffer.width = width;
        if (this._buffer.height !== height) this._buffer.height = height;
        const ctx = this._buffer.getContext("2d")!; // 粒子を描くバッファ
        ctx.clearRect(0, 0, width, height);
        let total = 0, drawn = 0; // 正確な粒子数とプレビュー描画数
        for (const layer of [...project.layers].sort((a,b) => a.order-b.order)) {
            if (!layer.isVisible || layer.content.kind !== "emitter") continue;
            const emitterId = layer.content.emitterId; // 発生器への参照
            const emitter = project.emitters.find((item) => item.id.toLowerCase() === emitterId.toLowerCase())!; // 検証済み発生器
            const material = project.materials.find((item) => item.id.toLowerCase() === emitter.materialId.toLowerCase())!; // 検証済み材質
            const samples = evaluateParticles2D(project, layer.id, timeUs); // 品質に依存しない正確な評価
            total += samples.length;
            const stride = quality === "light" ? Math.max(1, Math.ceil(samples.length/LIGHT_PARTICLE_LIMIT)) : 1; // 表示だけを間引く
            const texture = material.textureAssetId ? images.get(material.textureAssetId.toLowerCase()) : undefined; // デコード済み素材
            ctx.globalCompositeOperation = material.blend === "additive" ? "lighter" : "source-over";
            ctx.globalAlpha = layer.values.opacity;
            ctx.fillStyle = "white";
            for (let index=0; index<samples.length; index+=stride) {
                const sample = samples[index]!; // 描く粒子
                const x = sample.position[0]/factor, y = sample.position[1]/factor; // ピクセル倍率を反映
                if (texture) ctx.drawImage(texture, x-4/factor, y-4/factor, 8/factor, 8/factor);
                else { ctx.beginPath(); ctx.arc(x,y,Math.max(0.5,3/factor),0,Math.PI*2); ctx.fill(); }
                drawn++;
            }
        }
        const display = this._canvas.getContext("2d")!; // 表示用の拡大先
        display.clearRect(0,0,this._canvas.width,this._canvas.height);
        display.imageSmoothingEnabled = false;
        // 余りピクセルで非整数拡大にならないよう、整数倍率で描いて端をクリップする。
        display.drawImage(this._buffer,0,0,width*factor,height*factor);
        return { total, drawn };
    }

    ////////////////////
    // バッファを解放する
    public dispose(): void {
        this._disposed = true;
        this._buffer.width = this._buffer.height = 0;
    }
}
