import type { Emitter, Layer, Track, TrackProperty } from "../document/model.ts";
import { evaluateTrack } from "../document/evaluateTrack.ts";
import { MICROS_PER_SECOND } from "../document/time.ts";
import { emissionWindow } from "./emission.ts";

const MAX_CANDIDATES = 200_000; // 一回の評価で走査する粒子番号の安全上限
type RateSegment = { start: number; end: number; rate: number; slope: number; before: number; after: number };
type RatePlan = { segments: RateSegment[]; initial: number };
const plans = new WeakMap<Track, RatePlan>(); // 不変トラックから区間積分を一度作る
const lifetimes = new WeakMap<Track, number>(); // 候補範囲の上限値

////////////////////
// 秒あたり発生率を積分する。区間内は定数または一次式
function area(rate: number, slope: number, seconds: number): number {
    return (rate + slope * seconds / 2) * seconds;
}

////////////////////
// 各区間の累積発生量を作り、任意時刻のシークで先頭から積分し直さない
function ratePlan(track: Track): RatePlan {
    const cached = plans.get(track); // 既存の区間表
    if (cached) return cached;
    const keys = track.keys; // 検証済みの数値キー
    const times = [0, ...keys.filter((key) => key.offsetUs > 0).map((key) => key.offsetUs)]; // 全区間の左端
    const segments: RateSegment[] = []; // 発生率が連続な区間
    let before = 0; // 直前までの累積発生量
    let keyIndex = -1; // 区間左側のキー
    for (const [index, start] of times.entries()) {
        if (keys[keyIndex + 1]?.offsetUs === start) keyIndex++;
        const end = times[index + 1] ?? Infinity; // 最後のキーを以降も維持する
        const key = keys[keyIndex], next = keys[keyIndex + 1]; // 区間のキー
        const rate = (key ?? next)!.value as number;
        const slope = key && next && (key.interpolation ?? track.interpolation) === "linear"
            ? ((next.value as number) - rate) / ((end - start) / MICROS_PER_SECOND) : 0;
        const after = end === Infinity ? rate === 0 ? before : Infinity : before + area(rate, slope, (end - start) / MICROS_PER_SECOND);
        segments.push({ start, end, rate, slope, before, after });
        before = after;
    }
    const plan = { segments, initial: segments[0]!.rate > 0 ? 0 : 1 }; // 開始時の正の発生率だけ0番を即時発生
    plans.set(track, plan);
    return plan;
}

////////////////////
// 昇順の区間から条件を初めて満たすものを引く
function firstSegment(segments: RateSegment[], condition: (segment: RateSegment) => boolean): RateSegment {
    let low = 0, high = segments.length - 1; // 二分探索範囲
    while (low < high) {
        const middle = Math.floor((low + high) / 2); // 探索の中央
        if (condition(segments[middle]!)) high = middle; else low = middle + 1;
    }
    return segments[low]!;
}

////////////////////
// 累積発生量に達した時刻を、一次または二次方程式の安定な根から逆算する
function birthAt(plan: RatePlan, index: number): number {
    if (index === 0) return 0;
    const segment = firstSegment(plan.segments, (entry) => entry.after >= index); // 粒子番号を含む最初の区間
    const amount = index - segment.before; // 区間内の発生量
    if (amount <= 0) return segment.start;
    const endRate = Math.sqrt(Math.max(0, segment.rate ** 2 + 2 * segment.slope * amount)); // 逆算時点の発生率
    const seconds = 2 * amount / (segment.rate + endRate); // 緩い傾きでも桁落ちしにくい式
    return Math.min(segment.end, segment.start + seconds * MICROS_PER_SECOND);
}

////////////////////
// 指定時刻に生存する番号と発生時刻だけを返す。旧版の定数発生は既存の計算を使う
export function* activeBirths(emitter: Emitter, layer: Layer, elapsed: number,
    tracks?: ReadonlyMap<TrackProperty, Track>): Generator<{ index: number; birth: number; age: number; lifetime: number }> {
    const end = layer.emissionEndUs === undefined ? Infinity : layer.emissionEndUs - layer.startUs; // 半開区間の終端
    if (elapsed < 0 || end <= 0) return;
    const rateTrack = tracks?.get("rate"); // Continuous用の発生率トラック
    const lifeTrack = tracks?.get("lifetimeUs"); // 発生時に固定する寿命
    let maximumLife = emitter.lifetimeUs; // 候補の最長寿命
    if (lifeTrack) {
        let maximum = lifetimes.get(lifeTrack); // キーから計算した最長値
        if (maximum === undefined) {
            maximum = lifeTrack.keys.reduce((value, key) => Math.max(value, key.value as number), 0);
            lifetimes.set(lifeTrack, maximum);
        }
        maximumLife = Math.max(maximumLife, maximum);
    }
    const limit = Math.min(elapsed, end); // 発生済み候補の検索上限
    const earliest = Math.max(0, elapsed - maximumLife); // 生存し得る最古の発生位置
    let first = 0, last = -1; // 粒子番号の範囲
    let at: (index: number) => number; // 粒子番号から相対発生時刻を求める
    if (emitter.emission.kind === "burst") {
        last = earliest === 0 ? emitter.emission.count - 1 : -1;
        at = () => 0;
    } else if (rateTrack?.keys.length) {
        const plan = ratePlan(rateTrack); // 絶対時刻から再利用できる積分表
        const cumulative = (offset: number) => {
            const segment = firstSegment(plan.segments, (entry) => offset < entry.end); // 時刻を含む区間
            return segment.before + area(segment.rate, segment.slope, (offset - segment.start) / MICROS_PER_SECOND);
        };
        first = Math.max(plan.initial, Math.floor(cumulative(earliest)));
        last = Math.floor(cumulative(limit));
        at = (index) => birthAt(plan, index);
    } else {
        const window = emissionWindow(emitter, limit, elapsed - maximumLife); // 定数の場合の従来経路
        ({ first, last } = window);
        at = (index) => index / window.rate * MICROS_PER_SECOND;
    }
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last - first + 1 > MAX_CANDIDATES) {
        throw new RangeError("評価候補の粒子数が安全上限を超えています。");
    }
    for (let index = first; index <= last; index++) {
        const birth = at(index); // 時刻計算は描画FPSや再生順序から独立
        const age = elapsed - birth; // 描画時の寿命内時間
        if (age < 0 || birth >= end || age >= maximumLife) continue;
        const lifetime = evaluateTrack(lifeTrack, Math.round(birth), emitter.lifetimeUs) as number;
        if (age < lifetime) yield { index, birth, age, lifetime };
    }
}
