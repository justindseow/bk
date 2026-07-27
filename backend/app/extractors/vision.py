from __future__ import annotations

import io
import os
from typing import Any

from .ai_provider import can_use_provider, completion_message_text, configured_provider, post_chat_completion, vision_model
from .memory import looks_bank_like, normalize_upload_lane
from .normalization import file_data_url, normalize, normalize_date, normalize_whitespace
from .postprocess import build_item
from .schemas import VisionDateRecovery, VisionDocumentExtraction, VisionFieldRecovery

VISION_SYSTEM_PROMPT = """
You extract bookkeeping intake data from Malaysian source documents.

Return only the schema fields. Do not invent values.
Leave a field blank when it is not visible.
Choose document_type from the allowed enum.
Choose target as:
- WP2 only for bank statements or bank transaction tables
- WP1 for invoices, receipts, bills, merchant statements, payroll, and loan support

For bank statements:
- Put one transaction per bank_rows entry
- Keep money_in and money_out positive
- Use reference when visible, otherwise leave blank

For non-bank documents:
- total_amount should be the posting amount on the document, not an outstanding balance unless that is clearly the payable amount
- suggested_gl_account should only be set when strongly implied by the document
- issuer_name should be the seller / supplier / statement issuer when visible
- bill_to_name should be the billed customer/entity when visible
- deliver_to_name should be the delivered customer/entity when visible
- invoice_role should be:
  - purchase when the document is a supplier invoice/bill received by the client
  - sales when the document is issued by the client to a customer
  - unknown when the role cannot be determined confidently
- use document_date for the invoice or statement date when visible; if only a delivery date is visible, use that and mention it in warnings

Confidence rules:
- overall_confidence is 0 to 1
- field_confidence keys should include the fields you are confident about
- field_evidence should contain short snippets describing where the value came from
""".strip()

DATE_RECOVERY_PROMPT = """
You are reading only the header/date area of a bookkeeping source document.

Return only the visible document date.

Rules:
- Prefer the invoice date / receipt date / statement date shown in the header.
- Do not guess from invoice numbers, references, timestamps, or unrelated numeric strings.
- Leave document_date blank if a full date is not clearly visible.
- Evidence should briefly say where the date was seen.
""".strip()

FIELD_RECOVERY_PROMPT = """
You are repairing weak field extraction from a likely invoice or bill image.

Return only fields that are clearly visible.

Rules:
- Prefer the supplier / issuer name shown in the FROM / seller / company header.
- Prefer the actual invoice number / bill number / document number as reference.
- Prefer the document grand total / total payable / invoice total as total_amount.
- Prefer the visible invoice date in the header.
- If the client entity appears in TO / Bill To / Deliver To and another company is the issuer, set invoice_role to purchase.
- If the client entity is the issuer and another party is the customer, set invoice_role to sales.
- If the page looks like a delivery order, packing list, or non-invoice support without a reliable total, leave document_type as Unknown and total_amount as 0.
- Do not guess from the filename.
- Evidence should briefly explain where each recovered field was seen.
""".strip()

INVOICE_RESCUE_PROMPT = """
You are repairing a failed bookkeeping extraction for a likely invoice or bill.

This document should be treated as invoice-first, not generic document intake.

Rules:
- Do not return document_type Unknown if the document visibly says invoice, tax invoice, bill, or cash sale / invoice.
- Determine whether it is Purchase Invoice or Sales Invoice using issuer, bill-to, deliver-to, and client entity context.
- If the client entity appears in Bill To / Deliver To / Customer and another company is the issuer, classify as Purchase Invoice.
- If the client entity is the issuer and another party is the customer, classify as Sales Invoice.
- Prefer the visible invoice date. If only a delivery date is visible, use that and note it in warnings.
- Prefer the actual invoice number / bill number / document number as reference.
- Prefer the document total / payable total / grand total as total_amount.
- Use issuer_name, bill_to_name, deliver_to_name, and invoice_role carefully.
- Only return Unknown if the page is genuinely unreadable.
""".strip()

try:
    import fitz  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    fitz = None

try:
    from PIL import Image, ImageEnhance, ImageFilter, ImageOps  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    Image = None
    ImageEnhance = None
    ImageFilter = None
    ImageOps = None


def vision_enabled() -> bool:
    enabled = os.getenv("OPENAI_VISION_ENABLED", "true").strip().lower()
    return enabled not in {"0", "false", "no", "off"}


def can_use_vision() -> bool:
    if not vision_enabled():
        return False
    return can_use_provider()


def _structured_retry_count() -> int:
    try:
        return max(1, int(os.getenv("AI_STRUCTURED_RETRIES", "2")))
    except ValueError:
        return 2


def _extract_json_object(raw_content: str) -> str:
    text = (raw_content or "").strip()
    if not text:
        return text
    start = text.find("{")
    if start < 0:
        return text

    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    return text


_FLOAT_DEFAULTS: dict[str, float] = {
    "total_amount": 0.0, "money_in": 0.0, "money_out": 0.0, "overall_confidence": 0.0,
}


def _coerce_vision_dict(obj: dict) -> dict:
    """Coerce GPT-style responses to match VisionDocumentExtraction field types."""
    if "field_evidence" in obj and isinstance(obj["field_evidence"], dict):
        obj["field_evidence"] = {
            k: [v] if isinstance(v, str) else (v if v is not None else [])
            for k, v in obj["field_evidence"].items()
        }
    if "field_confidence" in obj and isinstance(obj["field_confidence"], dict):
        obj["field_confidence"] = {
            k: float(v) if isinstance(v, (int, float, str)) and v is not None else 0.0
            for k, v in obj["field_confidence"].items()
        }
    for field, default in _FLOAT_DEFAULTS.items():
        if obj.get(field) is None:
            obj[field] = default
    return obj


def _parse_vision_response(raw_content: str) -> VisionDocumentExtraction:
    import json as _json
    try:
        return VisionDocumentExtraction.model_validate_json(raw_content)
    except Exception:
        pass
    try:
        coerced = _coerce_vision_dict(_json.loads(raw_content))
        return VisionDocumentExtraction.model_validate(_coerce_vision_dict(coerced))
    except Exception:
        pass
    extracted_json = _extract_json_object(raw_content)
    if extracted_json != raw_content:
        try:
            return VisionDocumentExtraction.model_validate_json(extracted_json)
        except Exception:
            pass
        try:
            coerced = _coerce_vision_dict(_json.loads(extracted_json))
            return VisionDocumentExtraction.model_validate(coerced)
        except Exception:
            pass
    try:
        return VisionDocumentExtraction.model_validate_json(raw_content)
    except Exception as exc:
        raise RuntimeError(f"Structured AI vision response was invalid: {exc}") from exc


def _parse_date_recovery_response(raw_content: str) -> VisionDateRecovery:
    try:
        return VisionDateRecovery.model_validate_json(raw_content)
    except Exception as exc:
        extracted_json = _extract_json_object(raw_content)
        if extracted_json != raw_content:
            try:
                return VisionDateRecovery.model_validate_json(extracted_json)
            except Exception:
                pass
        raise RuntimeError(f"Structured AI date-recovery response was invalid: {exc}") from exc


def _parse_field_recovery_response(raw_content: str) -> VisionFieldRecovery:
    try:
        return VisionFieldRecovery.model_validate_json(raw_content)
    except Exception as exc:
        extracted_json = _extract_json_object(raw_content)
        if extracted_json != raw_content:
            try:
                return VisionFieldRecovery.model_validate_json(extracted_json)
            except Exception:
                pass
        raise RuntimeError(f"Structured AI field-recovery response was invalid: {exc}") from exc


def extract_with_vision(
    filename: str,
    content_type: str,
    data: bytes,
    upload_lane: str | None = None,
    client_entity_name: str | None = None,
    hint_text: str | None = None,
    ) -> list[dict[str, Any]]:
    if not can_use_vision():
        raise RuntimeError("AI vision extraction is not configured.")

    extraction = _extract_with_provider(
        filename,
        content_type,
        data,
        upload_lane=upload_lane,
        client_entity_name=client_entity_name,
        hint_text=hint_text,
    )
    if _should_retry_invoice_rescue(filename, extraction, upload_lane):
        rescued = _extract_with_provider(
            filename,
            content_type,
            data,
            upload_lane=upload_lane,
            client_entity_name=client_entity_name,
            hint_text=hint_text,
            prompt_variant="invoice_rescue",
        )
        if _extraction_quality_score(rescued) > _extraction_quality_score(extraction):
            rescued.warnings = [*rescued.warnings, "Invoice-focused rescue extraction replaced a weaker generic result."]
            extraction = rescued
    return items_from_vision_result(
        filename,
        content_type,
        len(data),
        extraction,
        upload_lane=upload_lane,
        client_entity_name=client_entity_name,
    )


def recover_image_date_with_vision(
    filename: str,
    content_type: str,
    data: bytes,
) -> str:
    if not can_use_vision() or not content_type.startswith("image/"):
        return ""

    image_urls = _prepare_image_date_focus_variants(content_type, data)
    content = [
        {"type": "text", "text": f"Recover the visible document date from `{filename}`.\nUse the focused header/date crops first and only return a full visible date."},
    ]
    content.extend(
        {
            "type": "image_url",
            "image_url": {"url": image_url},
        }
        for image_url in image_urls
    )

    last_error: Exception | None = None
    for _ in range(_structured_retry_count()):
        response = post_chat_completion(
            model=vision_model(),
            messages=[
                {"role": "system", "content": DATE_RECOVERY_PROMPT},
                {"role": "user", "content": content},
            ],
            schema_name="vision_date_recovery",
            schema=VisionDateRecovery.model_json_schema(),
        )
        raw_content = completion_message_text(response)
        try:
            recovered = _parse_date_recovery_response(raw_content)
            return normalize_date(recovered.document_date)
        except Exception as exc:
            last_error = exc
    if last_error:
        raise last_error
    return ""


def recover_image_invoice_fields_with_vision(
    filename: str,
    content_type: str,
    data: bytes,
    *,
    client_entity_name: str | None = None,
) -> VisionFieldRecovery | None:
    if not can_use_vision() or not content_type.startswith("image/"):
        return None

    image_urls = _prepare_image_field_focus_variants(content_type, data)
    content = [
        {
            "type": "text",
            "text": (
                f"Repair weak invoice fields from `{filename}`.\n"
                f"{_client_prompt(client_entity_name)}\n"
                "Recover supplier/issuer, invoice number, invoice date, total amount, and purchase-vs-sales role only when they are clearly visible."
            ).strip(),
        },
    ]
    content.extend(
        {
            "type": "image_url",
            "image_url": {"url": image_url},
        }
        for image_url in image_urls
    )

    last_error: Exception | None = None
    for _ in range(_structured_retry_count()):
        response = post_chat_completion(
            model=vision_model(),
            messages=[
                {"role": "system", "content": FIELD_RECOVERY_PROMPT},
                {"role": "user", "content": content},
            ],
            schema_name="vision_field_recovery",
            schema=VisionFieldRecovery.model_json_schema(),
        )
        raw_content = completion_message_text(response)
        try:
            return _parse_field_recovery_response(raw_content)
        except Exception as exc:
            last_error = exc
    if last_error:
        raise last_error
    return None


def _extract_with_provider(
    filename: str,
    content_type: str,
    data: bytes,
    upload_lane: str | None = None,
    client_entity_name: str | None = None,
    hint_text: str | None = None,
    prompt_variant: str | None = None,
) -> VisionDocumentExtraction:
    if configured_provider() == "openrouter":
        return _extract_with_openrouter(
            filename,
            content_type,
            data,
            upload_lane=upload_lane,
            client_entity_name=client_entity_name,
            hint_text=hint_text,
            prompt_variant=prompt_variant,
        )
    return _extract_with_openai(
        filename,
        content_type,
        data,
        upload_lane=upload_lane,
        client_entity_name=client_entity_name,
        hint_text=hint_text,
        prompt_variant=prompt_variant,
    )


def _lane_prompt(upload_lane: str | None) -> str:
    lane = normalize_upload_lane(upload_lane)
    if lane == "purchases":
        return "Upload context: Purchases. Bias toward supplier-side purchase invoices, bills, and payment support unless the document clearly contradicts that."
    if lane == "sales":
        return "Upload context: Sales. Bias toward sales invoices, receipts, merchant settlements, and sales-side support unless the document clearly contradicts that."
    if lane == "bank":
        return "Upload context: Bank. Bias toward bank statements and bank-side transaction tables."
    if lane == "payments":
        return "Upload context: Payments. Bias toward payment vouchers, utility bills, and expense-side support unless the document clearly contradicts that."
    return ""


def _client_prompt(client_entity_name: str | None) -> str:
    entity = (client_entity_name or "").strip()
    if not entity:
        return ""
    return (
        f"Client entity name: {entity}.\n"
        "For invoice-like documents, determine whether this is a purchase invoice or a sales invoice.\n"
        "If the client entity appears in Bill To / Customer / Deliver To and another party appears as issuer, treat it as purchase-side.\n"
        "If the client entity appears as the issuer/seller and another party appears as customer, treat it as sales-side.\n"
        "Populate issuer_name, bill_to_name, deliver_to_name, and invoice_role."
    )


def _image_variant_instruction() -> str:
    return (
        "The attached images may include the same document in multiple views: full photo, enhanced photo, header crop, and footer crop. "
        "Combine them into one extraction. Prefer values that are corroborated across views. "
        "If supplier, customer, date, reference, or total is clearer in a crop than in the full image, use the clearer field."
    )


def _pdf_variant_instruction() -> str:
    return (
        "The attached PDF views may include full rendered pages plus cropped regions from the same page. "
        "Treat them as one document. Use the crops to recover small fields like invoice number, date, supplier, customer, totals, or balance figures."
    )


def _text_hint_prompt(hint_text: str | None) -> str:
    text = normalize_whitespace(hint_text or "")
    if not text:
        return ""
    return (
        "Supplemental OCR/text hints from preprocessing are below. "
        "Use them only as hints and prefer the visible document if there is any conflict.\n"
        f"{text}"
    )


def _serialize_image_png(image: Any) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _prepare_pil_variant_bytes(image: Any, *, max_dimension: int = 1400) -> list[bytes]:
    working = image.copy()
    if max(working.size) > max_dimension:
        working.thumbnail((max_dimension, max_dimension))

    variants: list[bytes] = []

    def append_core_variants(base_image: Any) -> None:
        if ImageOps is None or ImageEnhance is None:
            return
        grayscale = ImageOps.grayscale(base_image)
        enhanced = ImageOps.autocontrast(grayscale).convert("RGB")
        enhanced = ImageEnhance.Contrast(enhanced).enhance(1.55)
        enhanced = ImageEnhance.Sharpness(enhanced).enhance(1.65)
        if ImageFilter is not None:
            enhanced = enhanced.filter(ImageFilter.SHARPEN)
        variants.append(_serialize_image_png(enhanced))

        thresholded = ImageOps.autocontrast(grayscale)
        thresholded = thresholded.point(lambda pixel: 255 if pixel > 168 else 0, mode="1").convert("RGB")
        variants.append(_serialize_image_png(thresholded))

    variants.append(_serialize_image_png(working))
    append_core_variants(working)

    for angle in (90,):
        rotated = working.rotate(angle, expand=True)
        variants.append(_serialize_image_png(rotated))
        append_core_variants(rotated)

    width, height = working.size
    if width >= 400 and height >= 400:
        header_right_crop = working.crop((max(int(width * 0.45), 0), 0, width, max(int(height * 0.48), 1)))
        total_crop = working.crop((max(int(width * 0.45), 0), max(int(height * 0.52), 0), width, height))
        variants.append(_serialize_image_png(header_right_crop))
        variants.append(_serialize_image_png(total_crop))

    unique_variants: list[bytes] = []
    seen_payloads: set[bytes] = set()
    for variant_bytes in variants:
        if variant_bytes in seen_payloads:
            continue
        seen_payloads.add(variant_bytes)
        unique_variants.append(variant_bytes)
        if len(unique_variants) >= 5:
            break
    return unique_variants


def _prepare_image_variants(content_type: str, data: bytes) -> list[str]:
    original_url = file_data_url(content_type, data)
    if Image is None or ImageOps is None or ImageEnhance is None:
        return [original_url]

    try:
        image = Image.open(io.BytesIO(data))
        image = ImageOps.exif_transpose(image).convert("RGB")
    except Exception:
        return [original_url]

    unique_urls: list[str] = []
    for variant_bytes in _prepare_pil_variant_bytes(image):
        unique_urls.append(file_data_url("image/png", variant_bytes))

    return unique_urls or [original_url]


def _prepare_image_date_focus_variants(content_type: str, data: bytes) -> list[str]:
    original_url = file_data_url(content_type, data)
    if Image is None or ImageOps is None or ImageEnhance is None:
        return [original_url]

    try:
        image = Image.open(io.BytesIO(data))
        image = ImageOps.exif_transpose(image).convert("RGB")
    except Exception:
        return [original_url]

    width, height = image.size
    crop_boxes = [
        (int(width * 0.66), int(height * 0.01), int(width * 0.96), int(height * 0.12)),
        (int(width * 0.68), 0, int(width * 0.98), int(height * 0.10)),
        (int(width * 0.62), 0, int(width * 0.95), int(height * 0.16)),
        (int(width * 0.58), 0, width, int(height * 0.28)),
    ]

    urls: list[str] = [original_url]
    seen: set[bytes] = set()

    for left, top, right, bottom in crop_boxes:
        if right - left < 80 or bottom - top < 30:
            continue
        crop = image.crop((left, top, right, bottom))
        upscaled = crop.resize((crop.width * 3, crop.height * 3))
        grayscale = ImageOps.grayscale(upscaled)

        enhanced = ImageOps.autocontrast(grayscale).convert("RGB")
        enhanced = ImageEnhance.Contrast(enhanced).enhance(2.1)
        enhanced = ImageEnhance.Sharpness(enhanced).enhance(2.2)
        if ImageFilter is not None:
            enhanced = enhanced.filter(ImageFilter.SHARPEN)

        thresholded = ImageOps.autocontrast(grayscale)
        thresholded = thresholded.point(lambda pixel: 255 if pixel > 150 else 0, mode="1").convert("RGB")

        for candidate in (enhanced, thresholded):
            buffer = io.BytesIO()
            candidate.save(buffer, format="PNG")
            payload = buffer.getvalue()
            if payload in seen:
                continue
            seen.add(payload)
            urls.append(file_data_url("image/png", payload))
            if len(urls) >= 7:
                return urls

    return urls


def _prepare_image_field_focus_variants(content_type: str, data: bytes) -> list[str]:
    original_url = file_data_url(content_type, data)
    if Image is None or ImageOps is None or ImageEnhance is None:
        return [original_url]

    try:
        image = Image.open(io.BytesIO(data))
        image = ImageOps.exif_transpose(image).convert("RGB")
    except Exception:
        return [original_url]

    width, height = image.size
    crop_boxes = [
        (0, 0, width, max(int(height * 0.46), 1)),
        (0, 0, max(int(width * 0.58), 1), max(int(height * 0.42), 1)),
        (int(width * 0.42), 0, width, max(int(height * 0.34), 1)),
        (int(width * 0.52), int(height * 0.50), width, height),
        (0, int(height * 0.30), width, min(int(height * 0.86), height)),
    ]

    urls: list[str] = [original_url]
    seen: set[bytes] = set()

    for left, top, right, bottom in crop_boxes:
        if right - left < 100 or bottom - top < 60:
            continue
        crop = image.crop((left, top, right, bottom))
        upscale_factor = 3 if max(crop.size) < 1200 else 2
        upscaled = crop.resize((crop.width * upscale_factor, crop.height * upscale_factor))
        grayscale = ImageOps.grayscale(upscaled)

        enhanced = ImageOps.autocontrast(grayscale).convert("RGB")
        enhanced = ImageEnhance.Contrast(enhanced).enhance(2.0)
        enhanced = ImageEnhance.Sharpness(enhanced).enhance(2.2)
        if ImageFilter is not None:
            enhanced = enhanced.filter(ImageFilter.SHARPEN)

        thresholded = ImageOps.autocontrast(grayscale)
        thresholded = thresholded.point(lambda pixel: 255 if pixel > 155 else 0, mode="1").convert("RGB")

        for candidate in (enhanced, thresholded):
            buffer = io.BytesIO()
            candidate.save(buffer, format="PNG")
            payload = buffer.getvalue()
            if payload in seen:
                continue
            seen.add(payload)
            urls.append(file_data_url("image/png", payload))
            if len(urls) >= 7:
                return urls

    return urls


def _extract_with_openai(
    filename: str,
    content_type: str,
    data: bytes,
    upload_lane: str | None = None,
    client_entity_name: str | None = None,
    hint_text: str | None = None,
    prompt_variant: str | None = None,
) -> VisionDocumentExtraction:
    lane_prompt = _lane_prompt(upload_lane)
    client_prompt = _client_prompt(client_entity_name)
    prompt = f"Extract intake data from the uploaded file `{filename}`."
    if lane_prompt:
        prompt = f"{prompt}\n{lane_prompt}"
    if client_prompt:
        prompt = f"{prompt}\n{client_prompt}"
    hint_prompt = _text_hint_prompt(hint_text)
    if hint_prompt:
        prompt = f"{prompt}\n{hint_prompt}"
    if prompt_variant == "invoice_rescue":
        prompt = f"{prompt}\n{INVOICE_RESCUE_PROMPT}"

    page_images = _pdf_page_image_urls(content_type, data)

    if content_type.startswith("image/"):
        image_urls = _prepare_image_variants(content_type, data)
        content = [
            {"type": "text", "text": f"{prompt}\n{_image_variant_instruction()}"},
        ]
        content.extend(
            {
                "type": "image_url",
                "image_url": {"url": image_url},
            }
            for image_url in image_urls
        )
    elif page_images:
        content = [{"type": "text", "text": f"{prompt}\n{_pdf_variant_instruction()}"}]
        content.extend(
            {
                "type": "image_url",
                "image_url": {"url": page_image},
            }
            for page_image in page_images
        )
    else:
        raise RuntimeError("Direct OpenAI PDF vision needs page rendering. Use OpenRouter for file parsing or install PyMuPDF for PDF page images.")

    last_error: Exception | None = None
    for _ in range(_structured_retry_count()):
        response = post_chat_completion(
            model=vision_model(),
            messages=[
                {"role": "system", "content": _system_prompt(prompt_variant)},
                {"role": "user", "content": content},
            ],
            schema_name="vision_document_extraction",
            schema=VisionDocumentExtraction.model_json_schema(),
        )
        raw_content = completion_message_text(response)
        try:
            return _parse_vision_response(raw_content)
        except Exception as exc:
            last_error = exc
    assert last_error is not None
    raise last_error


def _extract_with_openrouter(
    filename: str,
    content_type: str,
    data: bytes,
    upload_lane: str | None = None,
    client_entity_name: str | None = None,
    hint_text: str | None = None,
    prompt_variant: str | None = None,
) -> VisionDocumentExtraction:
    lane_prompt = _lane_prompt(upload_lane)
    client_prompt = _client_prompt(client_entity_name)
    prompt = f"Extract intake data from the uploaded file `{filename}`."
    if lane_prompt:
        prompt = f"{prompt}\n{lane_prompt}"
    if client_prompt:
        prompt = f"{prompt}\n{client_prompt}"
    hint_prompt = _text_hint_prompt(hint_text)
    if hint_prompt:
        prompt = f"{prompt}\n{hint_prompt}"
    if prompt_variant == "invoice_rescue":
        prompt = f"{prompt}\n{INVOICE_RESCUE_PROMPT}"
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    extra_body: dict[str, Any] = {}
    page_images = _pdf_page_image_urls(content_type, data)

    if content_type.startswith("image/"):
        content[0] = {"type": "text", "text": f"{prompt}\n{_image_variant_instruction()}"}
        content.extend(
            {
                "type": "image_url",
                "image_url": {"url": image_url},
            }
            for image_url in _prepare_image_variants(content_type, data)
        )
    elif "pdf" in (content_type or "").lower() or data.lstrip().startswith(b"%PDF"):
        content[0] = {"type": "text", "text": f"{prompt}\n{_pdf_variant_instruction()}"}
        if page_images:
            content.extend(
                {
                    "type": "image_url",
                    "image_url": {"url": page_image},
                }
                for page_image in page_images
            )
        else:
            raise RuntimeError("OpenRouter vision could not render PDF pages. Ensure PyMuPDF is installed.")
    elif page_images:
        content.extend(
            {
                "type": "image_url",
                "image_url": {"url": page_image},
            }
            for page_image in page_images
        )
    else:
        raise RuntimeError("OpenRouter vision could not derive a readable document representation.")

    last_error: Exception | None = None
    for _ in range(_structured_retry_count()):
        response = post_chat_completion(
            model=vision_model(),
            messages=[
                {"role": "system", "content": _system_prompt(prompt_variant)},
                {"role": "user", "content": content},
            ],
            schema_name="vision_document_extraction",
            schema=VisionDocumentExtraction.model_json_schema(),
            extra_body=extra_body,
        )
        raw_content = completion_message_text(response)
        try:
            return _parse_vision_response(raw_content)
        except Exception as exc:
            last_error = exc
    assert last_error is not None
    raise last_error


def _system_prompt(prompt_variant: str | None) -> str:
    if prompt_variant == "invoice_rescue":
        return f"{VISION_SYSTEM_PROMPT}\n\n{INVOICE_RESCUE_PROMPT}"
    return VISION_SYSTEM_PROMPT


def _same_entity(left: str, right: str) -> bool:
    normalized_left = normalize(left)
    normalized_right = normalize(right)
    return bool(normalized_left and normalized_right and normalized_left == normalized_right)


def _has_client_match(candidate: str, client_entity_name: str | None) -> bool:
    candidate_normalized = normalize(candidate)
    client_normalized = normalize(client_entity_name or "")
    return bool(candidate_normalized and client_normalized and client_normalized in candidate_normalized)


def _has_distinct_billed_party(extraction: VisionDocumentExtraction) -> bool:
    billed_candidates = [
        normalize_whitespace(extraction.bill_to_name),
        normalize_whitespace(extraction.deliver_to_name),
    ]
    issuer_candidate = normalize_whitespace(extraction.issuer_name)
    if not issuer_candidate:
        return False
    return any(candidate and not _same_entity(candidate, issuer_candidate) for candidate in billed_candidates)


def _preferred_party_value(
    extraction: VisionDocumentExtraction,
    client_entity_name: str | None,
) -> str:
    client_entity = normalize_whitespace(client_entity_name or "")
    candidates = [
        normalize_whitespace(extraction.party),
        normalize_whitespace(extraction.issuer_name),
        normalize_whitespace(extraction.bill_to_name),
        normalize_whitespace(extraction.deliver_to_name),
    ]

    if extraction.invoice_role == "purchase":
        ordered = [
            normalize_whitespace(extraction.issuer_name),
            normalize_whitespace(extraction.party),
            normalize_whitespace(extraction.bill_to_name),
            normalize_whitespace(extraction.deliver_to_name),
        ]
        for candidate in ordered:
            if candidate and not _has_client_match(candidate, client_entity_name):
                return candidate

    if extraction.invoice_role == "sales":
        ordered = [
            normalize_whitespace(extraction.bill_to_name),
            normalize_whitespace(extraction.deliver_to_name),
            normalize_whitespace(extraction.party),
            normalize_whitespace(extraction.issuer_name),
        ]
        for candidate in ordered:
            if candidate:
                return candidate

    if client_entity_name:
        for candidate in candidates:
            if candidate and not _has_client_match(candidate, client_entity_name):
                return candidate

    return next((candidate for candidate in candidates if candidate), "")


def _looks_invoice_like(filename: str, extraction: VisionDocumentExtraction) -> bool:
    source = " ".join(
        [
            filename,
            extraction.summary,
            extraction.reference,
            extraction.party,
            extraction.issuer_name,
            extraction.bill_to_name,
            extraction.deliver_to_name,
        ]
    ).lower()
    return any(token in source for token in ("invoice", "tax invoice", "bill", "cash sale", "customer", "deliver to", "bill to"))


def _should_retry_invoice_rescue(
    filename: str,
    extraction: VisionDocumentExtraction,
    upload_lane: str | None,
) -> bool:
    lane = normalize_upload_lane(upload_lane)
    if lane not in {"purchases", "sales", "payments"} and not _looks_invoice_like(filename, extraction):
        return False
    if extraction.document_type == "Unknown":
        return True
    if extraction.document_type in {"Purchase Invoice", "Sales Invoice"}:
        return not extraction.document_date or float(extraction.total_amount or 0) <= 0
    return False


def _extraction_quality_score(extraction: VisionDocumentExtraction) -> int:
    score = 0
    if extraction.document_type and extraction.document_type != "Unknown":
        score += 3
    if extraction.document_type in {"Purchase Invoice", "Sales Invoice"}:
        score += 2
    if extraction.document_date:
        score += 2
    if float(extraction.total_amount or 0) > 0:
        score += 2
    if extraction.reference:
        score += 1
    if extraction.party or extraction.issuer_name:
        score += 1
    return score


def _pdf_page_image_urls(content_type: str, data: bytes, max_pages: int = 2, max_images: int = 6) -> list[str]:
    if fitz is None:
        return []
    if "pdf" not in (content_type or "").lower() and not data.lstrip().startswith(b"%PDF"):
        return []

    try:
        document = fitz.open(stream=data, filetype="pdf")
    except Exception:
        return []

    urls: list[str] = []
    try:
        page_count = min(document.page_count, max_pages)
        matrix = fitz.Matrix(2, 2)
        for page_index in range(page_count):
            page = document.load_page(page_index)
            pixmap = page.get_pixmap(matrix=matrix, alpha=False)
            page_png = pixmap.tobytes("png")
            urls.append(file_data_url("image/png", page_png))
            if page_index == 0 and Image is not None and ImageOps is not None and ImageEnhance is not None:
                try:
                    page_image = Image.open(io.BytesIO(page_png))
                    for variant_bytes in _prepare_pil_variant_bytes(page_image):
                        variant_url = file_data_url("image/png", variant_bytes)
                        if variant_url not in urls:
                            urls.append(variant_url)
                        if len(urls) >= max_images:
                            break
                except Exception:
                    pass
            if len(urls) >= max_images:
                break
    except Exception:
        return []
    finally:
        document.close()

    return urls


def items_from_vision_result(
    filename: str,
    content_type: str,
    file_size: int,
    extraction: VisionDocumentExtraction,
    upload_lane: str | None = None,
    client_entity_name: str | None = None,
) -> list[dict[str, Any]]:
    lane = normalize_upload_lane(upload_lane)
    normalized_client = (client_entity_name or "").strip().lower()
    bill_to = extraction.bill_to_name.strip().lower()
    deliver_to = extraction.deliver_to_name.strip().lower()
    issuer = extraction.issuer_name.strip().lower()
    distinct_billed_party = _has_distinct_billed_party(extraction)
    client_matches_issuer = _has_client_match(extraction.issuer_name, client_entity_name)

    if extraction.invoice_role == "purchase":
        extraction.document_type = "Purchase Invoice"
        extraction.target = "WP1"
        extraction.suggested_gl_account = extraction.suggested_gl_account or "5020 - Direct Materials"
        extraction.field_evidence.setdefault("document_type", []).append("Invoice role was determined as purchase-side.")
    elif extraction.invoice_role == "sales":
        if distinct_billed_party and not client_matches_issuer:
            extraction.document_type = "Purchase Invoice"
            extraction.target = "WP1"
            extraction.suggested_gl_account = extraction.suggested_gl_account or "5020 - Direct Materials"
            extraction.warnings.append(
                "Sales-side classification was downgraded because the invoice shows a separate billed party and a third-party issuer."
            )
            extraction.field_evidence.setdefault("document_type", []).append(
                "Distinct issuer and billed-party fields made the invoice look supplier-side."
            )
        else:
            extraction.document_type = "Sales Invoice"
            extraction.target = "WP1"
            extraction.suggested_gl_account = extraction.suggested_gl_account or "4100 - Sales Revenue"
            extraction.field_evidence.setdefault("document_type", []).append("Invoice role was determined as sales-side.")
    elif normalized_client:
        if normalized_client and ((bill_to and normalized_client in bill_to) or (deliver_to and normalized_client in deliver_to)):
            extraction.document_type = "Purchase Invoice"
            extraction.target = "WP1"
            extraction.suggested_gl_account = extraction.suggested_gl_account or "5020 - Direct Materials"
            extraction.field_evidence.setdefault("document_type", []).append("Client entity matched Bill To / Deliver To.")
        elif issuer and normalized_client in issuer:
            extraction.document_type = "Sales Invoice"
            extraction.target = "WP1"
            extraction.suggested_gl_account = extraction.suggested_gl_account or "4100 - Sales Revenue"
            extraction.field_evidence.setdefault("document_type", []).append("Client entity matched the issuer/header area.")
    elif distinct_billed_party and extraction.document_type in {"Unknown", "Sales Invoice"}:
        extraction.document_type = "Purchase Invoice"
        extraction.target = "WP1"
        extraction.suggested_gl_account = extraction.suggested_gl_account or "5020 - Direct Materials"
        extraction.field_evidence.setdefault("document_type", []).append(
            "Without a client issuer match, a distinct billed party and issuer were treated as purchase-side."
        )

    if lane == "purchases" and extraction.document_type == "Sales Invoice":
        extraction.document_type = "Purchase Invoice"
        extraction.target = "WP1"
        extraction.suggested_gl_account = extraction.suggested_gl_account or "5020 - Direct Materials"
        extraction.warnings.append("Purchases upload lane overrode a generic sales-invoice classification.")
        extraction.field_evidence.setdefault("document_type", []).append("Upload lane was Purchases.")
    elif lane == "sales" and extraction.document_type == "Purchase Invoice" and client_matches_issuer and not distinct_billed_party:
        extraction.document_type = "Sales Invoice"
        extraction.target = "WP1"
        extraction.suggested_gl_account = extraction.suggested_gl_account or "4100 - Sales Revenue"
        extraction.warnings.append("Sales upload lane overrode a generic purchase-invoice classification.")
        extraction.field_evidence.setdefault("document_type", []).append("Upload lane was Sales.")
    elif lane == "bank" and extraction.document_type != "Bank Statement" and looks_bank_like(
        " ".join(
            [
                filename,
                extraction.summary,
                extraction.reference,
                extraction.party,
                extraction.issuer_name,
                extraction.bill_to_name,
                extraction.deliver_to_name,
            ]
        )
    ):
        extraction.document_type = "Bank Statement"
        extraction.target = "WP2"
        extraction.suggested_gl_account = ""
        extraction.warnings.append("Bank upload lane overrode a non-bank classification guess.")
        extraction.field_evidence.setdefault("document_type", []).append("Upload lane was Bank.")

    party_value = _preferred_party_value(extraction, client_entity_name)
    base_evidence = [extraction.summary, *extraction.field_evidence.get("document_type", [])]
    base_warnings = list(extraction.warnings)

    client_entity = normalize_whitespace(client_entity_name or "")
    if client_entity and _has_client_match(party_value, client_entity_name):
        alternate_party = next(
            (
                candidate
                for candidate in [
                    normalize_whitespace(extraction.issuer_name),
                    normalize_whitespace(extraction.bill_to_name),
                    normalize_whitespace(extraction.deliver_to_name),
                ]
                if candidate and not _has_client_match(candidate, client_entity_name)
            ),
            "",
        )
        if alternate_party:
            party_value = alternate_party
            base_warnings.append("Party was redirected away from the client placeholder using issuer/customer context.")
        elif extraction.document_type in {"Purchase Invoice", "Sales Invoice"}:
            base_warnings.append("Party still matches the client entity. Review before posting.")

    if extraction.document_type == "Bank Statement" and extraction.bank_rows:
        items = []
        for index, row in enumerate(extraction.bank_rows, start=1):
            amount = max(float(row.money_in or 0), float(row.money_out or 0))
            row_evidence = [*row.evidence, *extraction.field_evidence.get("bank_rows", [])]
            items.append(
                build_item(
                    file_name=f"{filename} row {index}",
                    file_type=content_type,
                    file_size=file_size,
                    client_entity_name=client_entity_name,
                    detected_type="Bank Statement",
                    target="WP2",
                    date=normalize_date(row.date),
                    reference=row.reference,
                    party=row.description,
                    amount=amount,
                    money_in=float(row.money_in or 0),
                    money_out=float(row.money_out or 0),
                    suggested_gl_account="",
                    notes=extraction.notes or "Extracted from bank statement with AI vision.",
                    evidence=[line for line in row_evidence if line],
                    warnings=base_warnings,
                    raw_preview=extraction.summary or row.description,
                    overall_confidence_score=row.confidence or extraction.overall_confidence,
                    extraction_method=f"ai-vision-bank-statement:{configured_provider()}",
                    field_confidence={
                        "date": row.confidence or extraction.field_confidence.get("document_date", 0.0),
                        "reference": row.confidence or extraction.field_confidence.get("reference", 0.0),
                        "party": row.confidence,
                        "amount": row.confidence,
                    },
                    field_evidence={"bank_row": row_evidence},
                )
            )
        return items

    amount = float(extraction.total_amount or 0)
    money_in = float(extraction.money_in or 0)
    money_out = float(extraction.money_out or 0)

    return [
        build_item(
            file_name=filename,
            file_type=content_type,
            file_size=file_size,
            client_entity_name=client_entity_name,
            detected_type=extraction.document_type,
            target=extraction.target,
            date=extraction.document_date,
            reference=extraction.reference,
            party=party_value,
            amount=amount,
            money_in=money_in,
            money_out=money_out,
            suggested_gl_account=extraction.suggested_gl_account,
            notes=extraction.notes or "Extracted with AI vision.",
            evidence=[line for line in base_evidence if line],
            warnings=base_warnings,
            raw_preview=extraction.summary,
            overall_confidence_score=extraction.overall_confidence,
            extraction_method=f"ai-vision-document:{configured_provider()}",
            field_confidence=extraction.field_confidence,
            field_evidence=extraction.field_evidence,
        )
    ]
