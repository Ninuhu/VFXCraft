import type { TrackProperty, TrackValue } from "../../core/document/model.ts";
import { baseTrackValue, tracksFor } from "../../core/document/animation.ts";
import { evaluateTrack } from "../../core/document/evaluateTrack.ts";
import { isLayerLocked } from "../../core/document/hierarchy.ts";
import { eulerXyzDegreesFromQuaternion, quaternionFromEulerXyzDegrees } from "../../core/document/rotation.ts";
import { DEFAULT_APPEARANCE, DEFAULT_PREVIEW } from "../../core/materials/materialEvaluation.ts";
import { EditColor } from "./EditColor.tsx";
import { useEditor } from "./EditorContext.tsx";
import { EditNumber } from "./EditNumber.tsx";
import { propertyCommand } from "./propertyEditing.ts";
import { displayedTransform, transformCommand } from "./transformEditing.ts";
import { GradientEditor } from "./GradientEditor.tsx";

////////////////////
// プロパティは一つのアクティブ層のみを編集し、Auto Keyと基本値の経路を明示する。
export function PropertiesPanel() {
    const editor = useEditor(), project = editor.flow.history.preview; // 保存文書と連続入力のプレビュー
    const layer = project.layers.find((item) => item.id === editor.selection.active); // 複数選択の代表
    if (!layer) return <p>レイヤーを選択すると設定を編集できます。</p>;
    const emitterId = layer.content.kind === "emitter" ? layer.content.emitterId : undefined; // グループは発生器を持たない
    const emitter = project.emitters.find((item) => item.id === emitterId), material = project.materials.find((item) => item.id === emitter?.materialId); // 検証済み参照
    const appearance = material?.appearance ?? DEFAULT_APPEARANCE; // 旧版の既定
    let values: ReturnType<typeof displayedTransform>, transformError = ""; // Shearは画面全体の例外にしない
    try { values = displayedTransform(project, layer, editor.time.current, editor.space); }
    catch (error) { values = layer.values; transformError = String(error); }
    ////////////////////
    // キーONの場合に限り現在時刻のアニメーション値を表示する。
    function value(property: TrackProperty): TrackValue {
        const base = baseTrackValue(layer!, emitter, material, property) ?? 1; // 既存モデルから得る基準値
        return editor.autoKey ? evaluateTrack(tracksFor(project, layer!.id)?.get(property), editor.time.current - layer!.startUs, base) : base;
    }
    ////////////////////
    // 数値・色は共通のAuto Key経路で登録する。
    function command(property: TrackProperty, next: TrackValue, timeUs: number) {
        return propertyCommand(editor.flow.history.preview, layer!, property, next, timeUs, editor.autoKey);
    }
    return <><h3>{layer.name}</h3><p>{editor.autoKey ? "Auto Key ON：現在時刻のキーを編集" : "Auto Key OFF：基本値を編集（既存のキーが優先される場合があります）"}</p>
        {transformError && <p role="alert">{transformError} Parent Localへ切り替えて編集してください。</p>}
        <fieldset disabled={isLayerLocked(project, layer.id) || Boolean(transformError)}><legend>Transform／{editor.space === "world" ? "World" : "Parent Local"}</legend>
            {(["position", "size"] as const).map((property) => <div key={property}>{values[property].map((part, axis) => <EditNumber key={axis} label={(property === "position" ? "位置 " : "スケール ") + "XYZ"[axis]}
                value={part} command={(next, timeUs) => transformCommand(editor.flow.history.preview, layer, timeUs, editor.space, property,
                    values[property].map((item, index) => index === axis ? next : item) as never, editor.autoKey, editor.snap ? editor.interval : undefined)} />)}</div>)}
            {(typeof values.rotation === "number" ? [values.rotation] : eulerXyzDegreesFromQuaternion(values.rotation)).map((part, axis) => <EditNumber key={axis} label={"回転 " + (project.mode === "2d" ? "度" : "XYZ"[axis] + "度")}
                value={part} command={(next, timeUs) => {
                    const angles = typeof values.rotation === "number" ? [values.rotation] : [...eulerXyzDegreesFromQuaternion(values.rotation)]; // 内因性XYZ
                    angles[axis] = next;
                    return transformCommand(editor.flow.history.preview, layer, timeUs, editor.space, "rotation",
                        project.mode === "2d" ? next : quaternionFromEulerXyzDegrees(angles as [number, number, number]), editor.autoKey);
                }} />)}
            <EditNumber label="レイヤー透明度" value={value("opacity") as number} min={0} max={1} command={(next, timeUs) => command("opacity", next, timeUs)} />
            <EditColor label="レイヤー色" value={value("color") as readonly [number, number, number]} command={(next, timeUs) => command("color", next, timeUs)} />
        </fieldset>
        {emitter && material && <fieldset disabled={isLayerLocked(project, layer.id)}><legend>パーティクルの基本</legend>
            <label>発生方式<select aria-label="発生方式" value={emitter.emission.kind} onChange={(event) => editor.execute({ kind: "emitter.update", emitterId: emitter.id,
                settings: { lifetimeUs: emitter.lifetimeUs, emission: event.target.value === "continuous" ? { kind: "continuous", ratePerSecond: 60 } : { kind: "burst", count: 40 } } })}>
                <option value="continuous">Continuous（連続）</option><option value="burst">Burst（一括）</option></select></label>
            {emitter.emission.kind === "continuous" ? <EditNumber label="発生率（個／秒）" value={value("rate") as number} min={0} command={(next, timeUs) => command("rate", next, timeUs)} />
                : <EditNumber label="発生数" value={emitter.emission.count} min={0} step={1} command={(next) => ({ kind: "emitter.update", emitterId: emitter.id,
                    settings: { lifetimeUs: emitter.lifetimeUs, emission: { kind: "burst", count: next } } })} />}
            <EditNumber label="寿命（秒）" value={(value("lifetimeUs") as number) / 1e6} min={0.000001} command={(next, timeUs) => command("lifetimeUs", Math.round(next * 1e6), timeUs)} />
            <EditNumber label="初速度" value={value("speed") as number} min={0} command={(next, timeUs) => command("speed", next, timeUs)} />
            {editor.autoKey ? <EditNumber label="粒子サイズ倍率" value={value("particleSize") as number} min={0} command={(next, timeUs) => command("particleSize", next, timeUs)} />
                : <p>基本サイズはTransformのスケールで調整します。粒子サイズ倍率のアニメーションはAuto Keyで登録できます。</p>}
            {(["direction", "acceleration"] as const).map((property) => {
                const current = value(property); // 2D角度またはモードごとのベクトル
                return (typeof current === "number" ? [current] : current).map((part, axis) => <EditNumber key={property + axis} label={(property === "direction" ? "発生方向 " : "加速度 ") + (typeof current === "number" ? "度" : "XYZ"[axis])}
                    value={part} command={(next, timeUs) => command(property, typeof current === "number" ? next : current.map((item, index) => index === axis ? next : item) as unknown as TrackValue, timeUs)} />);
            })}
            <label>Simulation Space<select value={(emitter.particle2d ?? emitter.particle3d)?.space} onChange={(event) => editor.execute({ kind: "emitter.update", emitterId: emitter.id, settings: {
                emission: emitter.emission, lifetimeUs: emitter.lifetimeUs,
                ...(emitter.particle2d ? { particle2d: { ...emitter.particle2d, space: event.target.value as "local" | "world" } } : {}),
                ...(emitter.particle3d ? { particle3d: { ...emitter.particle3d, space: event.target.value as "local" | "world" } } : {}),
            } })}><option value="world">World（発生時固定）</option><option value="local">Local（発生器に追従）</option></select></label>
            {emitter.particle3d && <label>ビルボード<select value={emitter.particle3d.billboard} onChange={(event) => editor.execute({ kind: "emitter.update", emitterId: emitter.id,
                settings: { emission: emitter.emission, lifetimeUs: emitter.lifetimeUs, particle3d: { ...emitter.particle3d!, billboard: event.target.value as "camera" | "world-y" } } })}>
                <option value="camera">全面カメラ追従</option><option value="world-y">Y軸固定</option></select></label>}
            {emitter.particle2d && <><label>発生形状<select value={emitter.particle2d.shape.kind} onChange={(event) => editor.execute({ kind: "emitter.update", emitterId: emitter.id,
                settings: { lifetimeUs: emitter.lifetimeUs, emission: emitter.emission, particle2d: { ...emitter.particle2d!,
                    shape: event.target.value === "circle" ? { kind: "circle", radius: 24 } : event.target.value === "rectangle" ? { kind: "rectangle", width: 48, height: 48 } : { kind: "point" } } } })}>
                <option value="point">点</option><option value="circle">円</option><option value="rectangle">長方形</option></select></label>
                {emitter.particle2d.shape.kind === "circle" && <EditNumber label="発生半径" value={emitter.particle2d.shape.radius} min={0} command={(radius) => ({ kind: "emitter.update", emitterId: emitter.id,
                    settings: { lifetimeUs: emitter.lifetimeUs, emission: emitter.emission, particle2d: { ...emitter.particle2d!, shape: { kind: "circle", radius } } } })} />}
                {emitter.particle2d.shape.kind === "rectangle" && (["width", "height"] as const).map((axis) => <EditNumber key={axis} label={axis === "width" ? "発生幅" : "発生高さ"}
                    value={emitter.particle2d!.shape.kind === "rectangle" ? emitter.particle2d!.shape[axis] : 0} min={0} command={(next) => ({ kind: "emitter.update", emitterId: emitter.id,
                        settings: { lifetimeUs: emitter.lifetimeUs, emission: emitter.emission, particle2d: { ...emitter.particle2d!, shape: { ...emitter.particle2d!.shape, [axis]: next } as never } } })} />)}
            </>}
            <details open><summary>マテリアル・見た目</summary>
                <EditColor label="基本色" value={value("materialColor") as typeof material.color} command={(next, timeUs) => command("materialColor", next, timeUs)} />
                <EditNumber label="基本透明度" value={value("materialOpacity") as number} min={0} max={1} command={(next, timeUs) => command("materialOpacity", next, timeUs)} />
                <label>合成モード<select value={material.blend} onChange={(event) => editor.execute({ kind: "material.appearance", materialId: material.id, color: material.color,
                    appearance, blend: event.target.value as typeof material.blend })}><option value="alpha">Normal（通常）</option><option value="additive">Additive（加算）</option><option value="multiply">Multiply（乗算）</option></select></label>
                <label>テクスチャ<select value={material.textureAssetId ?? ""} onChange={(event) => editor.execute({ kind: "material.setTexture", materialId: material.id, assetId: event.target.value || null })}>
                    <option value="">なし</option>{project.assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
                <EditNumber label="Bloom強度" value={value("bloomStrength") as number} min={0} max={8} command={(next, timeUs) => command("bloomStrength", next, timeUs)} />
                {(["radius", "threshold"] as const).map((property) => <EditNumber key={property} label={property === "radius" ? "Bloom半径" : "Bloomしきい値"}
                    value={(project.preview ?? DEFAULT_PREVIEW).bloom[property]} min={0} max={property === "radius" ? 32 : 1} command={(next) => ({ kind: "project.preview",
                        preview: { ...(project.preview ?? DEFAULT_PREVIEW), bloom: { ...(project.preview ?? DEFAULT_PREVIEW).bloom, [property]: next } } })} />)}
                <GradientEditor name="寿命方向" gradient={appearance.lifetime} material={material} field="lifetime" />
                <GradientEditor name="空間方向" gradient={appearance.spatial} material={material} field="spatial" />
            </details>
        </fieldset>}
    </>;
}
