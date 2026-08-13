エオルゼア蒐集録 — デプロイ用スナップショット（ロードストーン直読みハイブリッド版）
=====================================================================
このフォルダの中身を、GitHubクローン（例 eorzean-collection/）へそのままコピーして
push すると、Cloudflare Pages が自動デプロイします。

  index.html                     … サイト本体（リポジトリ直下＝トップページ）
  functions/api/lodestone.js     … 所持状況をロードストーンから取得するサーバー側の口
                                    （Cloudflare Pages Functions。デプロイで自動的に
                                     /api/lodestone として有効になります）
  ogp.png                        … OGP画像（任意）

■ 役割分担（ハイブリッド）
  ・全体カタログ（全マウント/ミニオン/アチーブメント・ジャンル・報酬）→ FFXIV Collect
  ・キャラの所持状況 → functions/api/lodestone.js がロードストーンを直読み
    → FFXIV Collect への事前登録は不要になります。

■ 公開前の編集
  ・index.html の <head> の canonical と og:url を実サブドメインに。
  ・所持元を元の FFXIV Collect に戻したい場合は index.html 内の
      var SRC="lodestone"  →  var SRC="ffxivcollect"

■ Cloudflare Pages のビルド設定
  Framework preset = None / Build command = 空 / Build output directory = /（ルート）
  functions/ フォルダは Pages が自動認識します（追加設定不要）。

■ 動作テスト（デプロイ後、ブラウザで直接叩けます）
  https://＜あなたのサブドメイン＞/api/lodestone?id=＜LodestoneID＞&type=mounts&lang=ja
  → 所持マウント名の JSON が返れば成功。type は mounts / minions / achievements / character。
