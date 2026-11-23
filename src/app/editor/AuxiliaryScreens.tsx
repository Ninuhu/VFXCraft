import { useEffect, useState } from "react";
import type { ProjectFileFlow } from "../projectFiles/projectFileFlow.ts";

////////////////////
// 後続画面は正式UIのカテゴリ・一覧・詳細の構成を保ち、未実装の業務機能を明示する。
export function PresetsScreen({ create }: { create: () => void }) {
    return <><h1>プリセットLibrary</h1><div className="auxiliary-columns">
        <aside><h2>カテゴリー</h2><p>すべて／2D／3D</p><p>炎・水・魔法などの分類はT12で追加します。</p></aside>
        <section><input placeholder="プリセット検索（T12で対応）" disabled /><h2>プリセット一覧</h2><div className="empty-library">内蔵50種類以上・検索・自作保存はT12で整備します。架空のプリセットは表示していません。</div><button onClick={create}>編集できるサンプルから始める</button></section>
        <aside><h2>選択中のプリセット</h2><div className="empty-preview">プレビュー／詳細</div><button disabled>このプリセットで作成（準備中）</button></aside>
    </div></>;
}

////////////////////
// 既存の登録素材を実際のBlobから一覧・詳細へ表示する。URLは画面が所有して解放する。
export function AssetsScreen({ flow, disabled, onImport }: { flow: ProjectFileFlow; disabled: boolean; onImport: (file: File) => void }) {
    const assets = flow.history.preview.assets; // 素材の正本は既存文書
    const [selected, setSelected] = useState<string | null>(null), [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map()); // 一時的な選択・表示URL
    useEffect(() => {
        const next = new Map<string, string>(); // 素材本体は複製せずBlobのURLだけ作成
        for (const asset of assets) { const blob = flow.getImage(asset.id); if (blob) next.set(asset.id, URL.createObjectURL(blob)); }
        setUrls(next); return () => { for (const url of next.values()) URL.revokeObjectURL(url); };
    }, [flow, assets]);
    const asset = assets.find((item) => item.id === selected) ?? assets[0]; // 削除済みの選択を使わない
    return <><h1>素材管理</h1><label>画像をインポート<input aria-label="画像をインポート" disabled={disabled} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = ""; if (file) onImport(file);
    }} /></label><p>対応：PNG / JPG / WebP。テクスチャ参照の変更はインスペクターから操作します。</p><div className="auxiliary-columns">
        <aside><h2>カテゴリー</h2><p>すべての素材（{assets.length}）</p><p>タグ・高度な管理はT12で整備します。</p></aside>
        <section><h2>素材一覧</h2><div className="asset-grid">{assets.map((item) => <button key={item.id} aria-label={item.name} aria-pressed={asset?.id === item.id} onClick={() => setSelected(item.id)}>
            {urls.has(item.id) && <img src={urls.get(item.id)} alt={item.name} />}<span>{item.name}</span></button>)}</div>{!assets.length && <div className="empty-library">画像を取り込むとここへ表示されます。</div>}</section>
        <aside><h2>素材の詳細</h2>{asset ? <>{urls.has(asset.id) && <img className="asset-detail" src={urls.get(asset.id)} alt={asset.name + " 詳細"} />}<h3>{asset.name}</h3><p>{asset.width}×{asset.height}／{asset.mediaType}</p></> : <div className="empty-preview">登録素材はありません。</div>}<p>未使用の登録画像も.vcrへ保存されます。</p></aside>
    </div></>;
}

////////////////////
// 出力形式・設定・結果の配置だけを用意し、T13未実装の出力を開始できるように見せない。
export function ExportScreen() {
    return <><h1>エクスポート（出力設定）</h1><p>製品向け出力はT13です。編集プロジェクトは保存ボタンから.vcrへ保存できます。</p><div className="auxiliary-columns export-columns">
        <section><h2>1 出力形式</h2><fieldset disabled><button>PNG連番</button><button>スプライトシート</button><button>3D JSON</button></fieldset></section>
        <section><h2>2 出力設定</h2><fieldset disabled><label>解像度<select><option>出力設定はT13で対応</option></select></label><label>出力FPS<input placeholder="T13で設定" /></label><label><input type="checkbox" />透過背景</label><label>出力範囲<input placeholder="T13で設定" /></label><button>エクスポート開始（未実装）</button></fieldset></section>
        <aside><h2>3 出力プレビュー</h2><div className="empty-preview">出力結果・見積りはT13で対応します。</div></aside>
    </div></>;
}

////////////////////
// 現在使える制作手順と設定への入口を案内し、T14の未整備チュートリアルを再生可能に見せない。
export function HelpScreen({ settings }: { settings: () => void }) {
    return <><h1>ヘルプ／ガイド</h1><div className="screen-columns"><aside>はじめに<br />基本操作<br />ショートカット一覧</aside><section>
        <h2>VFXCraftへようこそ！</h2><p>新規作成 → レイヤー選択 → インスペクターで調整 → 再生 → 保存、の順に制作できます。</p>
        <div className="guide-steps"><article>1 プロジェクトを作る<p>2D/3Dと、空・基本・サンプルを選択。</p></article><article>2 エフェクトを編集<p>紫色のアクティブ一層を変更。複数選択でも一括編集しません。</p></article><article>3 保存する<p>.vcrへ保存。出力機能はT13で対応。</p></article></div>
        <p>ギズモの色付き端点をドラッグして編集します。視点はCanvas上の左ドラッグでOrbit、右ドラッグでPan、ホイールでZoom。</p><p>パネルを見失ったら「表示 → 初期配置に戻す」。設定画面でも復旧できます。</p>
        <button onClick={settings}>現在のショートカット一覧・設定</button><h2>機能ガイド</h2><p>完全な初心者ガイド・日英・両テーマはT14で整備します。</p>
    </section></div></>;
}
