export type Emission = "continuous" | "burst";

export const PARTICLE_COUNT = 64; // プレビューに確保する粒子スロット数
export const CYCLE_SECONDS = 2; // 検証シーンの反復間隔（秒）
const LIFETIME_SECONDS = 1.45; // 粒子の寿命（秒）
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // 円周方向の偏りを抑える角度（rad）

////////////////////
// 経過秒から粒子の位置と強度を直接評価し、描画FPSへの依存を避ける
export function evaluateParticle(index: number, seconds: number, emission: Emission, is3d: boolean, particleCount = PARTICLE_COUNT) {
    const phase = seconds % CYCLE_SECONDS; // 検証シーン内の時刻（秒）
    const birth = emission === "burst" ? 0 : (index / particleCount) * CYCLE_SECONDS; // 発生時刻（秒）
    const age = (phase - birth + CYCLE_SECONDS) % CYCLE_SECONDS; // 前周期も考慮した寿命内時間（秒）
    const progress = age / LIFETIME_SECONDS; // 寿命に対する進行率
    const angle = index * GOLDEN_ANGLE; // 粒子ごとの発生方向（rad）
    const distance = age * (0.65 + (index % 7) * 0.16); // 検証空間での移動距離
    return {
        isVisible: progress < 1 && (emission === "burst" || seconds >= birth),
        x: Math.cos(angle) * distance,
        y: Math.sin(angle) * distance,
        z: is3d ? Math.sin(index * 1.7) * distance : 0,
        opacity: Math.max(0, 1 - progress),
    };
}
