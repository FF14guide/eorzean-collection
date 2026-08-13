# 所持率表示のデータ判断

FFXIV Collectの現行APIを確認したところ、マウント、ミニオン、アチーブメントの各レコードに文字列の `owned` フィールドがあり、例として `0.1%`、`0%`、`0.7%` のような所持率を返す。

| 種別 | APIレスポンスの確認 | 表示方針 |
|---|---|---|
| マウント | `owned` を確認 | カードに `FFXIV Collect所持率 {owned}` を表示 |
| ミニオン | `owned` を確認 | カードに `FFXIV Collect所持率 {owned}` を表示 |
| アチーブメント | `owned` を確認 | カードに `FFXIV Collect所持率 {owned}` を表示 |

FFXIV CollectのFAQによれば、この割合は「各カテゴリで少なくとも1つのコレクションを持つ公開キャラクター」に基づく。全プレイヤー母集団ではなく、収集に関心を持つ登録済みの公開キャラクターのサンプルである。また、アチーブメントはロードストーンで非公開が既定のため、他のコレクションより小さいサンプルである。このため、UIでは「ユーザー全体所持率」ではなく **FFXIV Collect所持率** と表示し、注記を添える。

Sources:

- https://ffxivcollect.com/faq
- https://documenter.getpostman.com/view/1779678/TzXzDHM1
