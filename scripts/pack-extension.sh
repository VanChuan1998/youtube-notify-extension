#!/usr/bin/env bash
# Đóng gói thư mục extension/ thành file zip nộp Chrome Web Store.
#
# Repo này chứa cả extension lẫn landing page. Script tồn tại để đảm bảo file zip
# CHỈ chứa extension/ — nộp nhầm cả web/, docs/, .github/ sẽ bị Chrome Web Store
# từ chối vì "extension chứa file không dùng đến".

set -euo pipefail

cd "$(dirname "$0")/.."

SRC_DIR="extension"
OUT_DIR="dist"

VERSION=$(python3 -c "import json;print(json.load(open('$SRC_DIR/manifest.json'))['version'])")
OUT_FILE="$OUT_DIR/youtube-kenh-yeu-thich-v$VERSION.zip"

# manifest phải hợp lệ, nếu không Chrome Web Store từ chối ngay khi upload
python3 -m json.tool "$SRC_DIR/manifest.json" > /dev/null

# default_locale mà không có _locales/ khiến Chrome từ chối load extension.
if python3 -c "import json,sys; sys.exit(0 if 'default_locale' in json.load(open('$SRC_DIR/manifest.json')) else 1)"; then
  if [ ! -d "$SRC_DIR/_locales" ]; then
    echo "LỖI: manifest khai báo default_locale nhưng không có $SRC_DIR/_locales/" >&2
    exit 1
  fi
fi

# Cảnh báo nếu quên thay OAuth client ID (không chặn — thêm kênh thủ công vẫn chạy)
if grep -q "DÁN_OAUTH_CLIENT_ID" "$SRC_DIR/manifest.json"; then
  echo "CẢNH BÁO: oauth2.client_id vẫn là placeholder — tính năng tải Subscriptions" >&2
  echo "          sẽ không dùng được. Xem docs/OAUTH-SETUP.md." >&2
fi

# background.js import từ lib/ — thiếu thư mục này thì extension chết ngay khi load.
if [ ! -d "$SRC_DIR/lib" ]; then
  echo "LỖI: thiếu $SRC_DIR/lib/" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
OUT_FILE_ABS="$(pwd)/$OUT_FILE"
rm -f "$OUT_FILE_ABS"

TMP_DIR=$(mktemp -d)
cp -a "$SRC_DIR/." "$TMP_DIR/"

# Môi trường PRD: Xoá trường "key" khỏi manifest.json để nộp lên Store
python3 -c "
import json
with open('$TMP_DIR/manifest.json', 'r') as f:
    d = json.load(f)
if 'key' in d:
    del d['key']
    print('Đã tự động xoá trường \"key\" khỏi manifest.json (Môi trường PRD)')
with open('$TMP_DIR/manifest.json', 'w') as f:
    json.dump(d, f, indent=2)
"

( cd "$TMP_DIR" && zip -rq "$OUT_FILE_ABS" . -x ".DS_Store" -x "__MACOSX/*" )
rm -rf "$TMP_DIR"

echo "Đã tạo $OUT_FILE ($(du -h "$OUT_FILE_ABS" | cut -f1))"
echo
echo "Nội dung:"
unzip -l "$OUT_FILE" | awk 'NR>3 && $0 !~ /^ *-+/ && $0 !~ /files?$/ { print }'
