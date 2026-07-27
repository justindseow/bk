import os, re, json
from pathlib import Path
from urllib import request

REPO_ROOT = Path(__file__).resolve().parents[2]
for line in (REPO_ROOT / ".env.production.local").read_text(encoding="utf-8", errors="ignore").splitlines():
    m = re.match(r"^([A-Z0-9_]+)=(.*)$", line.strip())
    if not m:
        continue
    k, v = m.group(1), m.group(2)
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
        v = v[1:-1]
    v = v.replace("\\r\\n", "").replace("\\r", "").replace("\\n", "").strip()
    if v:
        os.environ[k] = v

key = os.environ.get("OPENROUTER_API_KEY", "")
req = request.Request(
    "https://openrouter.ai/api/v1/models",
    headers={"Authorization": f"Bearer {key}"},
)
with request.urlopen(req, timeout=15) as r:
    data = json.loads(r.read())

models = [m["id"] for m in data.get("data", []) if "deepseek" in m["id"].lower()]
print("DeepSeek models on OpenRouter:")
for mid in sorted(models):
    print(f"  {mid}")
