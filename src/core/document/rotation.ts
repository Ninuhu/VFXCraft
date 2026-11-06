import type { Quaternion, Vec3 } from "./model.ts";

const HALF_TURN_DEGREES = 180; // ラジアン変換の基準角（度）
const SLERP_EPSILON = 1e-7; // 球面補間の分母が不安定になる境界
const EULER_SINGULARITY_EPSILON = 1e-12; // XYZ逆変換でZを固定する特異点の近傍

////////////////////
// 有限・非ゼロのQuaternionを、成分の二乗があふれない方法で正規化する
export function normalizeQuaternion(value: Quaternion): Quaternion {
    if (!value.every(Number.isFinite)) throw new RangeError("Quaternionに非有限値があります。");
    const scale = Math.max(...value.map(Math.abs)); // 長さの計算前に成分を縮小する基準
    if (scale === 0) throw new RangeError("ゼロ長Quaternionは使用できません。");
    const [x, y, z, w] = value; // 入力の四成分
    const length = Math.hypot(x / scale, y / scale, z / scale, w / scale); // 縮小後の長さ
    return [x / scale / length, y / scale / length, z / scale / length, w / scale / length];
}

////////////////////
// 内因性XYZ順の度数入力を保存用Quaternionへ変換する
export function quaternionFromEulerXyzDegrees(degrees: Vec3): Quaternion {
    if (!degrees.every(Number.isFinite)) throw new RangeError("回転角に非有限値があります。");
    const factor = Math.PI / (2 * HALF_TURN_DEGREES); // 度から半角ラジアンへの倍率
    const [x, y, z] = degrees; // 各ローカル軸の角度
    const [sx, sy, sz] = [Math.sin(x * factor), Math.sin(y * factor), Math.sin(z * factor)]; // 半角の正弦
    const [cx, cy, cz] = [Math.cos(x * factor), Math.cos(y * factor), Math.cos(z * factor)]; // 半角の余弦
    return normalizeQuaternion([
        sx * cy * cz + cx * sy * sz,
        cx * sy * cz - sx * cy * sz,
        cx * cy * sz + sx * sy * cz,
        cx * cy * cz - sx * sy * sz,
    ]);
}

////////////////////
// 保存姿勢を内因性XYZの表示用角度へ変換し、特異点ではZを0に固定する
export function eulerXyzDegreesFromQuaternion(value: Quaternion): Vec3 {
    const [x, y, z, w] = normalizeQuaternion(value); // 回転行列を作る単位Quaternion
    const m13 = Math.max(-1, Math.min(1, 2 * (x * z + w * y))); // Y角の正弦。丸めで範囲を超えないよう制限
    const pitch = Math.asin(m13); // Y軸の角度（rad）
    const factor = HALF_TURN_DEGREES / Math.PI; // ラジアンから度への倍率
    if (Math.abs(m13) >= 1 - EULER_SINGULARITY_EPSILON) {
        const roll = Math.atan2(2 * (y * z + w * x), 1 - 2 * (x * x + z * z)); // XとZを一意に分けられない場合のX角
        return [roll * factor, pitch * factor, 0];
    }
    const roll = Math.atan2(2 * (w * x - y * z), 1 - 2 * (x * x + y * y)); // X軸の角度（rad）
    const yaw = Math.atan2(2 * (w * z - x * y), 1 - 2 * (y * y + z * z)); // Z軸の角度（rad）
    return [roll * factor, pitch * factor, yaw * factor];
}

////////////////////
// 正規化済みの姿勢を最短経路で補間し、同じ姿勢の符号差を吸収する
export function slerpQuaternion(from: Quaternion, to: Quaternion, amount: number): Quaternion {
    const dot = from[0] * to[0] + from[1] * to[1] + from[2] * to[2] + from[3] * to[3]; // 姿勢の内積
    const sign = dot < 0 ? -1 : 1; // 同じ半球に揃える符号
    const angle = Math.acos(Math.min(1, Math.abs(dot))); // 補間する弧の角度
    const sine = Math.sin(angle); // 球面補間の分母
    // ほぼ同一の姿勢では分母が小さくなるため、正規化した線形補間に切り替える。
    const left = sine <= SLERP_EPSILON ? 1 - amount : Math.sin((1 - amount) * angle) / sine; // 開始側の重み
    const right = sign * (sine <= SLERP_EPSILON ? amount : Math.sin(amount * angle) / sine); // 終了側の重み
    return normalizeQuaternion([
        from[0] * left + to[0] * right,
        from[1] * left + to[1] * right,
        from[2] * left + to[2] * right,
        from[3] * left + to[3] * right,
    ]);
}
