import os

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware

from app.feedback import FeedbackEmailNotConfigured, feedback_email_configured, send_feedback_email
from app.export_excel import build_excel_workbook, build_test_excel_workbook, export_filename
from app.models import ExportRequest, FeedbackRequest

app = FastAPI(title="MacroByte BK Tool API")

default_origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5174",
]
configured_origins = [
    origin.strip()
    for origin in os.getenv("FRONTEND_ORIGINS", "").split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=default_origins + configured_origins,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):517[3-9]",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health_check() -> dict[str, str]:
    return {
        "status": "ok",
        "feedback_email": "configured" if feedback_email_configured() else "not_configured",
    }


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


@app.post("/feedback")
def submit_feedback(payload: FeedbackRequest) -> dict[str, str]:
    try:
        send_feedback_email(payload)
    except FeedbackEmailNotConfigured as exc:
        raise HTTPException(
            status_code=503,
            detail="Feedback email is not configured yet.",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail="Feedback could not be sent right now.",
        ) from exc

    return {"status": "sent"}
