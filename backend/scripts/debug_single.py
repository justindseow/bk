"""Show exactly what vision extracted vs what the pipeline returned."""
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

provider = sys.argv[1] if len(sys.argv) > 1 else "openai"
filename = sys.argv[2] if len(sys.argv) > 2 else "AYT SUPPLY_00432453.pdf"
os.environ["AI_PROVIDER"] = provider
sys.path.insert(0, str(BACKEND_ROOT))

from app.extractors.vision import extract_with_vision, can_use_vision
from app.extractors.ai_provider import configured_provider, vision_model

print(f"Provider: {configured_provider()}, Model: {vision_model()}, Vision OK: {can_use_vision()}")
print()

pdf_path = REPO_ROOT / "smaller test docs" / filename
data = pdf_path.read_bytes()
content_type = "application/pdf" if filename.endswith(".pdf") else "image/jpeg"

print(f"=== RAW VISION EXTRACTION: {filename} ===")
try:
    extraction = extract_with_vision(
        filename, content_type, data,
        upload_lane="auto",
        client_entity_name="Suburban Food Sdn Bhd",
    )
    print(f"  document_type:   {extraction.document_type}")
    print(f"  invoice_role:    {extraction.invoice_role}")
    print(f"  issuer_name:     {extraction.issuer_name}")
    print(f"  party:           {extraction.party}")
    print(f"  bill_to_name:    {extraction.bill_to_name}")
    print(f"  deliver_to_name: {extraction.deliver_to_name}")
    print(f"  document_date:   {extraction.document_date}")
    print(f"  total_amount:    {extraction.total_amount}")
    print(f"  overall_confidence: {extraction.overall_confidence}")
except Exception as exc:
    print(f"  FAILED: {exc}")

print()
print("=== PIPELINE OUTPUT ===")
from app.extractors.pipeline import extract_intake_items
items = extract_intake_items(filename, content_type, data,
                             upload_lane="auto", client_entity_name="Suburban Food Sdn Bhd")
for item in items:
    print(f"  party:  {item.get('party')}")
    print(f"  date:   {item.get('date')}")
    print(f"  amount: {item.get('amount')}")
    print(f"  notes:  {item.get('notes')}")
    print(f"  method: {item.get('extractionMethod')}")
    for w in (item.get('warnings') or []):
        print(f"  warn:   {w}")
