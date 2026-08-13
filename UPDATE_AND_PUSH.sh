#!/usr/bin/env bash
# Git Bash 用: 配布フォルダから既存のGitリポジトリへ安全に更新を反映する。
# このスクリプトは配布フォルダ内で実行する。既存リポジトリの .git は保持される。
set -euo pipefail

SOURCE_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
DEFAULT_TARGET="$(cd -- "$SOURCE_DIR/.." && pwd)/eorzean-collection"
TARGET_DIR="${1:-$DEFAULT_TARGET}"

if [[ ! -d "$TARGET_DIR" ]]; then
  echo "エラー: 更新先フォルダが見つかりません: $TARGET_DIR" >&2
  echo "例: bash UPDATE_AND_PUSH.sh /c/Users/mojai/Downloads/eorzean-collection" >&2
  exit 1
fi

if [[ ! -d "$TARGET_DIR/.git" ]]; then
  echo "エラー: 更新先はGitリポジトリではありません: $TARGET_DIR" >&2
  echo "既存の eorzean-collection フォルダ（.git を含む）を指定してください。" >&2
  exit 1
fi

if [[ -n "$(git -C "$TARGET_DIR" status --porcelain)" ]]; then
  echo "エラー: 更新先に未コミットの変更があります。先にコミットまたは退避してください。" >&2
  git -C "$TARGET_DIR" status --short >&2
  exit 1
fi

BRANCH="$(git -C "$TARGET_DIR" branch --show-current)"
if [[ -z "$BRANCH" ]]; then
  echo "エラー: 現在のブランチを取得できません。" >&2
  exit 1
fi

if ! git -C "$TARGET_DIR" remote get-url origin >/dev/null 2>&1; then
  echo "エラー: origin リモートが未設定です。" >&2
  exit 1
fi

echo "更新先: $TARGET_DIR"
echo "ブランチ: $BRANCH"
echo "リモート: $(git -C "$TARGET_DIR" remote get-url origin)"
echo
echo "リモートの最新変更を確認します…"
git -C "$TARGET_DIR" pull --ff-only

echo
echo "配布ファイルを反映します（.git は保持されます）…"
cp -R "$SOURCE_DIR"/. "$TARGET_DIR"/

echo
echo "変更一覧:"
git -C "$TARGET_DIR" status --short

echo
git -C "$TARGET_DIR" add -A
echo "ステージ済み差分:"
git -C "$TARGET_DIR" diff --cached --stat

echo
read -r -p "この内容でコミットしてPushしますか？ [y/N] " ANSWER
if [[ ! "$ANSWER" =~ ^[Yy]$ ]]; then
  echo "中止しました。ファイルは更新済みですが、コミット・Pushはしていません。"
  exit 0
fi

git -C "$TARGET_DIR" commit -m "feat: display FFXIV Collect ownership rates"
git -C "$TARGET_DIR" push origin "$BRANCH"

echo
echo "Pushが完了しました。CloudflareのGit連携が有効ならデプロイ状況を確認してください。"
