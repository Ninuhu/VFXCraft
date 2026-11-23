export const DOCUMENT_SCHEMA_VERSION = 6; // 論理データの形式版
export const DEFAULT_PRODUCTION_FPS = 60; // 新規プロジェクトの初期制作FPS

export type Mode = "2d" | "3d";
export type Vec2 = readonly [x: number, y: number];
export type Vec3 = readonly [x: number, y: number, z: number];
export type Quaternion = readonly [x: number, y: number, z: number, w: number];
export type LinearRgb = readonly [red: number, green: number, blue: number];

type Vector<M extends Mode> = M extends "2d" ? Vec2 : Vec3;

export type LayerValues<M extends Mode> = {
    position: Vector<M>;
    rotation: M extends "2d" ? number : Quaternion;
    size: Vector<M>;
    color: LinearRgb;
    opacity: number;
};

export type LayerProperty = keyof LayerValues<Mode>;
export const EMITTER_TRACK_PROPERTIES = ["rate", "lifetimeUs", "speed", "direction", "acceleration", "particleSize",
    "materialColor", "materialOpacity", "bloomStrength"] as const; // 発生レイヤー固有の対象
type AnimationValues<M extends Mode> = LayerValues<M> & {
    rate: number; lifetimeUs: number; speed: number; direction: M extends "2d" ? number : Vec3;
    acceleration: Vector<M>; particleSize: number; materialColor: LinearRgb; materialOpacity: number; bloomStrength: number;
};
export type TrackProperty = keyof AnimationValues<Mode>;
export type TrackValue = AnimationValues<Mode>[TrackProperty];
export type Interpolation = "step" | "linear";
export type Keyframe<T = TrackValue> = { readonly offsetUs: number; readonly value: T; readonly interpolation?: Interpolation };
export type Track<M extends Mode = Mode> = {
    [P in TrackProperty]: {
        readonly layerId: string;
        readonly property: P;
        readonly interpolation: Interpolation; // 区間指定がない場合の既定値
        readonly beforeFirst?: "base"; // 旧版の先頭キー前を保つ
        readonly keys: readonly Keyframe<AnimationValues<M>[P]>[];
    };
}[TrackProperty];

export type Layer<M extends Mode = Mode> = {
    readonly id: string;
    readonly name: string;
    readonly parentId: string | null;
    readonly order: number;
    readonly isVisible: boolean;
    readonly isLocked: boolean;
    readonly startUs: number;
    readonly emissionEndUs?: number; // 省略時は従来どおり明示的な発生終端なし
    readonly values: Readonly<LayerValues<M>>;
    readonly content: { readonly kind: "group" } | { readonly kind: "emitter"; readonly emitterId: string };
};

export type Particle2D = {
    readonly speed: number;
    readonly directionDegrees: number;
    readonly acceleration: Vec2;
    readonly space: "world" | "local";
    readonly seed: number;
    readonly shape: { readonly kind: "point" } | { readonly kind: "circle"; readonly radius: number }
        | { readonly kind: "rectangle"; readonly width: number; readonly height: number };
};

export type Particle3D = {
    readonly speed: number;
    readonly direction: Vec3;
    readonly acceleration: Vec3;
    readonly space: "world" | "local";
    readonly seed: number;
    readonly shape: "point";
    readonly billboard: "camera" | "world-y";
};

export type Emitter = {
    readonly particle3d?: Particle3D;
    readonly particle2d?: Particle2D;
    readonly id: string;
    readonly materialId: string;
    readonly lifetimeUs: number;
    readonly emission: { readonly kind: "continuous"; readonly ratePerSecond: number }
        | { readonly kind: "burst"; readonly count: number };
};

export type GradientStop<T> = { readonly offset: number; readonly value: T };
export type Gradient = {
    readonly colors: readonly GradientStop<LinearRgb>[];
    readonly alphas: readonly GradientStop<number>[];
};
export type MaterialAppearance = {
    readonly opacity: number;
    readonly lifetime: Gradient;
    readonly spatial: Gradient;
    readonly bloomStrength: number;
};
export type BackgroundSettings = {
    readonly color: LinearRgb;
    readonly checker: boolean;
    readonly grid: boolean;
    readonly gridOpacity: number;
};
export type ProjectPreview = {
    readonly background: Partial<BackgroundSettings>;
    readonly bloom: { readonly radius: number; readonly threshold: number };
    readonly pixelBloom: "pixel" | "smooth";
};

export type Material = {
    readonly appearance?: MaterialAppearance;
    readonly id: string;
    readonly textureAssetId: string | null;
    readonly blend: "alpha" | "additive" | "multiply";
    readonly color: LinearRgb;
    readonly hasBloom: boolean;
    readonly gradient: readonly { readonly offset: number; readonly color: LinearRgb }[];
};

export type Asset = {
    readonly id: string;
    readonly name: string;
    readonly mediaType: "image/png" | "image/jpeg" | "image/webp";
    readonly width: number;
    readonly height: number;
};

type ProjectOf<M extends Mode> = {
    readonly preview?: ProjectPreview;
    readonly schemaVersion: typeof DOCUMENT_SCHEMA_VERSION;
    readonly mode: M;
    readonly id: string;
    readonly name: string;
    readonly durationUs: number;
    readonly allowOutsideKeys?: true; // 短縮時に保持を選択した制作尺外の編集情報
    readonly productionFps: number;
    readonly layers: readonly Layer<M>[];
    readonly emitters: readonly Emitter[];
    readonly materials: readonly Material[];
    readonly tracks: readonly Track<M>[];
    readonly assets: readonly Asset[];
};

export type Project = (ProjectOf<"2d"> & {
    readonly drawing: "normal" | "pixel";
    readonly pixelScale: number;
    readonly canvasWidth: number;
    readonly canvasHeight: number;
}) | ProjectOf<"3d">;

export type Preset = {
    readonly schemaVersion: typeof DOCUMENT_SCHEMA_VERSION;
    readonly id: string;
    readonly name: string;
    readonly template: Project;
    readonly requiredAssetIds: readonly string[];
};
