# VFXCraft 開発運用

2026-11-03 / T00。製品要件は[正本](PROJECT_SPEC.md)、規約は[AGENTS.md](../AGENTS.md)。

## 承認と対象範囲

各タスクは仕様確認、実装方針、対象ファイル提示、ユーザー承認、実装、テスト、動作確認、報告、PR準備の順に進める。通常技術判断は承認されたタスク内で検証しADRへ記録する。
今回の許可はT00のみ。T01以降、依存導入、commit、push、merge、ブランチ削除は未許可。

## 初期対応環境

Windows 11、Google Chrome・Microsoft Edge、キーボード・マウス、デスクトップ画面を初期検証対象とする。Firefox・Safari・タッチ操作は将来検討。最低バージョン、最小画面寸法、GPU・メモリ、負荷と性能閾値はOPEN-14で決定する。
調査時はNode.js v24.22.1、pnpmパッケージ11.25.0（Codex同梱）、Git 2.49.0、Chrome 156.0.8078.74、Edge 156.0.4314.58を確認。npmはPATHで見つからず。これらは調査結果であり採用バージョンの固定ではない。WebGL2・実機性能は未検証。

## Git運用

| ブランチ | 役割・派生元・統合先 |
| --- | --- |
| main | 安定版・ベータ版。developから完成時に統合 |
| develop | 開発統合。初回はmainから作成 |
| foundation / editor / particle等 | developから派生。一区切りでdevelopへ統合 |
| feat/xxx / fix/xxx / refactor/xxx | 対応する分野ブランチから派生し、PRで同じ分野へ統合 |

ブランチ名は作成元を保証しない。毎回作成元・PR先を確認する。T00はmain→develop→foundation→feat/foundation-docsの順で作成し、PR先はfoundation。ブランチ作成だけでは作業ツリーの変更はコミットされない。
コミット接頭辞はadd: / feat: / fix: / docs: / refactor: / chore: / test:。PRは[テンプレート](../.github/PULL_REQUEST_TEMPLATE.md)に従い、関連Issue、変更・理由、手順、結果、画像・動画、影響、レビュー観点、残件を書く。UI・エフェクト変更は可能な限り視覚証拠を用意する。

## 保護と整形

既存の未コミット・未追跡ファイルをSHA-256付きでバックアップし、照合してから作業する。移動は排他的コピー→照合→元パス整理。衝突・損失リスク・保護失敗では停止する。stash/reset/clean/強制チェックアウトは使用しない。
テキストはUTF-8（BOMなし）、LF、末尾改行。TS/TSXは4スペース、JSON/YAMLは2スペース。Markdownの意味のある行末スペースは保持する。画像と退避原本は正規化しない。Git全体の設定変更や一括再正規化は行わない。T01でフォーマッター等の具体的構成を提案する。

## T01の準備

TypeScript・React・Three.jsを主対象に、最小構成と依存の固定版・理由・代替案を提示して別途承認を得る。通常/ピクセル2D、3Dビルボード、アルファ/加算、基本Bloomと透過、ブラウザ保存を小さく検証する。ADR-001/002/007、基準端末、検証用UIを用意する。将来AI・製品UIの未承認変更を含めない。
