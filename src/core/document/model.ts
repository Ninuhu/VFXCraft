export const DOCUMENT_SCHEMA_VERSION = 2; // 論理データの形式版
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

export type TrackProperty = keyof LayerValues<Mode>;
export type TrackValue = LayerValues<Mode>[TrackProperty];
export type Track<M extends Mode = Mode> = {
    [P in TrackProperty]: {
        readonly layerId: string;
        readonly property: P;
        readonly interpolation: "step" | "linear";
        readonly keys: readonly { readonly offsetUs: number; readonly value: LayerValues<M>[P] }[];
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

export type Emitter = {
    readonly particle2d?: Particle2D;
    readonly id: string;
    readonly materialId: string;
    readonly lifetimeUs: number;
    readonly emission: { readonly kind: "continuous"; readonly ratePerSecond: number }
        | { readonly kind: "burst"; readonly count: number };
};

export type Material = {
    readonly id: string;
    readonly textureAssetId: string | null;
    readonly blend: "alpha" | "additive";
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
    readonly schemaVersion: typeof DOCUMENT_SCHEMA_VERSION;
    readonly mode: M;
    readonly id: string;
    readonly name: string;
    readonly durationUs: number;
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
