# Git Bashでの更新・Push手順

この手順では、配布した `eorzean_collection_enhanced_filters_v8.zip` を既存のGitリポジトリへ反映し、GitHub等のリモートへPushします。CloudflareがGit連携されている場合、Push後に自動デプロイが開始されます。

> 作業前に、ダウンロード済みのZIPの場所と既存リポジトリの場所を確認してください。以下ではZIPを `~/Downloads/eorzean_collection_enhanced_filters_v8.zip`、プロジェクトを `~/Documents/eorzean-collection` と仮定しています。実際の場所へ置き換えてください。

## 1. Git Bashでリポジトリへ移動して最新状態を確認する

```bash
cd ~/Documents/eorzean-collection

git status
git branch --show-current
git remote -v
git pull --ff-only
```

`git status` に未コミットの変更が表示された場合は、先に別途コミットするか、変更内容を退避してください。`git pull --ff-only` が失敗した場合は、競合を避けるためこの手順を中断し、表示されたメッセージを確認してください。`git push --force` は使用しません。

## 2. ZIPを一時フォルダへ展開して反映する

次のブロックは、リポジトリ自体を削除せずにプロジェクトの中身だけを上書きします。`.git` は残るため、リモート設定や履歴は保持されます。

```bash
ZIP=~/Downloads/eorzean_collection_enhanced_filters_v8.zip
TEMP_DIR=~/eorzean-collection-update-v8

rm -rf "$TEMP_DIR"
mkdir -p "$TEMP_DIR"
unzip -q "$ZIP" -d "$TEMP_DIR"

# 現在いる場所がリポジトリ直下であることを確認してから実行する
cp -R "$TEMP_DIR/eorzean_collection_enhanced_filters/." .
```

## 3. 反映内容を確認する

```bash
git status
git diff --stat
git diff -- public/index.html README.md
```

主に `public/index.html`、`README.md`、`TEST_RESULTS.md` が変更され、`FILTER_RULES.md` と `tests/verify-collection-classification.mjs` が追加されます。`worker.js` と `wrangler.toml` に意図しない差分がないことも確認してください。

## 4. コミットしてPushする

```bash
git add -A
git diff --cached --stat
git commit -m "feat: add market availability and paid collection filters"

git push origin "$(git branch --show-current)"
```

Pushが成功すると、Git連携済みのCloudflareプロジェクトでは通常、デプロイが開始されます。

## 5. 公開後に確認する項目

公開サイトでロードストーンIDを検索し、マウントまたはミニオンの結果タブを開きます。フィルターには「MB：すべて」「入手性：すべて」「課金：すべて」が表示され、並び替えには「MB購入可を先に」「通常入手可を先に」「課金要素ありを先に」が表示されます。各カードにはMB購入可否、入手性、課金要素のタグが表示されます。

| 問題 | 対応 |
|---|---|
| `Author identity unknown` | 自分の名前・メールアドレスを使い、`git config --global user.name "名前"` と `git config --global user.email "メールアドレス"` を設定してからコミットを再実行します。 |
| `Permission denied (publickey)` | `git remote -v` でリモートURLを確認し、GitHub側のSSH鍵設定またはHTTPS認証を確認します。 |
| `git pull --ff-only` が失敗する | 他端末等の更新があるため、強制Pushせずに現在のブランチ状況を確認します。 |
| Pushしたのに公開ページが変わらない | Cloudflareのデプロイ履歴で該当コミットのビルド状況を確認し、ブラウザをスーパーリロードします。 |
