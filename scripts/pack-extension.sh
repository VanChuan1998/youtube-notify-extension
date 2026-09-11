#!/usr/bin/env bash
# Đóng gói extension/ thành ZIP nộp Chrome Web Store.
set -euo pipefail

cd "$(dirname "$0")/.."

SRC_DIR="extension"
OUT_DIR="dist"
VERSION=$(python3 -c "import json; print(json.load(open('$SRC_DIR/manifest.json', encoding='utf-8'))['version'])")
OUT_FILE="$OUT_DIR/auto-mo-live-v$VERSION.zip"

python3 -m json.tool "$SRC_DIR/manifest.json" >/dev/null

if python3 -c "import json,sys; sys.exit(0 if 'default_locale' in json.load(open('$SRC_DIR/manifest.json', encoding='utf-8')) else 1)"; then
  if [ ! -d "$SRC_DIR/_locales" ]; then
    echo "LỖI: manifest khai báo default_locale nhưng thiếu $SRC_DIR/_locales/" >&2
    exit 1
  fi
fi

# Implementation hiện tại dùng launchWebAuthFlow; client ID nằm trong popup.js.
# Chỉ cảnh báo nếu chưa có client ID thực tế, không chặn các tính năng không OAuth.
if grep -Eq 'const[[:space:]]+OAUTH_CLIENT_ID[[:space:]]*=[[:space:]]*"(YOUR_|DÁN_|)OAUTH' "$SRC_DIR/popup.js" || \
   grep -q 'YOUR_CLIENT_ID.apps.googleusercontent.com' "$SRC_DIR/popup.js"; then
  echo "CẢNH BÁO: OAUTH_CLIENT_ID trong popup.js vẫn là placeholder." >&2
  echo "          Import subscriptions sẽ không hoạt động. Xem docs/OAUTH-SETUP.md." >&2
fi

if [ ! -d "$SRC_DIR/lib" ]; then
  echo "LỖI: thiếu $SRC_DIR/lib/" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
OUT_FILE_ABS="$(pwd)/$OUT_FILE"
rm -f "$OUT_FILE_ABS"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
cp -a "$SRC_DIR/." "$TMP_DIR/"

# Local manifest có key để giữ ID ổn định khi dev. Store tự quản lý signing/ID;
# không nộp key dev vào gói production.
python3 - <<PY
import json
p = '$TMP_DIR/manifest.json'
with open(p, encoding='utf-8') as f:
    d = json.load(f)
if 'key' in d:
    del d['key']
    print('Đã xoá trường "key" khỏi manifest production')
with open(p, 'w', encoding='utf-8') as f:
    json.dump(d, f, ensure_ascii=False, indent=2)
    f.write('\n')
PY

( cd "$TMP_DIR" && zip -rq "$OUT_FILE_ABS" . -x '.DS_Store' -x '__MACOSX/*' )

echo "Đã tạo $OUT_FILE ($(du -h "$OUT_FILE_ABS" | cut -f1))"
echo
echo "Nội dung:"
unzip -l "$OUT_FILE" | awk 'NR>3 && $0 !~ /^ *-+/ && $0 !~ /files?$/ { print }'
