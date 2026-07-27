"""Debug why vision is falling back to OCR."""
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
sys.path.insert(0, str(BACKEND_ROOT))

from app.extractors.ai_provider import can_use_provider, configured_provider, vision_model
from app.extractors.vision import can_use_vision, vision_enabled

print("=== Provider check ===")
print(f"  configured_provider(): {configured_provider()}")
print(f"  vision_model():        {vision_model()}")
print(f"  can_use_provider():    {can_use_provider()}")
print(f"  vision_enabled():      {vision_enabled()}")
print(f"  can_use_vision():      {can_use_vision()}")
print(f"  OPENAI_VISION_ENABLED: {os.getenv('OPENAI_VISION_ENABLED')!r}")
print()

# Test a single PDF
pdf_path = REPO_ROOT / "smaller test docs" / "AYT SUPPLY_00431587.pdf"
if not pdf_path.exists():
    print(f"File not found: {pdf_path}")
    sys.exit(1)

data = pdf_path.read_bytes()
print(f"=== Extracting: {pdf_path.name} ({len(data)} bytes) ===")

from app.extractors.pipeline import extract_intake_items
items = extract_intake_items(
    pdf_path.name,
    "application/pdf",
    data,
    upload_lane="auto",
    client_entity_name="Suburban Food Sdn Bhd",
)

for item in items:
    print(f"  party:     {item.get('party')}")
    print(f"  date:      {item.get('date')}")
    print(f"  amount:    {item.get('amount')}")
    print(f"  notes:     {item.get('notes')}")
    print(f"  method:    {item.get('extractionMethod')}")
    print(f"  warnings:  {item.get('warnings')}")
