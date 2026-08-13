エオルゼア蒐集録 — デプロイ用スナップショット（Worker + Static Assets 構成）
=====================================================================
このプロジェクトは Cloudflare 上で「静的アセット付き Worker」として動いています
（Pages ではありません）。そのため所持データ取得は functions/ ではなく worker.js が担当します。

  index.html      … サイト本体（トップページ）
  worker.js       … /api/lodestone を処理（ロードストーン直読み）＋ それ以外は静的配信
  wrangler.toml   … Worker 設定（name / main / assets）
  ogp.png         … OGP画像（任意）

■ 反映（Windows / Git Bash）
  クローン先で以下を実行（初回のみ、旧 functions フォルダがあれば削除）:
    git rm -r --ignore-unmatch functions
  そのうえで通常どおり:
    cp -r collection-proj/. eorzean-collection/ && cd eorzean-collection && git add -A && git commit -m "fix: Worker形式に対応（worker.js/wrangler.toml）" && git push

■ デプロイ後の確認
  https://collection.eorzeanfishing.com/api/lodestone?id=＜LodestoneID＞&type=character&lang=ja
  → JSON が返れば成功。次に type=mounts / minions / achievements も確認。

■ 補足
  wrangler.toml の name は Cloudflare 上の Worker 名「eorzean-collection」に一致させています。
  所持元を旧FFXIV Collect方式に戻す場合は index.html 内の var SRC="lodestone" を "ffxivcollect" に。
