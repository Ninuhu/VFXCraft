# VFXCraft 開発資料

作成日: 2026-11-03（日本時間）  
対象: Q1〜Q14の決定事項に基づくMVP-Bと、その後の拡張  
状態: 製品仕様の整理済み／UI v0.1参考画像を受領・採用／詳細配置は変更可能／技術詳細は設計提案を含む

VFXCraftは、Webブラウザで2D・3Dのゲーム用エフェクトを制作するツールです。仕様・設計・計画の正本はdocs/に配置します。アプリ本体、50種類のプリセット素材、実装済みのファイル形式を納品するものではありません。

## 読む順序

| 文書 | 用途 |
| --- | --- |
| [PROJECT_SPEC.md](docs/PROJECT_SPEC.md) | Q1〜Q14、MVP-B、任意機能、将来機能、完成条件 |
| [UI_REQUIREMENTS.md](docs/UI_REQUIREMENTS.md) | 配置に依存しない機能・操作・表示要件 |
| [UI_LAYOUT_WORKSHEET.md](docs/UI_LAYOUT_WORKSHEET.md) | ユーザーが配置・寸法・操作導線を記入するシート |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 状態管理、描画、編集、保存、出力の責務と技術決定手順 |
| [PROJECT_FORMAT.md](docs/PROJECT_FORMAT.md) | `.vcr`と3D JSONの区別、保存契約の設計案 |
| [DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md) | 段階的な開発順序と各段階の完了条件 |
| [CODEX_IMPLEMENTATION_PLAN.md](docs/CODEX_IMPLEMENTATION_PLAN.md) | タスクID、依存関係、変更範囲、検証、開始指示 |
| [TEST_PLAN.md](docs/TEST_PLAN.md) | 要件IDに結び付いた受け入れ確認 |
| [DECISION_LOG.md](docs/DECISION_LOG.md) | 決定の出典、提案、未決事項 |
| [AGENTS.md](AGENTS.md) | Codexが守る実装上の制約 |

## この資料の読み方

- **確定**: ユーザーが決めた製品要件。実装都合で削除・延期しない。
- **任意**: 余裕があれば追加する機能。MVP-B完成の必須条件にしない。
- **将来**: MVP-B完成後の機能。MVP-Bの実装タスクへ混ぜない。
- **検討対象**: 採用自体が決まっていない候補。
- **設計提案**: 今回整理した技術・操作上の案。過去の決定として扱わない。
- **未決**: 具体値や振る舞いがまだ定まっていない。影響するタスクの前に決める。

要件IDは`REQ-Qxx-yy`、画面要件は`UI-xx`、検証は`AT-xx`、実装タスクは`Txx`です。対応表を通して、実装・確認の漏れを追えます。

## 最優先の制約

1. **画面の配置・寸法・見た目はユーザーが設計する。** 左右・上下への配置、固定パネル、タブ構成、ドッキング方式をこの資料では確定しない。
2. MVP-Bには2Dと3Dの両方、50種類以上の初期プリセット、最大100操作のUndo/Redo、階層レイヤー、自動保存・復元を含める。
3. プロジェクトの保存は`.vcr`。PNG連番・スプライトシート・3D JSONのエクスポートとは別機能。
4. AIはMVP-B完成後。クラウドAPI、その後ローカルLLMの順。AIなしで基本機能がすべて使える。
5. `.vcr`のZIPベース案は未採用。技術検証と設計記録を経て決める。

## 実装を始める入口

最初に[CODEX_IMPLEMENTATION_PLAN.md](docs/CODEX_IMPLEMENTATION_PLAN.md)の「初回の開始指示」を使い、T00から開始します。UI配置が届くまではデータ、描画、保存、操作コマンドと検証用の最小画面を進めます。検証用画面は製品のUIレイアウトとして採用しません。

MVP-Bの完成は[PROJECT_SPEC.md](docs/PROJECT_SPEC.md)の完成条件と[TEST_PLAN.md](docs/TEST_PLAN.md)の必須項目で判定します。中間段階で2Dだけ動く状態があっても、MVP-B完成とは呼びません。

## 情報源

- 元チャット: [Pixelfxの感想まとめ](chatgpt-conversation://6ae72f49-9828-83e8-9aa7-ad928b0fb8f5)。取得できた本文はQ11〜Q14と全体まとめ。
- このチャットでユーザーが提示した「VFXCraft 仕様一覧（Q1〜Q10）」。Q1〜Q10の確定事項とZIP案の未確定状態を補完。
- このチャットの作成依頼。UI配置を勝手に確定しないこと、MVP-Bと将来機能を分けることを明示。

細かな出典と未決事項は[DECISION_LOG.md](docs/DECISION_LOG.md)を参照してください。

## T00 開発基盤（2026-11-03）

- [開発運用](docs/DEVELOPMENT_WORKFLOW.md)：環境・Git・承認・整形方針。
- [要件追跡表](docs/REQUIREMENTS_TRACEABILITY.md)：41要件、16タスク、16 ATの状態。
- [UI v0.1](docs/design/ui/v0.1/README.md)：9画面の暫定参考画像。
- [旧ファイルの退避記録](docs/archive/pre-t00/README.md)。

T01の検証用アプリは `pnpm install --frozen-lockfile` の後、`pnpm dev` で起動します。ブラウザで `http://127.0.0.1:5173/` を開いてください。テストは `pnpm test` と `pnpm test:e2e`、本番ビルドは `pnpm build` で実行できます。

- [T01検証記録](docs/development/T01_VALIDATION.md)
- [Edge手動確認手順](docs/development/T01_EDGE_CHECK.md)
