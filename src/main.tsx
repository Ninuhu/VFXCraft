import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./app/verification.css";

const VcrReview = lazy(() => import("./app/projectFiles/VcrReview").then((module) => ({ default: module.VcrReview }))); // 保存検証だけを別に読み込む
const ParticleReview = lazy(() => import("./app/particles/ParticleReview").then((module) => ({ default: module.ParticleReview }))); // T05の検証画面
const rootElement = document.getElementById("root"); // Reactの描画先

if (rootElement === null) {
    throw new Error("アプリの表示先が見つかりません。");
}

createRoot(rootElement).render(
    <StrictMode>
        {new URLSearchParams(location.search).has("particles-review") ? <Suspense fallback={<p>読込中…</p>}><ParticleReview /></Suspense> : new URLSearchParams(location.search).has("vcr-review") ? <Suspense fallback={<p>読込中…</p>}><VcrReview /></Suspense> : <App />}
    </StrictMode>,
);
