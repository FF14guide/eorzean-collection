# 最初にここを確認してください

このフォルダは **更新ファイル** です。Gitの履歴とリモート接続情報を保つため、既存の `eorzean-collection` フォルダは削除しません。

展開後のDownloadsフォルダは、次のような状態にしてください。

```text
C:\Users\mojai\Downloads\
├─ eorzean-collection\          ← 既存のGitリポジトリ（.gitを含む）
└─ eorzean-collection-update\   ← このZIPを展開してできる更新フォルダ
```

## 実行方法

1. `eorzean-collection-update` フォルダを右クリックし、**Git Bash Here** を開きます。
2. 次の1行を貼り付けて実行します。

```bash
./UPDATE_AND_PUSH.sh
```

3. スクリプトは、既存リポジトリの未コミット変更・ブランチ・リモートを確認し、最新版を取得してから更新ファイルを反映します。
4. 変更一覧とステージ済み差分を表示した後、`この内容でコミットしてPushしますか？ [y/N]` と聞かれます。内容に問題がなければ **`y`** を入力してEnterを押します。

> `eorzean-collection` フォルダが別の場所にある場合は、次のように更新先を指定してください。
>
> ```bash
> ./UPDATE_AND_PUSH.sh /c/Users/mojai/実際の場所/eorzean-collection
> ```

## 重要な注意

- `eorzean-collection` は削除しないでください。そこにGitの履歴とPush先の設定があります。
- スクリプトが「未コミットの変更があります」と停止した場合は、既存の作業内容を確認してください。強制Pushは不要です。
- Push後、CloudflareのGit連携が有効ならデプロイが開始されます。
