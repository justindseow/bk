import re, os, sys
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

from app.extractors.ai_provider import configured_provider, vision_model, can_use_provider

print("AI_PROVIDER env:", os.getenv("AI_PROVIDER"))
print("ANTHROPIC_API_KEY set:", bool(os.getenv("ANTHROPIC_API_KEY")))
print()
print("configured_provider():", configured_provider())
print("vision_model():", vision_model())
print("can_use_provider():", can_use_provider())
