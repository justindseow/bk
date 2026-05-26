from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.export_excel import build_placeholder_export_response
from app.models import ExportPlaceholderResponse, ExportRequest

app = FastAPI(title="MacroByte BK Tool API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health_check() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/export/excel", response_model=ExportPlaceholderResponse)
def export_excel(payload: ExportRequest) -> ExportPlaceholderResponse:
    return build_placeholder_export_response(payload)
