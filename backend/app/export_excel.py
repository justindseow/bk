from app.models import ExportPlaceholderResponse, ExportRequest


def build_placeholder_export_response(payload: ExportRequest) -> ExportPlaceholderResponse:
    client = payload.session.get("client", {})
    return ExportPlaceholderResponse(
        status="not_implemented",
        message="Excel export endpoint is wired. Workbook generation with openpyxl comes in the export phase.",
        received_entity=client.get("entityName") or client.get("entity_name"),
        received_period=client.get("period"),
    )
