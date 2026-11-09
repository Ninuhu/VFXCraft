import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./app/verification.css";

const VcrReview = lazy(() => import("./app/projectFiles/VcrReview").then((module) => ({ default: module.VcrReview }))); // 保存検証だけを別に読み込む
const ParticleReview = lazy(() => import("./app/particles/ParticleReview").then((module) => ({ default: module.ParticleReview }))); // T05の検証画面
const Particle3DReview = lazy(() => import("./app/particles3d/Particle3DReview").then((module) => ({ default: module.Particle3DReview }))); // T06の検証画面
const MaterialsReview = lazy(() => import("./app/materials/MaterialsReview").then((module) => ({ default: module.MaterialsReview }))); // T07の検証画面
const rootElement = document.getElementById("root"); // Reactの描画先

if (rootElement === null) {
    throw new Error("アプリの表示先が見つかりません。");
}

createRoot(rootElement).render(
    <StrictMode>
        <Suspense fallback={<p>読込中…</p>}>
            {new URLSearchParams(location.search).has("materials-review") ? <MaterialsReview />
                : new URLSearchParams(location.search).has("particles3d-review") ? <Particle3DReview />
                : new URLSearchParams(location.search).has("particles-review") ? <ParticleReview />
                : new URLSearchParams(location.search).has("vcr-review") ? <VcrReview /> : <App />}
        </Suspense>
    </StrictMode>,
);
