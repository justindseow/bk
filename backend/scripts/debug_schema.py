import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.extractors.schemas import VisionDocumentExtraction
from app.extractors.ai_provider import strict_json_schema

raw = VisionDocumentExtraction.model_json_schema()
strict = strict_json_schema(raw)

print("=== RAW schema (top-level properties) ===")
for k in raw.get("properties", {}).keys():
    print(f"  {k}")
print()
print("=== STRICT schema required[] ===")
print(strict.get("required"))
print()
print("=== field_confidence in strict schema ===")
props = strict.get("properties", {})
fc = props.get("field_confidence")
print(json.dumps(fc, indent=2))
print()
print("=== Full strict schema ===")
print(json.dumps(strict, indent=2))
