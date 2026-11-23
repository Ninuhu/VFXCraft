import type { Layer, Project, TrackProperty, TrackValue } from "../../core/document/model.ts";
import type { EditCommand } from "../../core/editing/command.ts";
import { DEFAULT_APPEARANCE } from "../../core/materials/materialEvaluation.ts";
import { tracksFor } from "../../core/document/animation.ts";

////////////////////
// Auto Keyは既存の編集経路へキー操作を渡す。OFFでは既存キーを増やさず基本値だけ変更する。
export function propertyCommand(project: Project, layer: Layer, property: TrackProperty, value: TrackValue,
    timeUs: number, autoKey: boolean): EditCommand {
    if (autoKey) {
        const offsetUs = timeUs - layer.startUs; // 祖先の開始時刻は加算しない
        const track = tracksFor(project, layer.id)?.get(property); // 現在のキーがあれば区間方式も維持
        const existing = track?.keys.find((item) => item.offsetUs === offsetUs); // 同時刻キーを作らない
        if (existing) return { kind: "key.update", layerId: layer.id, property, offsetUs, key: { ...existing, value } };
        const left = track?.keys.filter((item) => item.offsetUs < offsetUs).at(-1); // 分割する区間の補間
        return { kind: "key.add", layerId: layer.id, property,
            key: { offsetUs, value, interpolation: left?.interpolation ?? track?.interpolation ?? "linear" } };
    }
    if (["position", "rotation", "size", "color", "opacity"].includes(property)) {
        return { kind: "layer.update", layerId: layer.id, patch: { values: { [property]: value } } };
    }
    const emitterId = layer.content.kind === "emitter" ? layer.content.emitterId : undefined; // 発生器専用の項目
    const emitter = project.emitters.find((item) => item.id === emitterId);
    if (!emitter) throw new Error("このレイヤーは発生器を持ちません。");
    const material = project.materials.find((item) => item.id === emitter.materialId)!; // 検証済み参照
    if (["materialColor", "materialOpacity", "bloomStrength"].includes(property)) {
        return { kind: "material.appearance", materialId: material.id, color: property === "materialColor" ? value as typeof material.color : material.color,
            blend: material.blend, appearance: { ...(material.appearance ?? DEFAULT_APPEARANCE),
                ...(property === "materialOpacity" ? { opacity: value as number } : property === "bloomStrength" ? { bloomStrength: value as number } : {}) } };
    }
    if (property === "particleSize") throw new Error("粒子サイズ倍率はキーとして編集してください。基本サイズはTransformのスケールです。");
    const settings = { emission: emitter.emission, lifetimeUs: emitter.lifetimeUs,
        ...(emitter.particle2d ? { particle2d: emitter.particle2d } : {}), ...(emitter.particle3d ? { particle3d: emitter.particle3d } : {}) }; // 既存設定を維持
    if (property === "rate") {
        if (emitter.emission.kind !== "continuous") throw new Error("Burstでは発生率を編集できません。");
        return { kind: "emitter.update", emitterId: emitter.id, settings: { ...settings, emission: { kind: "continuous", ratePerSecond: value as number } } };
    }
    if (property === "lifetimeUs") return { kind: "emitter.update", emitterId: emitter.id, settings: { ...settings, lifetimeUs: value as number } };
    const field = property === "direction" && emitter.particle2d ? "directionDegrees" : property; // 2D角度と3Dベクトルを分離
    return { kind: "emitter.update", emitterId: emitter.id, settings: { ...settings,
        ...(emitter.particle2d ? { particle2d: { ...emitter.particle2d, [field]: value } } : {}),
        ...(emitter.particle3d ? { particle3d: { ...emitter.particle3d, [field]: value } } : {}) } };
}
