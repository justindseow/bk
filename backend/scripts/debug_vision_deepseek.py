"""Debug DeepSeek vision path."""
from __future__ import annotations
import os, re, sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent

def load_env(path):
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.match(r"^([A-Z0-9_]+)=(.*)$", line)
        if not match:
            continue
        key, raw = match.group(1), match.group(2)
        if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in ('"', "'"):
            raw = raw[1:-1]
        value = raw.replace("\\r\\n", "").replace("\\r", "").replace("\\n", "").strip()
        if value:
            os.environ[key] = value

load_env(REPO_ROOT / ".env.production.local")
os.environ["AI_PROVIDER"] = "openrouter"
os.environ["OPENROUTER_VISION_MODEL"] = "deepseek/deepseek-vl2"
sys.path.insert(0, str(BACKEND_ROOT))

from app.extractors.ai_provider import configured_provider, vision_model, can_use_provider

print(f"provider: {configured_provider()}, model: {vision_model()}, key: {can_use_provider()}")

pdf_path = REPO_ROOT / "smaller test docs" / "AYT SUPPLY_00431587.pdf"
data = pdf_path.read_bytes()

from app.extractors.pipeline import extract_intake_items
items = extract_intake_items(pdf_path.name, "application/pdf", data,
                             upload_lane="auto", client_entity_name="Suburban Food Sdn Bhd")
for item in items:
    print(f"  party:  {item.get('party')}")
    print(f"  notes:  {item.get('notes')}")
    print(f"  method: {item.get('extractionMethod')}")
    for w in (item.get('warnings') or []):
        print(f"  warn:   {w}")
