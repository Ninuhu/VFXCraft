import type { Camera3D } from "./Camera3D.ts";

////////////////////
// Canvas上のカメラ操作を購読し、解除関数でイベントとポインタ状態を解放する
export function attachCameraInput(canvas: HTMLCanvasElement, camera: Camera3D, report: (error: unknown) => void): () => void {
    let pointer: number | undefined; // ドラッグ中のポインタ
    let previousX = 0, previousY = 0, pan = false; // 前回の位置と操作種類
    const controller = new AbortController(); // 全イベントをまとめて解除する所有者
    const originalTouchAction = canvas.style.touchAction; // 画面から借りたCSS状態
    canvas.style.touchAction = "none";

    ////////////////////
    // マウス開始位置を記録し、左でOrbit、右またはShiftでPanする
    function down(event: PointerEvent) {
        if (pointer !== undefined || ![0, 2].includes(event.button)) return;
        pointer = event.pointerId;
        previousX = event.clientX; previousY = event.clientY;
        pan = event.button === 2 || event.shiftKey;
        canvas.setPointerCapture(event.pointerId);
    }
    ////////////////////
    // 相対移動をCanvasの大きさで正規化してカメラへ渡す
    function move(event: PointerEvent) {
        if (pointer !== event.pointerId) return;
        const x = (event.clientX - previousX) / Math.max(1, canvas.clientWidth); // 横移動の割合
        const y = (event.clientY - previousY) / Math.max(1, canvas.clientHeight); // 縦移動の割合
        previousX = event.clientX; previousY = event.clientY;
        try {
            if (pan) camera.pan(-x, y); else camera.orbit(-x * Math.PI * 2, -y * Math.PI);
        } catch (error) { report(error); }
    }
    ////////////////////
    // 終了または取消でポインタの所有を返す
    function up() {
        if (pointer !== undefined && canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer);
        pointer = undefined;
    }
    ////////////////////
    // ホイールの単位差を吸収し、急激なズームを制限する
    function wheel(event: WheelEvent) {
        event.preventDefault();
        const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1; // 行・ページ単位をpxへ換算
        try { camera.zoom(Math.max(-0.5, Math.min(0.5, event.deltaY * scale * 0.001))); }
        catch (error) { report(error); }
    }
    canvas.addEventListener("pointerdown", down, { signal: controller.signal });
    canvas.addEventListener("pointermove", move, { signal: controller.signal });
    canvas.addEventListener("pointerup", up, { signal: controller.signal });
    canvas.addEventListener("pointercancel", up, { signal: controller.signal });
    canvas.addEventListener("lostpointercapture", up, { signal: controller.signal });
    canvas.addEventListener("contextmenu", (event) => event.preventDefault(), { signal: controller.signal });
    canvas.addEventListener("wheel", wheel, { signal: controller.signal, passive: false });
    return () => { controller.abort(); up(); canvas.style.touchAction = originalTouchAction; };
}
