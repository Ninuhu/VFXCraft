import type { Project } from "../document/model.ts";

const QUATERNION_ROUNDING_TOLERANCE = 8 * Number.EPSILON; // 正規化の再計算による成分の丸め誤差

////////////////////
// 検証済みスキーマで四つの数値を持つ配列はQuaternionとして姿勢を比較する
function sameRotation(previous: readonly unknown[], next: readonly unknown[]): boolean {
    if (previous.length !== 4 || next.length !== 4) return false;
    return [1, -1].some((sign) => next.every((component, index) => {
        const prior = previous[index]; // 同じ軸の旧成分
        return typeof component === "number" && typeof prior === "number"
            && Math.abs(prior - sign * component) <= QUATERNION_ROUNDING_TOLERANCE;
    }));
}

////////////////////
// 検証済みの値を凍結し、等価な部分を直前のスナップショットと共有する
function share(previous: unknown, next: unknown): unknown {
    if (previous === next) return previous;
    if (Array.isArray(next)) {
        const before: readonly unknown[] = Array.isArray(previous) ? previous : []; // 共有候補の配列
        if (sameRotation(before, next)) return before;
        const result = next.map((item: unknown, index) => share(before[index], item)); // 検証済みの要素列
        return Array.isArray(previous) && result.length === before.length && result.every((item, index) => item === before[index])
            ? before : Object.freeze(result);
    }
    if (typeof next !== "object" || next === null) return next;

    const before = typeof previous === "object" && previous !== null && !Array.isArray(previous)
        ? previous as Record<string, unknown> : undefined; // 共有候補のオブジェクト
    const entries = Object.entries(next).map(([key, value]) => [key, share(before?.[key], value)] as const); // 凍結した子要素
    return before && Object.keys(before).length === entries.length && entries.every(([key, value]) => before[key] === value)
        ? before : Object.freeze(Object.fromEntries(entries));
}

////////////////////
// T02で検証した形状を維持して、変更箇所だけを新しい値として保持する
export function shareValidatedProject(previous: Project | undefined, validated: Project): Project {
    return share(previous, validated) as Project;
}
