import type { Layer, LayerValues, LinearRgb, Mode, Project, Quaternion, Vec3 } from "./model.ts";
import { layerValuesAt } from "./animation.ts";
import { isNonNegativeSafeInteger } from "./time.ts";
import { normalizeQuaternion } from "./rotation.ts";

export type Matrix = readonly number[]; // 行優先の4×4アフィン行列
export type HierarchyState = { matrix: Matrix; color: LinearRgb; opacity: number; visible: boolean; locked: boolean };
export const IDENTITY_MATRIX: Matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const DECOMPOSITION_TOLERANCE = 1e-8; // 直交性と再構築誤差の許容範囲
const indices = new WeakMap<Project, { layers: Map<string, Layer>; children: Map<string | null, Layer[]> }>(); // 不変文書の参照索引
const frames = new WeakMap<Project, { time: number; states: Map<string, HierarchyState> }>(); // 直近時刻だけを保持し長時間再生で増えない

////////////////////
// 同じ親の子を描画順とIDで安定化し、深い階層は再帰せず扱う
export function hierarchyIndex(project: Project) {
    let index = indices.get(project); // 作成済みの索引
    if (!index) {
        const layers = new Map(project.layers.map((layer) => [layer.id.toLowerCase(), layer])); // UUID参照
        const children = new Map<string | null, Layer[]>(); // 親ごとの子リスト
        for (const layer of project.layers) {
            const key = layer.parentId?.toLowerCase() ?? null; // ルートはnull
            const list = children.get(key) ?? [];
            list.push(layer); children.set(key, list);
        }
        for (const list of children.values()) list.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        index = { layers, children }; indices.set(project, index);
    }
    return index;
}

////////////////////
// 子孫を含むツリーを深さ付きで列挙し、循環や参照欠損を拒否する
export function hierarchyRows(project: Project, root?: string): { layer: Layer; depth: number }[] {
    const index = hierarchyIndex(project); // 子の参照表
    const roots = root === undefined ? index.children.get(null) ?? [] : [index.layers.get(root.toLowerCase())!];
    if (roots.some((layer) => !layer)) throw new RangeError("レイヤーが存在しません。");
    const stack = [...roots].reverse().map((layer) => ({ layer, depth: 0 })); // 深さ優先の明示スタック
    const visited = new Set<string>(), output = []; // 再訪問で循環を検出
    while (stack.length) {
        const entry = stack.pop()!; // 次のノード
        const id = entry.layer.id.toLowerCase();
        if (visited.has(id)) throw new RangeError("階層が循環しています。");
        visited.add(id); output.push(entry);
        const children = index.children.get(id) ?? []; // 子は順序を保って積む
        for (let i = children.length - 1; i >= 0; i--) stack.push({ layer: children[i]!, depth: entry.depth + 1 });
    }
    if (root === undefined && visited.size !== project.layers.length) throw new RangeError("階層に循環または欠落があります。");
    return output;
}

////////////////////
// 二つのアフィン行列を親×子の順序で乗算する
export function multiplyMatrix(a: Matrix, b: Matrix): Matrix {
    const result = new Array<number>(16).fill(0); // 出力
    for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
        let value = 0; // 内積
        for (let axis = 0; axis < 4; axis++) value += a[row * 4 + axis]! * b[axis * 4 + col]!;
        if (!Number.isFinite(value)) throw new RangeError("階層変換が有限数の範囲を超えました。");
        result[row * 4 + col] = value;
    }
    return result;
}

////////////////////
// スケール、回転、位置の順で適用するローカル変換を作る
export function composeTransform(values: Readonly<LayerValues<Mode>>): Matrix {
    const rotation = values.rotation; // 2Dは時計回り度数、3DはQuaternion
    let q: Quaternion; // 共通の回転表現
    if (typeof rotation === "number") {
        const angle = rotation * Math.PI / 360;
        q = [0, 0, Math.sin(angle), Math.cos(angle)];
    } else q = normalizeQuaternion(rotation);
    const [x, y, z, w] = q; // 単位Quaternion
    const sx = values.size[0], sy = values.size[1], sz = values.size[2] ?? 1;
    const result = [
        (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y - z * w) * sy, 2 * (x * z + y * w) * sz, values.position[0],
        2 * (x * y + z * w) * sx, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z - x * w) * sz, values.position[1],
        2 * (x * z - y * w) * sx, 2 * (y * z + x * w) * sy, (1 - 2 * (x * x + y * y)) * sz, values.position[2] ?? 0,
        0, 0, 0, 1,
    ];
    if (!result.every(Number.isFinite)) throw new RangeError("ローカル変換が不正です。");
    return result;
}

////////////////////
// 3×3の各列を正規化してから逆行列を求め、大きなスケールの二乗を避ける
export function inverseMatrix(matrix: Matrix): Matrix {
    const lengths = [0, 1, 2].map((col) => Math.hypot(matrix[col]!, matrix[4 + col]!, matrix[8 + col]!)); // 列の長さ
    if (lengths.some((value) => value === 0 || !Number.isFinite(value))) throw new RangeError("ゼロスケールの逆変換はできません。");
    const [a, b, c, d, e, f, g, h, i] = [0, 1, 2, 4, 5, 6, 8, 9, 10].map((at) => matrix[at]! / lengths[at % 4]!);
    const determinant = a! * (e! * i! - f! * h!) - b! * (d! * i! - f! * g!) + c! * (d! * h! - e! * g!);
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new RangeError("特異または不安定な行列の逆変換はできません。");
    const cofactors = [e! * i! - f! * h!, c! * h! - b! * i!, b! * f! - c! * e!,
        f! * g! - d! * i!, a! * i! - c! * g!, c! * d! - a! * f!,
        d! * h! - e! * g!, b! * g! - a! * h!, a! * e! - b! * d!];
    const result = [...IDENTITY_MATRIX]; // 逆スケール×逆回転
    for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) result[row * 4 + col] = cofactors[row * 3 + col]! / determinant / lengths[row]!;
        result[row * 4 + 3] = -(result[row * 4]! * matrix[3]! + result[row * 4 + 1]! * matrix[7]! + result[row * 4 + 2]! * matrix[11]!);
    }
    if (!result.every(Number.isFinite)) throw new RangeError("逆行列が数値範囲を超えました。");
    return result;
}

////////////////////
// 位置を親またはワールド空間へ写す
export function transformPosition(matrix: Matrix, point: readonly number[]): Vec3 {
    const result = [0, 1, 2].map((axis) => matrix[axis * 4]! * point[0]! + matrix[axis * 4 + 1]! * point[1]!
        + matrix[axis * 4 + 2]! * (point[2] ?? 0) + matrix[axis * 4 + 3]!);
    if (!result.every(Number.isFinite)) throw new RangeError("位置が数値範囲を超えました。");
    return result as unknown as Vec3;
}

////////////////////
// TRSへ分解し、せん断・反転・ゼロ軸を近似せず拒否する
export function decomposeTransform(matrix: Matrix, mode: Mode): Pick<LayerValues<Mode>, "position" | "rotation" | "size"> {
    const size = [0, 1, 2].map((col) => Math.hypot(matrix[col]!, matrix[col + 4]!, matrix[col + 8]!));
    if (size.some((value) => value === 0 || !Number.isFinite(value))) throw new RangeError("ゼロスケールの変換は分解できません。");
    const normalized = [0, 1, 2].map((col) => [matrix[col]! / size[col]!, matrix[col + 4]! / size[col]!, matrix[col + 8]! / size[col]!]);
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
        const dot = normalized[a]!.reduce((sum, value, axis) => sum + value * normalized[b]![axis]!, 0);
        if (Math.abs(dot) > DECOMPOSITION_TOLERANCE) throw new RangeError("せん断（Shear）が必要なため、この変換は保存できません。");
    }
    const [r0, r1, r2] = normalized; // 回転行列の列
    const determinant = r0![0]! * (r1![1]! * r2![2]! - r2![1]! * r1![2]!)
        - r1![0]! * (r0![1]! * r2![2]! - r2![1]! * r0![2]!) + r2![0]! * (r0![1]! * r1![2]! - r1![1]! * r0![2]!);
    if (determinant < 0) throw new RangeError("負のスケールを必要とする変換は保存できません。");
    const m00 = r0![0]!, m01 = r1![0]!, m02 = r2![0]!, m10 = r0![1]!, m11 = r1![1]!, m12 = r2![1]!;
    const m20 = r0![2]!, m21 = r1![2]!, m22 = r2![2]!;
    let quaternion: Quaternion; // 3D姿勢
    const trace = m00 + m11 + m22;
    if (trace > 0) {
        const s = Math.sqrt(trace + 1) * 2;
        quaternion = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
    } else if (m00 > m11 && m00 > m22) {
        const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
        quaternion = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
    } else if (m11 > m22) {
        const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
        quaternion = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
    } else {
        const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
        quaternion = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
    }
    const result = mode === "2d" ? { position: [matrix[3]!, matrix[7]!] as const, rotation: Math.atan2(m10, m00) * 180 / Math.PI,
        size: [size[0]!, size[1]!] as const }
        : { position: [matrix[3]!, matrix[7]!, matrix[11]!] as const, rotation: normalizeQuaternion(quaternion), size: size as unknown as Vec3 };
    const rebuilt = composeTransform({ ...result, color: [1, 1, 1], opacity: 1 });
    if (matrix.some((value, axis) => Math.abs(value - rebuilt[axis]!) > DECOMPOSITION_TOLERANCE * Math.max(1, Math.abs(value)))) {
        throw new RangeError("変換を許容精度内で再現できません。");
    }
    return result;
}

////////////////////
// 指定ノードまでの必要な親だけを反復評価し、同時刻の結果を共有する
export function hierarchyAt(project: Project, layerId: string, timeUs: number): HierarchyState {
    if (!isNonNegativeSafeInteger(timeUs)) throw new RangeError("評価時刻が不正です。");
    let frame = frames.get(project);
    if (!frame || frame.time !== timeUs) { frame = { time: timeUs, states: new Map() }; frames.set(project, frame); }
    const id = layerId.toLowerCase(), index = hierarchyIndex(project);
    const chain: Layer[] = [], visited = new Set<string>(); // 再帰しない親たどり
    let current: string | null = id;
    while (current !== null && !frame.states.has(current)) {
        if (visited.has(current)) throw new RangeError("階層が循環しています。");
        visited.add(current);
        const layer = index.layers.get(current);
        if (!layer) throw new RangeError("レイヤー参照が存在しません。");
        chain.push(layer); current = layer.parentId?.toLowerCase() ?? null;
    }
    let parent = current === null ? { matrix: IDENTITY_MATRIX, color: [1, 1, 1] as LinearRgb, opacity: 1, visible: true, locked: false }
        : frame.states.get(current)!;
    for (const layer of chain.reverse()) {
        const values = layerValuesAt(project, layer, timeUs);
        parent = { matrix: multiplyMatrix(parent.matrix, composeTransform(values)),
            color: [0, 1, 2].map((axis) => parent.color[axis]! * values.color[axis]!) as unknown as LinearRgb,
            opacity: parent.opacity * values.opacity, visible: parent.visible && layer.isVisible, locked: parent.locked || layer.isLocked };
        frame.states.set(layer.id.toLowerCase(), parent);
    }
    return frame.states.get(id)!;
}

////////////////////
// 位置のスナップは編集空間で行い、浮動小数のあふれを拒否する
export function snapPosition(position: readonly number[], interval: number): number[] {
    if (!Number.isFinite(interval) || interval < 1e-6 || interval > 1e9) throw new RangeError("スナップ間隔は0.000001〜1000000000にしてください。");
    const result = position.map((value) => Math.round(value / interval) * interval);
    if (!result.every(Number.isFinite)) throw new RangeError("スナップ後の位置が数値範囲を超えました。");
    return result;
}

////////////////////
// ロックは描画時刻や特異な変換から独立して判定する
export function isLayerLocked(project: Project, id: string): boolean {
    const index = hierarchyIndex(project), visited = new Set<string>(); // 親をたどる索引
    let layer = index.layers.get(id.toLowerCase()); // 編集対象
    if (!layer) throw new RangeError("レイヤーが存在しません。");
    while (layer) {
        const key = layer.id.toLowerCase(); // 循環検出
        if (visited.has(key)) throw new RangeError("階層が循環しています。");
        visited.add(key);
        if (layer.isLocked) return true;
        if (layer.parentId === null) return false;
        layer = index.layers.get(layer.parentId.toLowerCase());
        if (!layer) throw new RangeError("親レイヤーが存在しません。");
    }
    return false;
}
