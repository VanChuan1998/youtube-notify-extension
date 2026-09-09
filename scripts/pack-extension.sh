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

mkdir -p "$OUT_DIR"
rm -f "$OUT_FILE"

# -x loại rác của macOS; zip chạy từ trong extension/ để file nằm ở gốc archive,
# đúng cấu trúc Chrome Web Store yêu cầu (manifest.json phải ở gốc zip).
( cd "$SRC_DIR" && zip -rq "../$OUT_FILE" . -x ".DS_Store" -x "__MACOSX/*" )

echo "Đã tạo $OUT_FILE ($(du -h "$OUT_FILE" | cut -f1))"
echo
echo "Nội dung:"
unzip -l "$OUT_FILE" | awk 'NR>3 && $0 !~ /^ *-+/ && $0 !~ /files?$/ { print }'
