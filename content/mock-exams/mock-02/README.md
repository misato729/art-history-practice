# 模擬試験2・テキスト準拠V2

現行原稿は `mock02-textbook-v2-20261107`、形式バージョンは1です。受領した `content/revisions/mock02-textbook-v2/revision.json` を正本とし、文章・肢順・正答・解説・出典・図版参照は変更せず、`scripts/mock02-revision/build-seed.mjs` で既存取込形式へ機械変換します。

85問・340肢。通常80問の共通資料参照は0、活用81〜85は共通資料と4図版を使用します。通常図版付き6問、重複を除く使用画像8点です。構造・原稿照合は学術査読や実測難度の保証ではありません。

`questions.md`・`answers.md`・`editorial.json`・`source-map.*`・`image-credits.json` は提供物をそのまま保存しています。`image-manifest.json` は既存の36画像の権利・同一性台帳で、現行使用数を表しません。

旧版の原稿・編集評価・manifestは `content/revisions/mock02-textbook-v2/baseline-artifacts/` に保存しています。`output/pdf/art-grade2-mock-02-questions.pdf` と同answers.pdfは2026年11月6日作成の旧版PDFで、V2を収録していません。V2の問題・解答はこのフォルダーのMarkdownと正本JSONを参照してください。

再構築用の `content/questions.json` とこのフォルダーの `questions.json` は同じ原稿から生成し、既定の空DB取込でV2が再現されます。既存DBの更新には専用revision CLIを使い、空DB取込・seedの強制実行で置き換えません。通常のproduction配信ではseedは実行されません。

本番反映は検証・バックアップ・変更範囲を提示した後、ユーザーの明示了承を得て行います。
