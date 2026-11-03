import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./app/verification.css";

const rootElement = document.getElementById("root"); // Reactの描画先

if (rootElement === null) {
    throw new Error("アプリの表示先が見つかりません。");
}

createRoot(rootElement).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
