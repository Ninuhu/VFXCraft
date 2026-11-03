# T00前の旧ファイル退避

元のdocs/内にあった5ファイルをdocs/以下へ.originalを付けてバイト列を保持したまま退避した。製品仕様の正本ではない。

| 元パス（リポジトリ基準） | 退避先（本書基準） | 理由 |
| --- | --- | --- |
| docs/PROJECT_SPEC.md | [PROJECT_SPEC.md.original](docs/PROJECT_SPEC.md.original) | 0バイトの空ファイル |
| docs/UI_REQUIREMENTS.md | [UI_REQUIREMENTS.md.original](docs/UI_REQUIREMENTS.md.original) | 0バイトの空ファイル |
| docs/ARCHITECTURE.md | [ARCHITECTURE.md.original](docs/ARCHITECTURE.md.original) | 0バイトの空ファイル |
| docs/UI_DESIGN.md | [UI_DESIGN.md.original](docs/UI_DESIGN.md.original) | 0バイトの空ファイル |
| docs/DEVELOPMENT_PLAN.md | [DEVELOPMENT_PLAN.md.original](docs/DEVELOPMENT_PLAN.md.original) | 6560バイト、Excel形式のZIP、空シート。変換せず保存 |

正本は内容のあるルート文書からdocs/へ移した。退避前後のSHA-256はT00検証で照合。作業前262ファイルの保護コピー・ハッシュ一覧はローカルの.local-backups/t00/20261103-234953/に保持する（Git管理外）。
