import { DEFAULT_PRODUCTION_FPS, DOCUMENT_SCHEMA_VERSION, type Project } from "./model.ts";
import { validateProject } from "./validateDocument.ts";

type NewProject = {
    readonly id: string;
    readonly name: string;
    readonly durationUs: number;
} & ({ readonly mode: "2d"; readonly drawing: "normal" | "pixel";
       readonly canvasWidth: number; readonly canvasHeight: number }
    | { readonly mode: "3d" });

////////////////////
// 呼び出し側が採番したIDで、初期制作FPSを持つ空の文書を作る
export function createProject(input: NewProject): Project {
    return validateProject({
        ...input,
        schemaVersion: DOCUMENT_SCHEMA_VERSION,
        productionFps: DEFAULT_PRODUCTION_FPS,
        layers: [], emitters: [], materials: [], tracks: [], assets: [],
    });
}
