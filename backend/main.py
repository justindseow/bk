from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware

from app.export_excel import build_excel_workbook, build_test_excel_workbook, export_filename
from app.models import ExportRequest

app = FastAPI(title="MacroByte BK Tool API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ],
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):517[3-9]",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health_check() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/export/excel")
def export_excel(payload: ExportRequest) -> StreamingResponse:
    workbook = build_excel_workbook(payload.session)
    filename = export_filename(payload.session)
    return StreamingResponse(
        workbook,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/export/test-excel")
def export_test_excel() -> StreamingResponse:
    workbook = build_test_excel_workbook()
    return StreamingResponse(
        workbook,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="MacroByte_BK_XYZ_Co_Sdn_Bhd_Jan_2025.xlsx"'},
    )
