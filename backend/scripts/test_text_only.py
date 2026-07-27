"""Test pipeline extraction with vision disabled (text-only)."""
from __future__ import annotations
import os, re, sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

for line in (REPO_ROOT / ".env.production.local").read_text(encoding="utf-8", errors="ignore").splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    m = re.match(r"^([A-Z0-9_]+)=(.*)$", line)
    if not m:
        continue
    k, v = m.group(1), m.group(2)
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
        v = v[1:-1]
    v = v.replace("\\r\\n", "").replace("\\r", "").replace("\\n", "").strip()
    if v:
        os.environ[k] = v

# Force vision OFF after env load
os.environ["OPENAI_VISION_ENABLED"] = "false"

sys.path.insert(0, str(BACKEND_ROOT))
from app.extractors.pipeline import extract_intake_items
from app.extractors.vision import can_use_vision

filename = sys.argv[1] if len(sys.argv) > 1 else "AYT SUPPLY_00431587.pdf"
suffix = Path(filename).suffix.lower()
content_type = "application/pdf" if suffix == ".pdf" else "image/jpeg"

print(f"Vision enabled: {can_use_vision()}")
print(f"File: {filename}")
print()

data = (REPO_ROOT / "smaller test docs" / filename).read_bytes()
items = extract_intake_items(filename, content_type, data, upload_lane="auto", client_entity_name="Suburban Food Sdn Bhd")
for item in items:
    print(f"  party:  {item.get('party')}")
    print(f"  date:   {item.get('date')}")
    print(f"  amount: {item.get('amount')}")
    print(f"  status: {item.get('status')}")
    print(f"  method: {item.get('extractionMethod')}")
    for w in (item.get("warnings") or []):
        print(f"  warn:   {w}")
