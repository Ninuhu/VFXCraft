import { PerspectiveCamera, Vector3 } from "three";
import type { CameraBasis } from "./particleDrawData3D.ts";
import type { ParticleSample3D } from "../core/particles/evaluate3D.ts";

const MIN_DISTANCE = 0.01; // カメラの最小距離
const MAX_DISTANCE = 1_000_000; // 異常な距離への移動を防ぐ技術上限

/** カメラの姿勢・注視点・表示範囲を管理し、編集文書から分離する。 */
export class Camera3D {
    public readonly camera = new PerspectiveCamera(45, 16 / 9, 0.001, 10_000_000); // プレビューカメラ
    public readonly target = new Vector3(); // Orbitの中心

    ////////////////////
    // 固定の初期視点で開始する
    public constructor() { this.reset(); }

    ////////////////////
    // 固定視点へ戻す。エフェクトのBoundsに依存しない
    public reset(): void {
        this.target.set(0, 0, 0);
        this.camera.position.set(4, 3, 6);
        this.update();
    }

    ////////////////////
    // 描画領域のアスペクト比を反映する
    public resize(width: number, height: number): void {
        if (![width, height].every((value) => Number.isFinite(value) && value > 0)) throw new RangeError("画面サイズが不正です。");
        const aspect = width / height; // 極端な比率による射影行列の退化を防ぐ
        if (!Number.isFinite(aspect) || aspect < 0.0001 || aspect > 10000) throw new RangeError("画面の縦横比が安全範囲を超えています。");
        this.camera.aspect = aspect;
        this.camera.updateProjectionMatrix();
    }

    ////////////////////
    // 不正操作値を拒否し、Orbitの極とズーム距離を制限する
    public orbit(deltaX: number, deltaY: number): void {
        if (![deltaX, deltaY].every(Number.isFinite)) throw new RangeError("カメラ操作値が不正です。");
        const offset = this.camera.position.clone().sub(this.target); // 現在の相対位置
        const radius = offset.length(); // 注視点までの距離
        if (!Number.isFinite(radius) || radius < MIN_DISTANCE / 2) throw new RangeError("カメラの距離が不正です。");
        const theta = Math.atan2(offset.x, offset.z) + Math.max(-Math.PI, Math.min(Math.PI, deltaX)); // 水平回転
        const phi = Math.max(0.001, Math.min(Math.PI - 0.001, Math.acos(offset.y / radius) + Math.max(-Math.PI, Math.min(Math.PI, deltaY)))); // 極の反転防止
        this.camera.position.set(Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta)).multiplyScalar(radius).add(this.target);
        this.update();
    }

    ////////////////////
    // カメラの画面基底に沿って距離比例の平行移動を行う
    public pan(x: number, y: number): void {
        if (![x, y].every(Number.isFinite)) throw new RangeError("カメラ操作値が不正です。");
        const basis = this.basis(); // カメラに対する右・上方向
        const distance = this.camera.position.distanceTo(this.target); // 操作感の基準距離
        const movement = new Vector3(...basis.right).multiplyScalar(Math.max(-1, Math.min(1, x)) * distance)
            .addScaledVector(new Vector3(...basis.up), Math.max(-1, Math.min(1, y)) * distance); // 画面上の移動
        if (this.target.clone().add(movement).length() > MAX_DISTANCE) throw new RangeError("注視点が操作範囲を超えています。");
        this.target.add(movement);
        this.camera.position.add(movement);
        this.update();
    }

    ////////////////////
    // 指数的なズームを距離上限内で適用する
    public zoom(amount: number): void {
        if (!Number.isFinite(amount)) throw new RangeError("ズーム値が不正です。");
        const offset = this.camera.position.clone().sub(this.target); // 注視点からの位置
        const distance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, offset.length() * Math.exp(Math.max(-4, Math.min(4, amount))))); // 滑らかな距離変化
        this.camera.position.copy(offset.normalize().multiplyScalar(distance).add(this.target));
        this.update();
    }

    ////////////////////
    // 現在時刻の粒子群を幅・高さを含む球で包み、狭い方の画角に収める
    public frame(samples: readonly ParticleSample3D[]): boolean {
        if (samples.length === 0) return false;
        const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity); // 包含Bounds
        for (const sample of samples) {
            const extent = Math.hypot(sample.width, sample.height) / 2; // ビルボードの回転を問わず含む半径
            if (![...sample.position, extent, sample.width, sample.height].every(Number.isFinite) || sample.width < 0 || sample.height < 0 || extent > MAX_DISTANCE) throw new RangeError("Boundsが不正です。");
            min.min(new Vector3(...sample.position).addScalar(-extent));
            max.max(new Vector3(...sample.position).addScalar(extent));
        }
        const center = min.clone().add(max).multiplyScalar(0.5); // 全体中心
        const radius = Math.max(0.01, max.distanceTo(min) / 2); // 全体の包含球
        const vertical = this.camera.fov * Math.PI / 360; // 垂直半画角
        const angle = Math.min(vertical, Math.atan(Math.tan(vertical) * this.camera.aspect)); // 水平半画角も考慮
        const distance = 1.1 * radius / Math.sin(angle); // 余白付きの包含距離
        if (!Number.isFinite(distance) || distance > MAX_DISTANCE || center.length() > MAX_DISTANCE) throw new RangeError("Boundsが表示可能な範囲を超えています。");
        const direction = this.camera.position.clone().sub(this.target).normalize(); // 現在の視点方向を維持
        this.target.copy(center);
        this.camera.position.copy(direction.multiplyScalar(distance).add(center));
        this.update();
        return true;
    }

    ////////////////////
    // 行列を更新し、描画・ソートに使う有限のカメラ基底を返す
    public basis(): CameraBasis {
        this.update();
        const matrix = this.camera.matrixWorld.elements; // カメラのワールド基底
        return { position: [matrix[12]!, matrix[13]!, matrix[14]!], right: [matrix[0]!, matrix[1]!, matrix[2]!],
            up: [matrix[4]!, matrix[5]!, matrix[6]!], forward: [-matrix[8]!, -matrix[9]!, -matrix[10]!] };
    }

    ////////////////////
    // 注視点との整合を維持し、不正な行列を拒否する
    private update(): void {
        if (![...this.camera.position.toArray(), ...this.target.toArray()].every(Number.isFinite)) throw new RangeError("カメラ状態が不正です。");
        this.camera.lookAt(this.target);
        this.camera.updateMatrixWorld(true);
    }
}
