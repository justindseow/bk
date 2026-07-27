import base64
import os

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware

from app.feedback import FeedbackEmailNotConfigured, feedback_email_configured, send_feedback_email
from app.export_excel import build_excel_workbook, build_test_excel_workbook, export_filename
from app.extractors.ai_provider import configured_provider
from app.intake_extractor import extract_intake_items
from app.extractors.smart_classification import can_use_smart_classifier
from app.extractors.vision import can_use_vision
from app.models import ExportRequest, FeedbackRequest, IntakeExtractJsonRequest

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
        "ai_provider": configured_provider(),
        "ai_vision": "configured" if can_use_vision() else "not_configured",
        "ai_classifier": "configured" if can_use_smart_classifier() else "not_configured",
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


@app.post("/intake/extract")
async def extract_source_documents(
    files: list[UploadFile] = File(...),
    upload_lane: str = Form("auto"),
    client_entity_name: str = Form(""),
) -> dict[str, object]:
    items = []
    for file in files:
        data = await file.read()
        try:
            items.extend(
                extract_intake_items(
                    file.filename or "uploaded-file",
                    file.content_type or "unknown",
                    data,
                    upload_lane=upload_lane,
                    client_entity_name=client_entity_name,
                )
            )
        except Exception as exc:
            items.append(
                {
                    "id": f"fatal-{len(items) + 1}",
                    "fileName": file.filename or "uploaded-file",
                    "fileType": file.content_type or "unknown",
                    "fileSize": len(data),
                    "uploadedAt": "",
                    "detectedType": "Unknown",
                    "target": "WP1",
                    "date": "",
                    "reference": "",
                    "party": (file.filename or "uploaded-file").rsplit(".", 1)[0],
                    "amount": 0,
                    "moneyIn": 0,
                    "moneyOut": 0,
                    "suggestedGlAccount": "",
                    "notes": "A protected API fallback was used because server extraction failed unexpectedly.",
                    "evidence": [],
                    "warnings": [f"Server extraction failed unexpectedly: {type(exc).__name__}: {exc}"],
                    "rawPreview": "",
                    "extractionMethod": "api-protected-fallback",
                    "overallConfidenceScore": 0.2,
                    "fieldConfidence": {},
                    "fieldEvidence": {},
                    "glSuggestions": [],
                    "rawSource": None,
                    "confidence": "Low",
                    "status": "Needs Review",
                }
            )
    return {"items": items}


@app.post("/intake/extract-json")
def extract_source_documents_json(payload: IntakeExtractJsonRequest) -> dict[str, object]:
    items = []
    for file in payload.files:
        try:
            data = base64.b64decode(file.data_base64.encode("utf-8"), validate=True)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid base64 payload for {file.file_name}.") from exc

        try:
            items.extend(
                extract_intake_items(
                    file.file_name,
                    file.content_type or "unknown",
                    data,
                    upload_lane=payload.upload_lane,
                    client_entity_name=payload.client_entity_name,
                )
            )
        except Exception as exc:
            items.append(
                {
                    "id": f"fatal-{len(items) + 1}",
                    "fileName": file.file_name,
                    "fileType": file.content_type or "unknown",
                    "fileSize": len(data),
                    "uploadedAt": "",
                    "detectedType": "Unknown",
                    "target": "WP1",
                    "date": "",
                    "reference": "",
                    "party": file.file_name.rsplit(".", 1)[0],
                    "amount": 0,
                    "moneyIn": 0,
                    "moneyOut": 0,
                    "suggestedGlAccount": "",
                    "notes": "A protected API fallback was used because server extraction failed unexpectedly.",
                    "evidence": [],
                    "warnings": [f"Server extraction failed unexpectedly: {type(exc).__name__}: {exc}"],
                    "rawPreview": "",
                    "extractionMethod": "api-protected-fallback",
                    "overallConfidenceScore": 0.2,
                    "fieldConfidence": {},
                    "fieldEvidence": {},
                    "glSuggestions": [],
                    "rawSource": None,
                    "confidence": "Low",
                    "status": "Needs Review",
                }
            )
    return {"items": items}


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
