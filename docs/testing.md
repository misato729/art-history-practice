# 共有スキーマとブラウザテスト

## 検証ルールの正本

試験設定・問題・表示ブロックの基本形式は、`frontend/shared/`のZodスキーマで定義します。画面・API・問題取込・設定検査CLIは同じ定義を使用します。管理フォームの入力正規化、アーカイブの厳密な属性検査、公開セットの全問整合、DBの外部キーなど、入口や保存処理に固有の条件は引き続き検査します。

`config/exam.schema.json`はZodから生成する編集支援用のJSON Schemaです。直接編集しません。分類間の参照や選択肢と設定の対応など、JSON Schemaだけで表現できない条件もあるため、設定・問題を変更したらCLIで確認します。

依存ライブラリを導入したうえで、リポジトリのルートから実行します。

```bash
npm --prefix frontend ci
npm --prefix frontend run schema:check
node --experimental-strip-types scripts/check-template.mjs
```

設定値や問題の内容を差し替えるだけならJSON Schemaの再生成は不要です。Zodの検証ルール自体を変更した場合は生成物も更新します。

セットごとに件数が異なる場合は、`config/exam.json`の`exam.sets`で全セットを番号順に定義します。各セットの`question_count`を指定し、選択肢が途中で変わる場合は`sections`に`title`・`first`・`last`・`choice_labels`を指定します。区分は問1から最終問までを連続して網羅する必要があります。`sets`を省略した従来形式は共通の`questions_per_exam`と`choice_labels`を使用します。アプリ・管理フォーム・API・取込・公開セット検査は同じ共有ヘルパーで解決します。

このサービスは試験番号1〜5の「模擬試験1」〜「模擬試験5」、計425問です。各回の問1〜85はすべて4択です。`frontend/e2e/mock-exam.spec.ts`は全5回425問の表示・採点、回答前の正答非公開、美術史から活用問題への区分境界と共通本文の一致、条件出題、管理フォームをPCとスマートフォンで確認します。サイトは1問ずつ採点する演習形式で、60分の一括受験・一括採点セッションは対象に含みません。

```bash
npm --prefix frontend run schema:generate
npm --prefix frontend run schema:check
```

DBモデルを変更した場合は`npm --prefix frontend run db:generate`でPrisma Clientを更新し、`npm --prefix frontend run db:validate`でスキーマを確認します。Prismaの生成物はGitへ保存しません。ブラウザテストの実行スクリプトもビルド前にPrisma Clientを生成します。

生成物と正本のずれはCIでも検知します。単体・APIテスト、型検査、本番ビルドの手順は[README](../README.md#検証と構成)を参照してください。

## ルーティング・フォームの回帰検証

APIテストはNitroの公式ファイルスキャナーとH3ルーターで実際のメソッド別ルートを登録します。URLの優先順位、HEAD、OPTIONS、未知URL・未対応メソッドのJSONエラー、Origin/JSON検査、管理権限を検証します。

フォームは共有Zodスキーマの境界値と、APIエラーの項目への対応を単体テストで確認します。PlaywrightではPC・スマートフォンで不正入力時の送信抑止、修正後の送信、退会時のパスワードエラー、通信障害と管理問題の項目別エラーを確認します。管理フォームの表示検証では合成のAPI応答を使い、実際の管理者権限の検査はPostgreSQL/APIテストで行います。

## Playwrightの準備

READMEに記載した対応Node.js、PostgreSQL 16、Chromiumを使用します。E2E用のPostgreSQLはローカルの検証専用環境を用意し、接続ユーザーに一時DBを作成・削除する権限を付与します。起点となるDB名は`_test`で終わる名前にします。既存サービスや本番DBのURLは指定しません。

リポジトリ直下にGit管理対象外の`.env.e2e`を作成し、検証用の接続先を設定します。次は専用のローカルDocker環境を使う例です。`REPLACE_WITH_TEST_PASSWORD`の2箇所を、検証専用の同じパスワードへ置き換えます。URLへ記載するため、英数字だけの十分長いランダムな値を使用します。

```dotenv
POSTGRES_USER=exam_e2e
POSTGRES_DB=exam_e2e_test
POSTGRES_PASSWORD=REPLACE_WITH_TEST_PASSWORD
E2E_DATABASE_URL=postgresql://exam_e2e:REPLACE_WITH_TEST_PASSWORD@127.0.0.1:55439/exam_e2e_test
```

リポジトリのルートから専用PostgreSQLを起動します。既存のテンプレート用Composeとは別のコンテナです。`pg_isready`が接続可能と返してからテストを実行します。

```bash
docker run --detach --name exam-template-e2e-db \
  --env-file .env.e2e --publish 127.0.0.1:55439:5432 postgres:16-alpine
docker exec exam-template-e2e-db pg_isready -U exam_e2e -d exam_e2e_test
```

すでに検証専用のPostgreSQLがある場合は、そこに作成した`_test`で終わるDBのURLを`E2E_DATABASE_URL`へ指定すれば、このコンテナは不要です。

`frontend`で初回のブラウザをインストールし、テストを実行します。Linuxでは`npx playwright install --with-deps chromium`で必要なOSライブラリも導入します。

```bash
cd frontend
npx playwright install chromium
node --env-file=../.env.e2e scripts/run-e2e.mjs
```

すでに`E2E_DATABASE_URL`を環境変数で設定している場合は、`npm run test:e2e`でも実行できます。テストコマンドは先に本番ビルドを作成するため、古いビルドを対象にしません。

上の例で作った専用コンテナを使い終えたら、次で検証用データごと削除できます。

```bash
docker rm --force --volumes exam-template-e2e-db
```

## 分離と確認範囲

テストはPCとスマートフォンの表示幅で、会員登録・ログイン・問題演習・履歴・お気に入り・ログアウトなどをブラウザから操作します。テスト用の合成会員を使用し、Stripeや外部通知を使いません。

無料運用の従来シナリオは`payments.enabled=false`の構成を対象にします。有料運用ではCIが`paid-access.spec.ts`を選択し、PC/SPで静的8回分の導線、準備中6〜8、無料1・2、有料3以降のAPI拒否と直接URL、販売準備中の購入停止を確認します。認証通信は静的ナビゲーションの通信ゼロ検査から除外します。問題や正答位置、選択肢数は同梱データから読み取ります。決済・返金等のDB回帰テストは別途実行し、実際のStripe接続や課金の成功とは区別します。

起点の接続先を確認した後、実行ごとにランダムな名前の新しいDBを作成し、マイグレーションと同梱問題の取込を実行します。既存の問題・会員データは読み込みません。テスト用の認証秘密値も毎回生成します。ビルドも`frontend/.e2e-build/`内の実行ごとの専用ディレクトリを使用し、通常の開発用・配信用の出力を上書きしません。サーバーはループバックアドレスの専用ポート（標準3318）で起動し、通常の`3400`のアプリを再利用しません。必要な場合は`E2E_PORT`で空いているポートへ変更できます。

通常終了、テスト失敗、終了シグナルの処理でテスト用サーバーを停止し、一時DBと専用のビルド出力を削除します。マシンの強制終了などで後処理できなかった場合は、検証環境に残った`exam_e2e_…_test`と`.e2e-build/`内の該当する出力だけを確認して削除してください。

Playwrightのレポートや失敗時の画像などは`frontend/playwright-report/`・`frontend/test-results/`に保存され、Git管理しません。GitHub Actionsでは独立したPostgreSQLを使用し、失敗時の診断ファイルは7日間保存します。

## ハーネスの軽量回帰検査

進捗・完了条件・資料保護だけの変更は、リポジトリのルートで次を実行できます。Node.js標準機能と合成の一時Git環境を使い、アプリの依存関係、DB、Docker、ブラウザを必要としません。

```bash
node --test --test-concurrency=1 scripts/context.test.mjs scripts/workflow-policy.test.mjs scripts/workspace-policy.test.mjs scripts/check-private-sources.test.mjs
node scripts/context.mjs check
node scripts/check-private-sources.mjs
```

検査は原資料を読み込まず、設定・パス・状態・履歴のメタデータを扱います。初期状態の`check --strict`は基準記録がないため終了コード2で、実施済みのアプリ検証を示しません。アプリやDBも変更した場合は、該当する既存の検査を別途実行してください。

GitHub Actionsの`harness`ジョブで先に資料保護とこの回帰検査を行い、成功後に既存のアプリ・ブラウザ検査へ進みます。


## 大問・共通本文の回帰確認

共有スキーマでv1互換、v2の所属・参照・インラインID・未知属性・公開整合を検査します。DB/APIでは同一模試・大問の制約、公開親による直接取得・採点の制限、編集競合、本文変更後の古い回答拒否、履歴の保持、取込・書出しの往復、同一問題への階層付与と反復時の無変更を確認します。

Playwrightの`mock-exam.spec.ts`は各回85問、全5回425問の表示・採点、回答前の正答非公開、共通本文のAPI・画面との一致と80→81問の区分境界を確認します。現在の共通本文は問題上部に表示します。管理フォームはこの模試の4択で入力保持・プレビュー・項目別エラーを確認し、汎用の4択・6択切替は`mixedExamNavigation.test.ts`・`mixedExamValidation.test.ts`と合成設定のAPI/DBテストで維持します。いずれも独立したテストDBと合成会員を使用します。条件・利用者の変更による本文状態の破棄と古い非同期応答の拒否は`practicePassageState.test.ts`でも確認します。


## 静的トップ・大問サイドバー・誤答復習

関連単体は`examSidebarLayout.test.ts`・`sidebarCatalog.test.ts`・`mixedExamNavigation.test.ts`、API/DBは`incorrect-review.test.ts`・`study-categories.test.ts`と学習/ルート検査を使用します。`world-ui-review.spec.ts`は通常の隔離ハーネスで、静的入口の初回カタログ通信なし、PC折畳み/スマホ展開、静的大問入口の公開位置解決、疎な位置の次問、カタログ再試行、最新誤答・一巡・残数/0件・完了時通信失敗・ログイン期限切れを検証します。通常の`study-categories.spec.ts`も併せてジャンルと受験科目プリセットを確認します。いずれも既存DBや公開サイトを検証用会員・履歴で変更しません。


模試原稿の整合は、リポジトリ直下で各回の`node --experimental-strip-types scripts/check-mock-exam.mjs content/mock-exams/mock-0N`（N=1〜5）と`node --experimental-strip-types scripts/check-mock-series.mjs`を使います。共有Zod、85問/4択、分野・難度・図版配分、画像の安全パスとハッシュ、単独原稿と同梱425問の一致、模試1の保持、PDFの確定版ハッシュを確認します。これは内容の正確性・近接誤答・図版必須性・実際の難度を自動証明するものではなく、独立レビューと別に扱います。ブラウザCIでも全5回とPDFの指紋を点検します。
