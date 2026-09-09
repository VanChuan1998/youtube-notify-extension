#!/usr/bin/env bash
# Tải font từ Google Fonts về web/fonts/ để self-host.
#
# Vì sao self-host thay vì <link> tới fonts.googleapis.com:
#   - Trang landing quảng cáo quyền riêng tư mà lại để Google thấy IP của mọi
#     người truy cập thì mâu thuẫn.
#   - Không phụ thuộc mạng bên thứ ba (một số ISP Việt Nam từng chặn).
#   - Font tải cùng gốc với trang, nhanh hơn 1 vòng DNS + TLS.
#
# Script sinh ra web/fonts/*.woff2 và web/fonts.css. Chạy lại khi cần cập nhật.
# Kết quả được commit vào repo nên người khác clone về không cần chạy lại.

set -euo pipefail

cd "$(dirname "$0")/.."
OUT_DIR="web/fonts"
CSS_FILE="web/fonts.css"

# Chrome hiện đại -> Google trả về woff2 (định dạng nhỏ nhất).
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

# Chỉ giữ các bộ ký tự thật sự cần. Bỏ cyrillic/greek của Inter và JetBrains Mono
# tiết kiệm khoảng một nửa số file mà không ảnh hưởng gì tới trang tiếng Việt.
KEEP_SUBSETS="latin latin-ext vietnamese"

# Lưu ý: dùng dấu CÁCH trong tên font, không dùng dấu '+'. curl --data-urlencode
# sẽ encode '+' thành %2B và Google trả về HTTP 400.
FAMILIES=(
  "Fraunces:ital,opsz,wght@0,9..144,400..700;1,9..144,400..700"
  "Inter:wght@400..700"
  "JetBrains Mono:wght@400..500"
  "Newsreader:ital,opsz,wght@0,6..72,400..600;1,6..72,400..600"
)

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/*.woff2

RAW_CSS="$(mktemp)"
trap 'rm -f "$RAW_CSS"' EXIT

for family in "${FAMILIES[@]}"; do
  echo "→ tải CSS: $family"
  curl -fsS -A "$UA" \
    --get --data-urlencode "family=$family" --data "display=swap" \
    "https://fonts.googleapis.com/css2" >> "$RAW_CSS"
  printf '\n' >> "$RAW_CSS"
done

KEEP_SUBSETS="$KEEP_SUBSETS" OUT_DIR="$OUT_DIR" CSS_FILE="$CSS_FILE" \
python3 - "$RAW_CSS" <<'PY'
import os, re, subprocess, sys

raw = open(sys.argv[1], encoding="utf-8").read()
keep = set(os.environ["KEEP_SUBSETS"].split())
out_dir = os.environ["OUT_DIR"]
css_file = os.environ["CSS_FILE"]

# Google Fonts đặt tên subset trong comment ngay trước mỗi khối @font-face.
blocks = re.findall(r"/\*\s*([a-z-]+)\s*\*/\s*(@font-face\s*\{.*?\})", raw, re.S)
if not blocks:
    sys.exit("Không parse được @font-face nào — Google Fonts đổi định dạng?")

out, seen, kept = [], set(), 0
for subset, block in blocks:
    if subset not in keep:
        continue
    family = re.search(r"font-family:\s*'([^']+)'", block).group(1)
    style = re.search(r"font-style:\s*([^;]+);", block).group(1).strip()
    url = re.search(r"url\((https://[^)]+\.woff2)\)", block).group(1)

    slug = family.lower().replace(" ", "-")
    name = f"{slug}-{style}-{subset}.woff2"
    if name in seen:
        continue
    seen.add(name)

    dest = os.path.join(out_dir, name)
    subprocess.run(["curl", "-fsS", "-o", dest, url], check=True)
    out.append(re.sub(r"url\(https://[^)]+\.woff2\)", f"url('fonts/{name}')", block))
    kept += 1
    print(f"  ✓ {name} ({os.path.getsize(dest) // 1024} KB)")

header = (
    "/* Sinh tự động bởi scripts/fetch-fonts.sh — đừng sửa tay.\n"
    "   Font self-host, không gọi ra fonts.googleapis.com.\n"
    f"   Bộ ký tự giữ lại: {', '.join(sorted(keep))} */\n\n"
)
open(css_file, "w", encoding="utf-8").write(header + "\n\n".join(out) + "\n")
print(f"\nĐã ghi {css_file} với {kept} khối @font-face")
PY

TOTAL=$(du -sh "$OUT_DIR" | cut -f1)
echo "Tổng dung lượng $OUT_DIR: $TOTAL"
