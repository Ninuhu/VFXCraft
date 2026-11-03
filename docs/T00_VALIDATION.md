# T00 文書・保護検証記録

検証日：2026-11-03（日本時間）。T00のみ実施。アプリコード・依存関係・ADRは未作成、AT-01〜16は全件未実施。

| 確認 | 結果 |
| --- | --- |
| 作業前バックアップ | 262ファイルすべてSHA-256一致。保護コピーも作業後再照合PASS |
| 既存製品要件 | 全51行（うち必須41行）が作業前と完全一致 |
| 移動した正本文書 | 原文保持PASS（改行正規化・AGENTS相対リンク修正・承認済み追記） |
| 旧docs/の退避5ファイル | すべて元ハッシュと一致、元パス整理済み |
| UI画像 | 元SHA-256と一致：179B4C2B8316B9C51E5943FBEFBFB3D9A9EB8CF96FFBE7C83C72938BA2BC8C15 |
| 対象外ファイル | 243ファイルのSHA-256一致。既存.gitkeepも保持 |
| 追跡表 | 必須41要件・16タスク・16 AT、UI参照を記載 |
| 文書リンク | 78件のローカルリンク先存在を確認（本記録作成前） |
| 文字コード・改行 | 編集対象テキストUTF-8/BOMなし/LF/末尾改行PASS。退避原本・画像は対象外 |
| Git | 指定順に3ブランチ作成。現在feat/foundation-docs。mainを含む4ブランチの先端は作業前と同じ2f8f1fb |
| ステージ | 変更なし。commit/push/merge/ブランチ削除なし |

## 変更一覧

ルート変更：AGENTS.md、README.md、.gitignore。
新規：.editorconfig、.gitattributes、DEVELOPMENT_WORKFLOW.md、REQUIREMENTS_TRACEABILITY.md、本記録、design/ui/v0.1/README.md、archive/pre-t00/README.md（後者5文書はdocs/配下）。PRテンプレートは移動後に要件・承認欄を追記。

| 移動元（リポジトリ基準） | 移動先 |
| --- | --- |
| docs/PROJECT_SPEC.md | docs/archive/pre-t00/docs/PROJECT_SPEC.md.original |
| docs/UI_REQUIREMENTS.md | docs/archive/pre-t00/docs/UI_REQUIREMENTS.md.original |
| docs/ARCHITECTURE.md | docs/archive/pre-t00/docs/ARCHITECTURE.md.original |
| docs/UI_DESIGN.md | docs/archive/pre-t00/docs/UI_DESIGN.md.original |
| docs/DEVELOPMENT_PLAN.md | docs/archive/pre-t00/docs/DEVELOPMENT_PLAN.md.original |
| PROJECT_SPEC.md | docs/PROJECT_SPEC.md |
| DECISION_LOG.md | docs/DECISION_LOG.md |
| UI_REQUIREMENTS.md | docs/UI_REQUIREMENTS.md |
| UI_LAYOUT_WORKSHEET.md | docs/UI_LAYOUT_WORKSHEET.md |
| ARCHITECTURE.md | docs/ARCHITECTURE.md |
| PROJECT_FORMAT.md | docs/PROJECT_FORMAT.md |
| DEVELOPMENT_PLAN.md | docs/DEVELOPMENT_PLAN.md |
| CODEX_IMPLEMENTATION_PLAN.md | docs/CODEX_IMPLEMENTATION_PLAN.md |
| TEST_PLAN.md | docs/TEST_PLAN.md |
| PULL_REQUEST_TEMPLATE.md | .github/PULL_REQUEST_TEMPLATE.md |
| VFXCraft 日本語UI.png | docs/design/ui/v0.1/VFXCraft 日本語UI.png |

バックアップ・manifest.json・Git状態/差分/refs・moves.json・作業用organize.cjs/verify.cjsは.local-backups/t00/20261103-234953/に保持（Git除外）。作業用スクリプトは一度限りのT00作業記録で、アプリ実装ではない。

Markdownの既存行末2スペースは改行表現として保持。git diff --checkの当該指摘は意図したもの。通常の空白検証はMarkdown改行を許容する設定で実施する。

## 残件・次工程

OPEN-01は詳細UI、OPEN-14は最低版・基準端末・性能閾値等が未決。他のOPEN/ADRは[決定記録](DECISION_LOG.md)を参照。Git既存未追跡ファイルは引き続き未追跡。T01の範囲は[開発運用](DEVELOPMENT_WORKFLOW.md)に整理済みだが、対象ファイル・依存の固定版を提示し別途承認を得るまで着手しない。
