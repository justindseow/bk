from __future__ import annotations

import io
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from typing import Any

from pypdf import PdfReader
try:
    import fitz  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    fitz = None

try:
    from PIL import Image, ImageEnhance, ImageOps, ImageFilter  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    Image = None
    ImageEnhance = None
    ImageOps = None
    ImageFilter = None

from .deterministic import extract_delimited_items, extract_spreadsheet_items, extract_text_item
from .memory import detect_type, normalize_upload_lane
from .normalization import clean_reference, confidence_label, current_timestamp, decode_text, looks_like_readable_text, normalize, normalize_date, normalize_whitespace, parse_amount
from .postprocess import _status_for, build_item, looks_like_placeholder_party
from .vision import can_use_vision, extract_with_vision, recover_image_date_with_vision, recover_image_invoice_fields_with_vision
from .ai_provider import provider_limit_warning

IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"}
TEXT_EXTENSIONS = {"csv", "txt", "tsv"}
SPREADSHEET_EXTENSIONS = {"xlsx", "xlsm", "xls"}
PDF_MAGIC = b"%PDF"
ZIP_MAGIC = b"PK\x03\x04"
OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
JPEG_MAGIC = b"\xff\xd8\xff"
GIF_MAGIC = b"GIF8"
BMP_MAGIC = b"BM"
TIFF_MAGICS = (b"II*\x00", b"MM\x00*")
TESSERACT_CANDIDATES = (
    os.getenv("TESSERACT_PATH", ""),
    shutil.which("tesseract") or "",
    r"C:\Program Files\Tesseract-OCR\tesseract.exe",
)
PDFTOPPM_CANDIDATES = (
    os.getenv("PDFTOPPM_PATH", ""),
    shutil.which("pdftoppm") or "",
    r"C:\Users\justin.seow\Downloads\poppler-25.12.0\Library\bin\pdftoppm.exe",
)
OCR_KEYWORD_PATTERN = re.compile(
    r"\b(invoice|tax invoice|receipt|statement|date|total|bill to|deliver to|customer|supplier|debit|credit|balance)\b",
    re.I,
)
OCR_AMOUNT_SCAN_PATTERN = re.compile(r"(?:RM\s*)?\(?(?:(?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.\d{2})?\)?", re.I)
CLEAR_DATE_PATTERN = re.compile(
    r"\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}|[A-Za-z]{3,9}\s+\d{1,2}[,./-]?\s+\d{2,4}|[A-Za-z]{3,9}\s+\d{1,2}\.\d{4})\b",
    re.I,
)
STRONG_NUMERIC_DATE_PATTERN = re.compile(
    r"\b(?:"
    r"(?:19\d{2}|20\d{2})[/-](?:0?[1-9]|1[0-2])[/-](?:0?[1-9]|[12]\d|3[01])"
    r"|"
    r"(?:0?[1-9]|[12]\d|3[01])[/-](?:0?[1-9]|1[0-2])[/-](?:19\d{2}|20\d{2})"
    r")\b",
    re.I,
)
DATE_LABEL_WINDOW_PATTERN = re.compile(
    r"(?:invoice\s*date|bill\s*date|receipt\s*date|statement\s*date|delivery\s*date|date)\s*[:=-]?\s*([^\n]{0,40})",
    re.I,
)
VISION_HINT_KEYWORD_PATTERN = re.compile(
    r"\b(invoice|tax invoice|receipt|statement|date|total|amount|grand total|net total|closing balance|balance|debit|credit|reference|ref|bill to|deliver to|customer|supplier|issuer|account)\b",
    re.I,
)
LOCAL_OCR_KEY_FIELDS_WARNING = "Local OCR result still needs review because key invoice fields were weak."
IMAGE_OCR_AMOUNT_MISMATCH_WARNING = "Image OCR saw much larger amount candidates than the extracted posting amount. Review before posting."
IMAGE_OCR_WEAK_DATE_PATTERN_WARNING = "Image OCR date did not appear in a clear full-date pattern. Review before posting."
IMAGE_OCR_WEAK_DATE_MATCH_WARNING = "Image OCR extracted a date, but it did not match a strong full-date candidate near the document date field. Review before posting."


def _resolve_command_path(candidates: tuple[str, ...]) -> str:
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    return ""


def _score_ocr_text(text: str) -> int:
    content = text.strip()
    if not content:
        return 0
    score = 0
    score += min(len(content) // 120, 8)
    score += len(OCR_KEYWORD_PATTERN.findall(content))
    score += min(len(re.findall(r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b", content)), 4)
    score += min(len(re.findall(r"(?:RM\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}", content, re.I)), 6)
    return score


def _build_vision_hint_text(*sources: str, max_lines: int = 36, max_chars: int = 3200) -> str:
    selected: list[str] = []
    seen: set[str] = set()

    def add_line(line: str) -> None:
        candidate = normalize_whitespace(line)
        if not candidate:
            return
        key = candidate.casefold()
        if key in seen:
            return
        seen.add(key)
        selected.append(candidate)

    for source in sources:
        text = source or ""
        if not text.strip():
            continue
        for raw_line in text.splitlines():
            line = normalize_whitespace(raw_line)
            if not line:
                continue
            if (
                VISION_HINT_KEYWORD_PATTERN.search(line)
                or re.search(r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b", line)
                or re.search(r"(?:RM\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}", line, re.I)
            ):
                add_line(line)
            if len(selected) >= max_lines:
                break
        if len(selected) >= max_lines:
            break

    if not selected:
        return ""

    chunks: list[str] = []
    total_chars = 0
    for line in selected:
        projected = total_chars + len(line) + (1 if chunks else 0)
        if projected > max_chars:
            break
        chunks.append(line)
        total_chars = projected
    return "\n".join(chunks)


def _orientation_candidates_for_ocr(input_path: Path, working_dir: Path) -> list[tuple[Path, str]]:
    candidates: list[tuple[Path, str]] = [(input_path, "0")]
    if Image is None or ImageOps is None:
        return candidates

    try:
        image = Image.open(input_path)
        image = ImageOps.exif_transpose(image).convert("RGB")
    except Exception:
        return candidates

    for angle in (90, 180, 270):
        rotated_path = working_dir / f"{input_path.stem}-rot{angle}.png"
        image.rotate(angle, expand=True).save(rotated_path, format="PNG")
        candidates.append((rotated_path, str(angle)))
    return candidates


def _run_tesseract_once(input_path: Path, working_dir: Path) -> tuple[str, str]:
    tesseract_path = _resolve_command_path(TESSERACT_CANDIDATES)
    if not tesseract_path:
        return "", "Local OCR is unavailable because Tesseract is not installed."

    best_text = ""
    best_score = -1
    warnings: list[str] = []

    for psm in ("6", "11", "4"):
        output_prefix = working_dir / f"ocr-psm{psm}"
        result = subprocess.run(
            [tesseract_path, str(input_path), str(output_prefix), "--psm", psm],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0 and result.stderr.strip():
            warnings.append(result.stderr.strip())
            continue

        text_path = output_prefix.with_suffix(".txt")
        if not text_path.exists():
            continue

        text = text_path.read_text(encoding="utf-8", errors="ignore")
        score = _score_ocr_text(text)
        if score > best_score:
            best_text = text
            best_score = score

    if best_text.strip():
        return best_text, ""

    return "", " ".join(warnings).strip() or "Local OCR did not recover readable text."


def _run_tesseract_custom_psms(input_path: Path, working_dir: Path, psms: tuple[str, ...]) -> tuple[str, str]:
    tesseract_path = _resolve_command_path(TESSERACT_CANDIDATES)
    if not tesseract_path:
        return "", "Local OCR is unavailable because Tesseract is not installed."

    best_text = ""
    best_score = -1
    warnings: list[str] = []

    for psm in psms:
        output_prefix = working_dir / f"ocr-psm{psm}"
        result = subprocess.run(
            [tesseract_path, str(input_path), str(output_prefix), "--psm", psm],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0 and result.stderr.strip():
            warnings.append(result.stderr.strip())
            continue

        text_path = output_prefix.with_suffix(".txt")
        if not text_path.exists():
            continue

        text = text_path.read_text(encoding="utf-8", errors="ignore")
        score = _score_ocr_text(text) + min(len(STRONG_NUMERIC_DATE_PATTERN.findall(text)) * 20, 40)
        if score > best_score:
            best_text = text
            best_score = score

    if best_text.strip():
        return best_text, ""

    return "", " ".join(warnings).strip() or "Local OCR did not recover readable text."


def _run_tesseract(input_path: Path, working_dir: Path) -> tuple[str, str]:
    best_text = ""
    best_score = -1
    warnings: list[str] = []

    for oriented_path, angle_label in _orientation_candidates_for_ocr(input_path, working_dir):
        candidate_dir = working_dir / f"angle-{angle_label}"
        candidate_dir.mkdir(exist_ok=True)
        candidate_text, candidate_warning = _run_tesseract_once(oriented_path, candidate_dir)
        if candidate_warning:
            warnings.append(f"angle {angle_label}: {candidate_warning}")
        score = _score_ocr_text(candidate_text)
        if score > best_score:
            best_text = candidate_text
            best_score = score

    if best_text.strip():
        return best_text, ""
    return "", " ".join(warnings).strip() or "Local OCR did not recover readable text."


def _extract_local_ocr_text_from_image(data: bytes, extension: str) -> tuple[str, str]:
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        best_text = ""
        best_score = -1
        warnings: list[str] = []

        for index, (variant_bytes, suffix) in enumerate(_image_variants_for_ocr(data, extension), start=1):
            input_path = temp_path / f"image-{index}{suffix}"
            variant_dir = temp_path / f"variant-{index}"
            variant_dir.mkdir(exist_ok=True)
            input_path.write_bytes(variant_bytes)
            candidate_text, candidate_warning = _run_tesseract(input_path, variant_dir)
            if candidate_warning:
                warnings.append(f"variant {index}: {candidate_warning}")
            score = _score_ocr_text(candidate_text)
            if score > best_score:
                best_text = candidate_text
                best_score = score

        if best_text.strip():
            return best_text, ""
        return "", " ".join(warnings).strip() or "Local OCR did not recover readable text."


def _extract_image_header_date_candidate(data: bytes, extension: str) -> str:
    if Image is None or ImageOps is None or ImageEnhance is None:
        return ""

    try:
        image = Image.open(io.BytesIO(data))
        image = ImageOps.exif_transpose(image).convert("RGB")
    except Exception:
        return ""

    width, height = image.size
    if width < 300 or height < 200:
        return ""

    crop_boxes = [
        (int(width * 0.66), int(height * 0.01), int(width * 0.96), int(height * 0.12)),
        (int(width * 0.68), 0, int(width * 0.98), int(height * 0.10)),
        (int(width * 0.62), 0, int(width * 0.95), int(height * 0.16)),
        (int(width * 0.58), 0, width, int(height * 0.28)),
        (int(width * 0.52), 0, width, int(height * 0.34)),
        (int(width * 0.60), int(height * 0.02), int(width * 0.96), int(height * 0.24)),
        (int(width * 0.54), int(height * 0.04), int(width * 0.92), int(height * 0.20)),
    ]

    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        for index, box in enumerate(crop_boxes, start=1):
            left, top, right, bottom = box
            if right - left < 80 or bottom - top < 40:
                continue

            crop = image.crop((left, top, right, bottom))
            variant_builders: list[tuple[str, Any]] = []
            upscaled = crop.resize((crop.width * 4, crop.height * 4))
            grayscale = ImageOps.grayscale(upscaled)

            enhanced = ImageOps.autocontrast(grayscale).convert("RGB")
            enhanced = ImageEnhance.Contrast(enhanced).enhance(2.2)
            enhanced = ImageEnhance.Sharpness(enhanced).enhance(2.3)
            if ImageFilter is not None:
                enhanced = enhanced.filter(ImageFilter.SHARPEN)
            variant_builders.append(("enhanced", enhanced))

            thresholded = ImageOps.autocontrast(grayscale)
            thresholded = thresholded.point(lambda pixel: 255 if pixel > 150 else 0, mode="1").convert("RGB")
            variant_builders.append(("thresholded", thresholded))

            for variant_name, variant_image in variant_builders:
                crop_path = temp_path / f"header-crop-{index}-{variant_name}.png"
                variant_image.save(crop_path, format="PNG")
                candidate_dir = temp_path / f"header-crop-{index}-{variant_name}"
                candidate_dir.mkdir(exist_ok=True)
                candidate_text, _ = _run_tesseract_custom_psms(crop_path, candidate_dir, ("7", "13", "6"))

                labeled_match = DATE_LABEL_WINDOW_PATTERN.search(candidate_text)
                if labeled_match:
                    labeled_window = labeled_match.group(1)
                    strong_match = STRONG_NUMERIC_DATE_PATTERN.search(labeled_window)
                    if strong_match:
                        normalized = normalize_date(strong_match.group(0))
                        if normalized:
                            return normalized

                strong_match = STRONG_NUMERIC_DATE_PATTERN.search(candidate_text)
                if strong_match:
                    normalized = normalize_date(strong_match.group(0))
                    if normalized:
                        return normalized

    return ""


def _image_variants_for_ocr(data: bytes, extension: str) -> list[tuple[bytes, str]]:
    default_suffix = extension or ".png"
    variants: list[tuple[bytes, str]] = [(data, default_suffix)]

    if Image is None or ImageOps is None or ImageEnhance is None:
        return variants

    try:
        image = Image.open(io.BytesIO(data))
        image = ImageOps.exif_transpose(image).convert("RGB")
    except Exception:
        return variants

    max_dimension = 1800
    working = image.copy()
    if max(working.size) > max_dimension:
        working.thumbnail((max_dimension, max_dimension))

    def as_png_bytes(candidate: Any) -> bytes:
        buffer = io.BytesIO()
        candidate.save(buffer, format="PNG")
        return buffer.getvalue()

    def append_core_variants(base_image: Any) -> None:
        grayscale = ImageOps.grayscale(base_image)
        enhanced = ImageOps.autocontrast(grayscale).convert("RGB")
        enhanced = ImageEnhance.Contrast(enhanced).enhance(1.55)
        enhanced = ImageEnhance.Sharpness(enhanced).enhance(1.65)
        if ImageFilter is not None:
            enhanced = enhanced.filter(ImageFilter.SHARPEN)
        variants.append((as_png_bytes(enhanced), ".png"))

        thresholded = ImageOps.autocontrast(grayscale)
        thresholded = thresholded.point(lambda pixel: 255 if pixel > 168 else 0, mode="1").convert("RGB")
        variants.append((as_png_bytes(thresholded), ".png"))

    append_core_variants(working)

    # Phone photos are often uploaded sideways even after EXIF transpose.
    for angle in (90, 270):
        rotated = working.rotate(angle, expand=True)
        variants.append((as_png_bytes(rotated), ".png"))
        append_core_variants(rotated)

    width, height = working.size
    if height >= 400:
        variants.append((as_png_bytes(working.crop((0, 0, width, max(int(height * 0.42), 1)))), ".png"))
        variants.append((as_png_bytes(working.crop((0, max(int(height * 0.58), 0), width, height))), ".png"))
    if width >= 400 and height >= 400:
        variants.append((as_png_bytes(working.crop((max(int(width * 0.45), 0), max(int(height * 0.52), 0), width, height))), ".png"))

    unique_variants: list[tuple[bytes, str]] = []
    seen: set[bytes] = set()
    for variant_bytes, suffix in variants:
        if variant_bytes in seen:
            continue
        seen.add(variant_bytes)
        unique_variants.append((variant_bytes, suffix))
        if len(unique_variants) >= 9:
            break
    return unique_variants


def _extract_local_ocr_text_from_pdf(data: bytes) -> tuple[str, str]:
    pdftoppm_path = _resolve_command_path(PDFTOPPM_CANDIDATES)
    if not pdftoppm_path:
        return "", "Local OCR PDF rasterizer is unavailable."

    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        pdf_path = temp_path / "document.pdf"
        pdf_path.write_bytes(data)
        image_prefix = temp_path / "page"

        render = subprocess.run(
            [pdftoppm_path, "-png", "-r", "200", "-f", "1", "-l", "3", str(pdf_path), str(image_prefix)],
            capture_output=True,
            text=True,
        )
        if render.returncode != 0:
            return "", render.stderr.strip() or "pdftoppm failed to rasterize the PDF for OCR."

        page_images = sorted(temp_path.glob("page-*.png"))
        if not page_images:
            single_image = image_prefix.with_suffix(".png")
            if single_image.exists():
                page_images = [single_image]
        if not page_images:
            return "", "PDF OCR rasterization did not produce any page images."

        texts: list[str] = []
        warnings: list[str] = []
        for index, image_path in enumerate(page_images, start=1):
            page_dir = temp_path / f"ocr-page-{index}"
            page_dir.mkdir(exist_ok=True)
            page_text, page_warning = _run_tesseract(image_path, page_dir)
            if page_text.strip():
                texts.append(page_text)
            elif page_warning:
                warnings.append(f"page {index}: {page_warning}")

        if texts:
            return "\n\n".join(texts), ""

        return "", " ".join(warnings).strip() or "Local OCR did not recover readable PDF text."


def _items_from_local_ocr(
    *,
    filename: str,
    content_type: str,
    data: bytes,
    ocr_text: str,
    upload_lane: str | None,
    client_entity_name: str | None,
    source_label: str,
) -> list[dict[str, Any]]:
    if not ocr_text.strip():
        return []

    amount_candidates: list[float] = []
    for match in OCR_AMOUNT_SCAN_PATTERN.finditer(ocr_text):
        raw_value = match.group(0)
        if "." not in raw_value and "RM" not in raw_value.upper() and "," not in raw_value:
            continue
        candidate = parse_amount(raw_value)
        if 0 < candidate < 100000:
            amount_candidates.append(candidate)

    strong_date_candidates = _strong_date_candidates_from_ocr(ocr_text) if source_label == "Image" else set()
    recovered_header_date = _extract_image_header_date_candidate(data, Path(filename).suffix.lower()) if source_label == "Image" else ""
    recovered_vision_date = ""
    if source_label == "Image" and not recovered_header_date and can_use_vision():
        try:
            recovered_vision_date = recover_image_date_with_vision(filename, content_type, data)
        except Exception:
            recovered_vision_date = ""
    recovered_best_date = recovered_header_date or recovered_vision_date
    if recovered_best_date:
        strong_date_candidates.add(recovered_best_date)

    items = extract_text_item(
        filename,
        content_type,
        ocr_text.encode("utf-8"),
        upload_lane=upload_lane,
        client_entity_name=client_entity_name,
    )
    for item in items:
        method = item.get("extractionMethod", "text-parser")
        item["extractionMethod"] = f"{method}+local-ocr"
        item["notes"] = f"{source_label} local OCR fallback was used."
        warnings = list(item.get("warnings", []))
        ocr_warning = f"{source_label} local OCR fallback was used because embedded text was unavailable."
        if ocr_warning not in warnings:
            warnings.append(ocr_warning)
        item["warnings"] = warnings
        if not item.get("fileSize"):
            item["fileSize"] = len(data)
        if not item.get("fileType"):
            item["fileType"] = content_type
        if source_label == "Image" and recovered_best_date:
            extracted_date = str(item.get("date", "")).strip()
            if not extracted_date or extracted_date != recovered_best_date:
                item["date"] = recovered_best_date
                item.setdefault("fieldConfidence", {})
                item["fieldConfidence"]["date"] = max(
                    float(item.get("fieldConfidence", {}).get("date", 0.0)),
                    0.96 if recovered_vision_date else 0.93,
                )
                item.setdefault("fieldEvidence", {})
                item["fieldEvidence"]["date"] = [
                    "Recovered from a focused vision pass on the image header date area."
                    if recovered_vision_date
                    else "Recovered from a focused OCR pass on the image header date area."
                ]
                evidence = list(item.get("evidence", []))
                recovery_note = (
                    "Focused vision on the image header recovered the invoice date."
                    if recovered_vision_date
                    else "Focused OCR on the image header recovered the invoice date."
                )
                if recovery_note not in evidence:
                    evidence.append(recovery_note)
                item["evidence"] = evidence
        amount = float(item.get("amount") or 0.0)
        if item.get("target") == "WP1" and (amount <= 1.0 or not str(item.get("date", "")).strip()):
            item["status"] = "Needs Review"
            item["confidence"] = "Low" if amount <= 1.0 else item.get("confidence", "Medium")
            review_warning = LOCAL_OCR_KEY_FIELDS_WARNING
            if review_warning not in item["warnings"]:
                item["warnings"].append(review_warning)
        if source_label == "Image" and item.get("target") == "WP1" and amount > 0:
            much_larger_amount_seen = any(
                candidate >= max(amount * 3, amount + 20)
                for candidate in amount_candidates
            )
            if much_larger_amount_seen:
                item["status"] = "Needs Review"
                item["confidence"] = "Low"
                review_warning = IMAGE_OCR_AMOUNT_MISMATCH_WARNING
                if review_warning not in item["warnings"]:
                    item["warnings"].append(review_warning)
        if source_label == "Image" and item.get("target") == "WP1" and str(item.get("date", "")).strip():
            extracted_date = str(item.get("date", "")).strip()
            if not CLEAR_DATE_PATTERN.search(ocr_text):
                item["status"] = "Needs Review"
                item["confidence"] = "Low"
                review_warning = IMAGE_OCR_WEAK_DATE_PATTERN_WARNING
                if review_warning not in item["warnings"]:
                    item["warnings"].append(review_warning)
            elif not strong_date_candidates or extracted_date not in strong_date_candidates:
                item["status"] = "Needs Review"
                item["confidence"] = "Low"
                review_warning = IMAGE_OCR_WEAK_DATE_MATCH_WARNING
                if review_warning not in item["warnings"]:
                    item["warnings"].append(review_warning)

    if source_label == "Image" and len(items) == 1 and can_use_vision():
        candidate_item = items[0]
        if _should_attempt_image_field_recovery(
            candidate_item,
            amount_candidates=amount_candidates,
            client_entity_name=client_entity_name,
        ):
            try:
                recovery = recover_image_invoice_fields_with_vision(
                    filename,
                    content_type,
                    data,
                    client_entity_name=client_entity_name,
                )
            except Exception:
                recovery = None
            if recovery is not None:
                items[0] = _apply_image_field_recovery(
                    candidate_item,
                    recovery=recovery,
                    client_entity_name=client_entity_name,
                    amount_candidates=amount_candidates,
                )
    return items


def _strong_date_candidates_from_ocr(ocr_text: str) -> set[str]:
    candidates: set[str] = set()

    for match in STRONG_NUMERIC_DATE_PATTERN.finditer(ocr_text):
        normalized = normalize_date(match.group(0))
        if normalized:
            candidates.add(normalized)

    for match in CLEAR_DATE_PATTERN.finditer(ocr_text):
        raw = match.group(0)
        if not STRONG_NUMERIC_DATE_PATTERN.search(raw):
            continue
        normalized = normalize_date(raw)
        if normalized:
            candidates.add(normalized)

    for match in DATE_LABEL_WINDOW_PATTERN.finditer(ocr_text):
        window = match.group(1)
        strong_match = STRONG_NUMERIC_DATE_PATTERN.search(window)
        if strong_match:
            normalized = normalize_date(strong_match.group(0))
            if normalized:
                candidates.add(normalized)

    return candidates


def _append_warning_once(item: dict[str, Any], warning: str) -> None:
    if not warning:
        return
    warnings = list(item.get("warnings", []))
    if warning not in warnings:
        warnings.append(warning)
    item["warnings"] = warnings


def _same_entity_name(left: str, right: str) -> bool:
    normalized_left = normalize(left)
    normalized_right = normalize(right)
    return bool(normalized_left and normalized_right and normalized_left == normalized_right)


def _reference_needs_recovery(item: dict[str, Any]) -> bool:
    reference = str(item.get("reference", "")).strip()
    if not reference:
        return True
    if not re.search(r"\d", reference):
        return True
    return False


def _party_quality_score(value: str) -> int:
    cleaned = normalize_whitespace(value)
    if not cleaned:
        return 0

    lowered = cleaned.lower()
    alpha_only = re.sub(r"[^a-z]+", "", lowered)
    score = 0
    if len(alpha_only) >= 8:
        score += 1
    if re.search(r"\b(sdn|bhd|enterprise|trading|services|supply|supplies|resources|restaurant|cafe|kitchen|marketing|industries)\b", lowered):
        score += 3
    if 2 <= len(cleaned.split()) <= 8:
        score += 1
    if re.search(r"[A-Za-z]", cleaned):
        score += 1
    if re.search(r"[_—=]", cleaned):
        score -= 2
    if any(token in lowered for token in ("regenerated document", "signature", "invoice date", "thank you", "customer copy")):
        score -= 2
    if len(re.findall(r"[A-Za-z]", cleaned)) < max(6, len(cleaned) // 3):
        score -= 1
    return score


def _party_needs_recovery(item: dict[str, Any], client_entity_name: str | None) -> bool:
    if _looks_like_placeholder_party(item, client_entity_name):
        return True
    return _party_quality_score(str(item.get("party", ""))) < 4


def _should_attempt_image_field_recovery(
    item: dict[str, Any],
    *,
    amount_candidates: list[float],
    client_entity_name: str | None,
) -> bool:
    if item.get("target") != "WP1":
        return False
    if item.get("detectedType") == "Unknown":
        return True
    if not str(item.get("date", "")).strip():
        return True
    if _reference_needs_recovery(item):
        return True
    if _looks_like_placeholder_party(item, client_entity_name):
        return True

    amount = float(item.get("amount") or 0.0)
    if amount <= 1.0:
        return True
    if any(candidate >= max(amount * 1.35, amount + 40.0) for candidate in amount_candidates):
        return True
    return False


def _resolved_party_from_recovery(
    recovery: Any,
    client_entity_name: str | None,
) -> str:
    client_entity = normalize_whitespace(client_entity_name or "")
    ordered_candidates: list[str]

    if recovery.invoice_role == "purchase":
        ordered_candidates = [
            normalize_whitespace(recovery.issuer_name),
            normalize_whitespace(recovery.bill_to_name),
            normalize_whitespace(recovery.deliver_to_name),
        ]
    elif recovery.invoice_role == "sales":
        ordered_candidates = [
            normalize_whitespace(recovery.bill_to_name),
            normalize_whitespace(recovery.deliver_to_name),
            normalize_whitespace(recovery.issuer_name),
        ]
    else:
        ordered_candidates = [
            normalize_whitespace(recovery.issuer_name),
            normalize_whitespace(recovery.bill_to_name),
            normalize_whitespace(recovery.deliver_to_name),
        ]

    for candidate in ordered_candidates:
        if candidate and not _same_entity_name(candidate, client_entity):
            return candidate
    return next((candidate for candidate in ordered_candidates if candidate), "")


def _apply_image_field_recovery(
    item: dict[str, Any],
    *,
    recovery: Any,
    client_entity_name: str | None,
    amount_candidates: list[float],
) -> dict[str, Any]:
    updated = dict(item)
    warnings = list(updated.get("warnings", []))
    evidence = list(updated.get("evidence", []))
    field_confidence = dict(updated.get("fieldConfidence", {}))
    field_evidence = dict(updated.get("fieldEvidence", {}))
    updated_fields: list[str] = []

    recovered_date = normalize_date(recovery.document_date)
    if recovered_date and (not str(updated.get("date", "")).strip() or str(updated.get("date", "")).strip() != recovered_date):
        updated["date"] = recovered_date
        field_confidence["date"] = max(float(field_confidence.get("date", 0.0)), float(recovery.field_confidence.get("document_date", recovery.confidence or 0.0)))
        field_evidence["date"] = list(recovery.field_evidence.get("document_date", [])) or ["Focused vision pass recovered the invoice date from the image."]
        updated_fields.append("date")

    recovered_reference = clean_reference(recovery.reference) if recovery.reference else ""
    if recovered_reference and (_reference_needs_recovery(updated) or recovered_reference != str(updated.get("reference", "")).strip()):
        updated["reference"] = recovered_reference
        field_confidence["reference"] = max(float(field_confidence.get("reference", 0.0)), float(recovery.field_confidence.get("reference", recovery.confidence or 0.0)))
        field_evidence["reference"] = list(recovery.field_evidence.get("reference", [])) or ["Focused vision pass recovered the invoice number from the image."]
        updated_fields.append("reference")

    current_amount = float(updated.get("amount") or 0.0)
    recovered_amount = float(recovery.total_amount or 0.0)
    if recovered_amount > 0 and (
        current_amount <= 1.0
        or any(candidate >= max(current_amount * 1.35, current_amount + 40.0) for candidate in amount_candidates)
        or abs(recovered_amount - current_amount) >= max(25.0, current_amount * 0.3)
    ):
        updated["amount"] = round(recovered_amount, 2)
        field_confidence["amount"] = max(float(field_confidence.get("amount", 0.0)), float(recovery.field_confidence.get("total_amount", recovery.confidence or 0.0)))
        field_evidence["amount"] = list(recovery.field_evidence.get("total_amount", [])) or ["Focused vision pass recovered the invoice total from the image."]
        updated_fields.append("amount")

    recovered_party = _resolved_party_from_recovery(recovery, client_entity_name)
    if recovered_party and (
        _party_needs_recovery(updated, client_entity_name)
        or _party_quality_score(recovered_party) > _party_quality_score(str(updated.get("party", ""))) + 1
    ):
        updated["party"] = recovered_party
        field_confidence["party"] = max(float(field_confidence.get("party", 0.0)), float(recovery.field_confidence.get("issuer_name", recovery.confidence or 0.0)))
        field_evidence["party"] = (
            list(recovery.field_evidence.get("issuer_name", []))
            or list(recovery.field_evidence.get("bill_to_name", []))
            or ["Focused vision pass recovered the supplier / customer name from the image."]
        )
        updated_fields.append("party")

    client_entity = normalize_whitespace(client_entity_name or "")
    bill_to_name = normalize_whitespace(getattr(recovery, "bill_to_name", ""))
    deliver_to_name = normalize_whitespace(getattr(recovery, "deliver_to_name", ""))
    issuer_name = normalize_whitespace(getattr(recovery, "issuer_name", ""))
    recovery_text_evidence = " ".join(
        [
            str(getattr(recovery, "document_type", "") or ""),
            *list(recovery.field_evidence.get("document_type", [])),
            *list(recovery.field_evidence.get("issuer_name", [])),
        ]
    ).lower()

    recovered_doc_type = ""
    recovered_gl = ""
    if any(token in recovery_text_evidence for token in ("p/invoice", "purchase invoice", "supplier invoice")):
        recovered_doc_type = "Purchase Invoice"
        recovered_gl = "5020 - Direct Materials"
    elif recovery.invoice_role == "purchase":
        recovered_doc_type = "Purchase Invoice"
        recovered_gl = "5020 - Direct Materials"
    elif recovery.invoice_role == "sales":
        recovered_doc_type = "Sales Invoice"
        recovered_gl = "4100 - Sales Revenue"
    elif recovery.document_type in {"Purchase Invoice", "Sales Invoice"}:
        recovered_doc_type = recovery.document_type
        recovered_gl = "5020 - Direct Materials" if recovery.document_type == "Purchase Invoice" else "4100 - Sales Revenue"
    elif client_entity and ((bill_to_name and _same_entity_name(bill_to_name, client_entity)) or (deliver_to_name and _same_entity_name(deliver_to_name, client_entity))):
        if issuer_name and not _same_entity_name(issuer_name, client_entity):
            recovered_doc_type = "Purchase Invoice"
            recovered_gl = "5020 - Direct Materials"
    elif client_entity and issuer_name and _same_entity_name(issuer_name, client_entity):
        if bill_to_name or deliver_to_name:
            recovered_doc_type = "Sales Invoice"
            recovered_gl = "4100 - Sales Revenue"

    if recovered_doc_type and recovered_doc_type != updated.get("detectedType"):
        updated["detectedType"] = recovered_doc_type
        updated["target"] = "WP1"
        if recovered_gl:
            updated["suggestedGlAccount"] = recovered_gl
        field_confidence["document_type"] = max(float(field_confidence.get("document_type", 0.0)), float(recovery.field_confidence.get("document_type", recovery.confidence or 0.0)))
        field_evidence["document_type"] = (
            list(recovery.field_evidence.get("document_type", []))
            or list(recovery.field_evidence.get("issuer_name", []))
            or ["Focused vision pass corrected the invoice role using issuer and customer fields."]
        )
        updated_fields.append("document_type")

    if recovered_doc_type == "Purchase Invoice" and issuer_name and not _same_entity_name(issuer_name, client_entity_name or ""):
        if _party_quality_score(issuer_name) >= _party_quality_score(str(updated.get("party", ""))):
            updated["party"] = issuer_name
            field_confidence["party"] = max(float(field_confidence.get("party", 0.0)), float(recovery.field_confidence.get("issuer_name", recovery.confidence or 0.0)))
            field_evidence["party"] = list(recovery.field_evidence.get("issuer_name", [])) or ["Focused vision pass recovered the supplier name from the invoice header."]
            if "party" not in updated_fields:
                updated_fields.append("party")
    elif recovered_doc_type == "Sales Invoice":
        sales_party = next(
            (
                candidate
                for candidate in (bill_to_name, deliver_to_name)
                if candidate and not _same_entity_name(candidate, client_entity_name or "")
            ),
            "",
        )
        if sales_party and _party_quality_score(sales_party) >= _party_quality_score(str(updated.get("party", ""))):
            updated["party"] = sales_party
            field_confidence["party"] = max(float(field_confidence.get("party", 0.0)), float(recovery.field_confidence.get("bill_to_name", recovery.confidence or 0.0)))
            field_evidence["party"] = (
                list(recovery.field_evidence.get("bill_to_name", []))
                or list(recovery.field_evidence.get("deliver_to_name", []))
                or ["Focused vision pass recovered the customer name from the invoice header."]
            )
            if "party" not in updated_fields:
                updated_fields.append("party")

    if not updated_fields:
        return item

    updated["fieldConfidence"] = field_confidence
    updated["fieldEvidence"] = field_evidence
    updated["overallConfidenceScore"] = round(max(float(updated.get("overallConfidenceScore", 0.0)), float(recovery.confidence or 0.0), 0.82), 2)
    evidence.append(f"Focused vision rescue strengthened these fields: {', '.join(updated_fields)}.")
    updated["evidence"] = [line for line in evidence if line]
    warnings = [
        warning
        for warning in warnings
        if warning not in {
            LOCAL_OCR_KEY_FIELDS_WARNING,
            IMAGE_OCR_AMOUNT_MISMATCH_WARNING,
            IMAGE_OCR_WEAK_DATE_PATTERN_WARNING,
            IMAGE_OCR_WEAK_DATE_MATCH_WARNING,
            "Party looks like a demo placeholder. Review before posting.",
            "Party was filled from the uploaded filename. Review before posting.",
            "Party still matches the client entity. Review before posting.",
        }
    ]
    for warning in list(getattr(recovery, "warnings", []) or []):
        if warning and warning not in warnings:
            warnings.append(warning)
    updated["warnings"] = warnings
    updated["notes"] = "Local OCR extraction was strengthened with a focused AI vision rescue."
    updated["extractionMethod"] = f"{updated.get('extractionMethod', 'local-ocr')}+focused-vision-rescue"
    updated["confidence"] = confidence_label(float(updated.get("overallConfidenceScore", 0.0)))
    updated["status"] = _status_for(updated)

    rebuilt = build_item(
        file_name=str(updated.get("fileName", "")),
        file_type=str(updated.get("fileType", "")),
        file_size=int(updated.get("fileSize") or 0),
        uploaded_at=str(updated.get("uploadedAt", "")) or None,
        detected_type=str(updated.get("detectedType", "Unknown")),
        target=str(updated.get("target", "WP1")),
        date=str(updated.get("date", "")),
        reference=str(updated.get("reference", "")),
        party=str(updated.get("party", "")),
        amount=float(updated.get("amount") or 0.0),
        money_in=float(updated.get("moneyIn") or 0.0),
        money_out=float(updated.get("moneyOut") or 0.0),
        suggested_gl_account=str(updated.get("suggestedGlAccount", "")),
        notes=str(updated.get("notes", "")),
        evidence=list(updated.get("evidence", [])),
        warnings=list(updated.get("warnings", [])),
        raw_preview=str(updated.get("rawPreview", "")),
        overall_confidence_score=float(updated.get("overallConfidenceScore", 0.0)),
        extraction_method=str(updated.get("extractionMethod", "local-ocr")),
        field_confidence=dict(updated.get("fieldConfidence", {})),
        field_evidence=dict(updated.get("fieldEvidence", {})),
        gl_suggestions=list(updated.get("glSuggestions", [])),
        client_entity_name=client_entity_name,
    )
    rebuilt["id"] = item.get("id", rebuilt["id"])
    return rebuilt


def _local_ocr_result_is_weak(items: list[dict[str, Any]]) -> bool:
    if not items:
        return True

    for item in items:
        if item.get("status") != "Accepted":
            return True
        if item.get("detectedType") == "Unknown":
            return True
        if item.get("target") == "WP1":
            if not str(item.get("date", "")).strip():
                return True
            if float(item.get("amount") or 0.0) <= 1.0:
                return True
    return False


def _item_result_quality_score(item: dict[str, Any]) -> int:
    score = _pdf_item_quality_score(item)
    status = item.get("status")
    if status == "Accepted":
        score += 3
    elif status == "Needs Review":
        score -= 2

    confidence = str(item.get("confidence") or "").strip().lower()
    if confidence == "high":
        score += 2
    elif confidence == "medium":
        score += 1

    if item.get("target") == "WP2" and (float(item.get("moneyIn") or 0.0) > 0 or float(item.get("moneyOut") or 0.0) > 0):
        score += 2
    return score


def _items_result_quality_score(items: list[dict[str, Any]]) -> int:
    return sum(_item_result_quality_score(item) for item in items)


def _prefer_stronger_items(
    *,
    baseline_items: list[dict[str, Any]],
    candidate_items: list[dict[str, Any]],
    candidate_label: str,
    baseline_label: str,
) -> list[dict[str, Any]]:
    if not candidate_items:
        return baseline_items

    baseline_score = _items_result_quality_score(baseline_items)
    candidate_score = _items_result_quality_score(candidate_items)

    if candidate_score > baseline_score:
        for item in candidate_items:
            warnings = list(item.get("warnings", []))
            upgrade_warning = f"{candidate_label} replaced a weaker {baseline_label} result."
            if upgrade_warning not in warnings:
                warnings.append(upgrade_warning)
            item["warnings"] = warnings
        return candidate_items

    for item in baseline_items:
        warnings = list(item.get("warnings", []))
        keep_warning = f"{candidate_label} was attempted, but {baseline_label} remained stronger."
        if keep_warning not in warnings:
            warnings.append(keep_warning)
        item["warnings"] = warnings
    return baseline_items


def _looks_like_placeholder_party(item: dict[str, Any], client_entity_name: str | None = None) -> bool:
    return looks_like_placeholder_party(
        str(item.get("party", "")),
        file_name=str(item.get("fileName", "")),
        client_entity_name=client_entity_name,
        target=str(item.get("target", "WP1")),
    )


def _refine_vision_items_with_local_ocr(
    vision_items: list[dict[str, Any]],
    ocr_items: list[dict[str, Any]],
    *,
    source_label: str,
    client_entity_name: str | None = None,
) -> list[dict[str, Any]]:
    if len(vision_items) != 1 or len(ocr_items) != 1:
        return vision_items

    vision_item = vision_items[0]
    ocr_item = ocr_items[0]
    merged_item = dict(vision_item)
    merged_warnings = list(vision_item.get("warnings", []))
    merged_evidence = list(vision_item.get("evidence", []))
    merged_field_confidence = dict(vision_item.get("fieldConfidence", {}))
    merged_field_evidence = dict(vision_item.get("fieldEvidence", {}))
    field_updates: list[str] = []

    if not merged_item.get("date") and ocr_item.get("date"):
        merged_item["date"] = ocr_item["date"]
        merged_field_confidence["date"] = max(
            float(merged_field_confidence.get("date", 0.0)),
            float(ocr_item.get("fieldConfidence", {}).get("date", 0.0)),
        )
        merged_field_evidence["date"] = ocr_item.get("fieldEvidence", {}).get("date", [])
        field_updates.append("date")

    if not merged_item.get("reference") and ocr_item.get("reference"):
        merged_item["reference"] = ocr_item["reference"]
        merged_field_confidence["reference"] = max(
            float(merged_field_confidence.get("reference", 0.0)),
            float(ocr_item.get("fieldConfidence", {}).get("reference", 0.0)),
        )
        merged_field_evidence["reference"] = ocr_item.get("fieldEvidence", {}).get("reference", [])
        field_updates.append("reference")

    if float(merged_item.get("amount") or 0.0) <= 0 and float(ocr_item.get("amount") or 0.0) > 0:
        merged_item["amount"] = ocr_item["amount"]
        merged_field_confidence["amount"] = max(
            float(merged_field_confidence.get("amount", 0.0)),
            float(ocr_item.get("fieldConfidence", {}).get("amount", 0.0)),
        )
        merged_field_evidence["amount"] = ocr_item.get("fieldEvidence", {}).get("amount", [])
        field_updates.append("amount")

    if (
        not merged_item.get("party")
        or _looks_like_placeholder_party(merged_item, client_entity_name)
    ) and ocr_item.get("party") and not _looks_like_placeholder_party(ocr_item, client_entity_name):
        merged_item["party"] = ocr_item["party"]
        merged_field_confidence["party"] = max(
            float(merged_field_confidence.get("party", 0.0)),
            float(ocr_item.get("fieldConfidence", {}).get("party", 0.0)),
        )
        merged_field_evidence["party"] = ocr_item.get("fieldEvidence", {}).get("party", [])
        field_updates.append("party")

    if merged_item.get("detectedType") == "Unknown" and ocr_item.get("detectedType") != "Unknown":
        merged_item["detectedType"] = ocr_item["detectedType"]
        merged_item["target"] = ocr_item.get("target", merged_item.get("target", "WP1"))
        if not merged_item.get("suggestedGlAccount") and ocr_item.get("suggestedGlAccount"):
            merged_item["suggestedGlAccount"] = ocr_item["suggestedGlAccount"]
        field_updates.append("document_type")

    if field_updates:
        merged_item["fieldConfidence"] = merged_field_confidence
        merged_item["fieldEvidence"] = merged_field_evidence
        merged_item["overallConfidenceScore"] = max(
            float(merged_item.get("overallConfidenceScore", 0.0)),
            float(ocr_item.get("overallConfidenceScore", 0.0)),
        )
        merged_evidence.append(
            f"{source_label} strengthened these fields after the vision pass: {', '.join(field_updates)}."
        )
        merged_item["evidence"] = [line for line in merged_evidence if line]
        merged_warnings.append(f"AI vision was cross-checked with {source_label.lower()}.")
        merged_item["warnings"] = list(dict.fromkeys(merged_warnings))
        merged_item["notes"] = f"AI extraction was strengthened with {source_label.lower()}."
        merged_item["extractionMethod"] = f"{vision_item.get('extractionMethod', 'ai-vision')}+local-ocr-merge"
        return [merged_item]

    return vision_items


def extract_intake_items(
    filename: str,
    content_type: str,
    data: bytes,
    upload_lane: str | None = None,
    client_entity_name: str | None = None,
) -> list[dict[str, Any]]:
    extension = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    lane = normalize_upload_lane(upload_lane)
    inferred_kind = _infer_content_kind(extension, content_type, data)

    try:
        if inferred_kind == "spreadsheet":
            items = extract_spreadsheet_items(filename, content_type, data, upload_lane=lane, client_entity_name=client_entity_name)
            if items:
                return items

        if inferred_kind == "text":
            text = decode_text(data)
            items = extract_delimited_items(filename, content_type, text, upload_lane=lane, client_entity_name=client_entity_name)
            if items:
                return items
            return extract_text_item(filename, content_type, data, upload_lane=lane, client_entity_name=client_entity_name)

        if inferred_kind == "pdf":
            primary_pdf_text_items = _primary_pdf_text_items(
                filename,
                content_type,
                data,
                upload_lane=lane,
                client_entity_name=client_entity_name,
            )
            if primary_pdf_text_items:
                return primary_pdf_text_items
            embedded_pdf_text, _ = _extract_pdf_text(data)
            local_ocr_text, local_ocr_warning = _extract_local_ocr_text_from_pdf(data)
            local_ocr_items = _items_from_local_ocr(
                filename=filename,
                content_type=content_type or "application/pdf",
                data=data,
                ocr_text=local_ocr_text,
                upload_lane=lane,
                client_entity_name=client_entity_name,
                source_label="PDF",
            )
            vision_hint_text = _build_vision_hint_text(embedded_pdf_text, local_ocr_text)
            if can_use_vision():
                try:
                    vision_items = extract_with_vision(
                        filename,
                        content_type or "application/pdf",
                        data,
                        upload_lane=lane,
                        client_entity_name=client_entity_name,
                        hint_text=vision_hint_text,
                    )
                    refined_vision_items = _refine_pdf_items_with_text(
                        filename,
                        content_type,
                        data,
                        vision_items,
                        upload_lane=lane,
                        client_entity_name=client_entity_name,
                    )
                    if local_ocr_items:
                        if local_ocr_warning and local_ocr_warning not in local_ocr_items[0]["warnings"]:
                            local_ocr_items[0]["warnings"].append(local_ocr_warning)
                        return _prefer_stronger_items(
                            baseline_items=refined_vision_items,
                            candidate_items=local_ocr_items,
                            candidate_label="local OCR",
                            baseline_label="AI vision",
                        )
                    return refined_vision_items
                except Exception as exc:
                    if local_ocr_items:
                        if local_ocr_warning:
                            _append_warning_once(local_ocr_items[0], local_ocr_warning)
                        limit_warning = provider_limit_warning(str(exc))
                        if limit_warning:
                            _append_warning_once(local_ocr_items[0], limit_warning)
                        vision_warning = f"AI vision extraction failed after local OCR fallback: {exc}"
                        _append_warning_once(local_ocr_items[0], vision_warning)
                        return local_ocr_items
                    return _fallback_pdf_item(filename, content_type, data, str(exc), upload_lane=lane, client_entity_name=client_entity_name)
            if local_ocr_items:
                if local_ocr_warning and local_ocr_warning not in local_ocr_items[0]["warnings"]:
                    local_ocr_items[0]["warnings"].append(local_ocr_warning)
                return local_ocr_items
            return _fallback_pdf_item(
                filename,
                content_type,
                data,
                "AI vision extraction is not configured.",
                upload_lane=lane,
                client_entity_name=client_entity_name,
            )

        if inferred_kind == "image":
            extension = f".{extension}" if extension else ""
            local_ocr_text, local_ocr_warning = _extract_local_ocr_text_from_image(data, extension)
            local_ocr_items = _items_from_local_ocr(
                filename=filename,
                content_type=content_type or "image/png",
                data=data,
                ocr_text=local_ocr_text,
                upload_lane=lane,
                client_entity_name=client_entity_name,
                source_label="Image",
            )
            ocr_quality = _score_ocr_text(local_ocr_text)
            vision_hint_text = _build_vision_hint_text(local_ocr_text) if ocr_quality >= 4 else ""
            if can_use_vision():
                try:
                    vision_items = extract_with_vision(
                        filename,
                        content_type or "image/png",
                        data,
                        upload_lane=lane,
                        client_entity_name=client_entity_name,
                        hint_text=vision_hint_text,
                    )
                    if local_ocr_items:
                        if local_ocr_warning and local_ocr_warning not in local_ocr_items[0]["warnings"]:
                            local_ocr_items[0]["warnings"].append(local_ocr_warning)
                        refined_vision_items = _refine_vision_items_with_local_ocr(
                            vision_items,
                            local_ocr_items,
                            source_label="Local OCR",
                            client_entity_name=client_entity_name,
                        )
                        return _prefer_stronger_items(
                            baseline_items=refined_vision_items,
                            candidate_items=local_ocr_items,
                            candidate_label="local OCR",
                            baseline_label="AI vision",
                        )
                    return vision_items
                except Exception as exc:
                    if local_ocr_items:
                        if local_ocr_warning:
                            _append_warning_once(local_ocr_items[0], local_ocr_warning)
                        limit_warning = provider_limit_warning(str(exc))
                        if limit_warning:
                            _append_warning_once(local_ocr_items[0], limit_warning)
                        vision_warning = f"AI vision extraction failed after local OCR fallback: {exc}"
                        _append_warning_once(local_ocr_items[0], vision_warning)
                        return local_ocr_items
                    limit_warning = provider_limit_warning(str(exc))
                    warning = f"AI vision extraction failed: {exc}"
                    if limit_warning:
                        warning = f"{limit_warning} {warning}"
                    return _unreadable_file_item(filename, content_type, len(data), warning, upload_lane=lane)
            if local_ocr_items:
                if local_ocr_warning and local_ocr_warning not in local_ocr_items[0]["warnings"]:
                    local_ocr_items[0]["warnings"].append(local_ocr_warning)
                return local_ocr_items
            return _unreadable_file_item(filename, content_type, len(data), "AI vision extraction is not configured yet for images.", upload_lane=lane)

        if looks_like_readable_text(data):
            return extract_text_item(filename, content_type or "text/plain", data, upload_lane=lane, client_entity_name=client_entity_name)

        return _unreadable_file_item(filename, content_type, len(data), "File type is not directly readable yet. Import as a review row.", upload_lane=lane)
    except Exception as exc:
        warning = f"Server extraction hit a protected fallback path: {type(exc).__name__}: {exc}"
        if inferred_kind == "pdf":
            return _fallback_pdf_item(
                filename,
                content_type,
                data,
                warning,
                upload_lane=lane,
                client_entity_name=client_entity_name,
            )
        if looks_like_readable_text(data):
            try:
                items = extract_text_item(
                    filename,
                    content_type or "text/plain",
                    data,
                    upload_lane=lane,
                    client_entity_name=client_entity_name,
                )
                for item in items:
                    item["warnings"] = [*item.get("warnings", []), warning]
                    item["notes"] = "Protected fallback readable-text extraction was used."
                    item["extractionMethod"] = "text-parser-protected-fallback"
                return items
            except Exception:
                pass
        return _unreadable_file_item(filename, content_type, len(data), warning, upload_lane=lane)


def _infer_content_kind(extension: str, content_type: str, data: bytes) -> str:
    lowered_type = (content_type or "").lower()
    prefix = data[:16]

    if extension in SPREADSHEET_EXTENSIONS or "spreadsheet" in lowered_type or "excel" in lowered_type or prefix.startswith(OLE_MAGIC):
        return "spreadsheet"
    if extension in TEXT_EXTENSIONS or lowered_type.startswith("text/"):
        return "text"
    if extension == "pdf" or lowered_type == "application/pdf" or data.lstrip().startswith(PDF_MAGIC):
        return "pdf"
    if extension in IMAGE_EXTENSIONS or lowered_type.startswith("image/") or _looks_like_image_bytes(prefix, data):
        return "image"
    if prefix.startswith(ZIP_MAGIC) and extension in {"xlsx", "xlsm"}:
        return "spreadsheet"
    if looks_like_readable_text(data):
        return "text"
    return "unknown"


def _looks_like_image_bytes(prefix: bytes, data: bytes) -> bool:
    if prefix.startswith(PNG_MAGIC) or prefix.startswith(JPEG_MAGIC) or prefix.startswith(GIF_MAGIC) or prefix.startswith(BMP_MAGIC):
        return True
    if any(prefix.startswith(magic) for magic in TIFF_MAGICS):
        return True
    if prefix.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return True
    return False


def _fallback_pdf_item(
    filename: str,
    content_type: str,
    data: bytes,
    warning: str,
    upload_lane: str | None = None,
    client_entity_name: str | None = None,
) -> list[dict[str, Any]]:
    text, pdf_warning = _extract_pdf_text(data)
    try:
        items = extract_text_item(
            filename,
            content_type or "application/pdf",
            text.encode("utf-8") if text else data,
            upload_lane=upload_lane,
            client_entity_name=client_entity_name,
        )
    except Exception as exc:
        protected_warning = warning or pdf_warning or "PDF extraction failed."
        return _unreadable_file_item(
            filename,
            content_type,
            len(data),
            f"{protected_warning} Protected PDF fallback failed with {type(exc).__name__}: {exc}",
            upload_lane=upload_lane,
            client_entity_name=client_entity_name,
        )
    if items:
        if pdf_warning and pdf_warning not in items[0]["warnings"]:
            items[0]["warnings"].append(pdf_warning)
        if warning and warning not in items[0]["warnings"]:
            items[0]["warnings"].append(warning)
        items[0]["notes"] = "Fallback PDF text extraction was used."
        items[0]["extractionMethod"] = "pdf-text-fallback"
        return items
    return _unreadable_file_item(
        filename,
        content_type,
        len(data),
        warning or pdf_warning,
        upload_lane=upload_lane,
        client_entity_name=client_entity_name,
    )


def _primary_pdf_text_items(
    filename: str,
    content_type: str,
    data: bytes,
    *,
    upload_lane: str | None = None,
    client_entity_name: str | None = None,
) -> list[dict[str, Any]]:
    text, pdf_warning = _extract_pdf_text(data)
    if not text.strip():
        return []

    try:
        text_items = extract_text_item(
            filename,
            content_type or "application/pdf",
            text.encode("utf-8"),
            upload_lane=upload_lane,
            client_entity_name=client_entity_name,
        )
    except Exception:
        return []

    if len(text_items) == 1:
        text_item = text_items[0]
        if _pdf_text_quality_score(text_item, text) < 7:
            return []
        selected_items = [text_item]
    else:
        strong_items = [item for item in text_items if _pdf_item_quality_score(item) >= 5]
        if not strong_items:
            return []
        selected_items = text_items

    for item in selected_items:
        warnings = list(item.get("warnings", []))
        if pdf_warning and pdf_warning not in warnings:
            warnings.append(pdf_warning)
        if "Structured PDF text was strong enough to bypass a slower AI pass." not in warnings:
            warnings.append("Structured PDF text was strong enough to bypass a slower AI pass.")
        item["warnings"] = warnings
        item["notes"] = "Primary PDF extraction came from embedded readable text."
        item["extractionMethod"] = "pdf-text-primary"
    return selected_items


def _pdf_item_quality_score(item: dict[str, Any]) -> int:
    score = 0
    if item.get("detectedType") and item.get("detectedType") != "Unknown":
        score += 3
    if item.get("date"):
        score += 2
    if float(item.get("amount") or 0) > 0:
        score += 2
    if item.get("reference"):
        score += 1
    if item.get("party"):
        score += 1
    return score


def _pdf_text_quality_score(item: dict[str, Any], text: str) -> int:
    score = _pdf_item_quality_score(item)
    lowered = text.lower()
    if "invoice" in lowered or "statement" in lowered or "receipt" in lowered:
        score += 1
    if "bill to" in lowered or "deliver to" in lowered or "customer" in lowered:
        score += 1
    if len(text.strip()) > 250:
        score += 1
    return score


def _refine_pdf_items_with_text(
    filename: str,
    content_type: str,
    data: bytes,
    vision_items: list[dict[str, Any]],
    *,
    upload_lane: str | None = None,
    client_entity_name: str | None = None,
) -> list[dict[str, Any]]:
    text, pdf_warning = _extract_pdf_text(data)
    if not text.strip():
        return vision_items

    try:
        text_items = extract_text_item(
            filename,
            content_type or "application/pdf",
            text.encode("utf-8"),
            upload_lane=upload_lane,
            client_entity_name=client_entity_name,
        )
    except Exception:
        return vision_items

    if len(vision_items) != 1 or len(text_items) != 1:
        return vision_items

    vision_item = vision_items[0]
    text_item = text_items[0]
    merged_item = dict(vision_item)
    merged_warnings = list(vision_item.get("warnings", []))
    merged_evidence = list(vision_item.get("evidence", []))
    merged_field_confidence = dict(vision_item.get("fieldConfidence", {}))
    merged_field_evidence = dict(vision_item.get("fieldEvidence", {}))

    field_updates: list[str] = []

    if not merged_item.get("date") and text_item.get("date"):
        merged_item["date"] = text_item["date"]
        merged_field_confidence["date"] = max(
            float(merged_field_confidence.get("date", 0.0)),
            float(text_item.get("fieldConfidence", {}).get("date", 0.0)),
        )
        merged_field_evidence["date"] = text_item.get("fieldEvidence", {}).get("date", [])
        field_updates.append("date")

    if (float(merged_item.get("amount") or 0) <= 0) and float(text_item.get("amount") or 0) > 0:
        merged_item["amount"] = text_item["amount"]
        merged_field_confidence["amount"] = max(
            float(merged_field_confidence.get("amount", 0.0)),
            float(text_item.get("fieldConfidence", {}).get("amount", 0.0)),
        )
        merged_field_evidence["amount"] = text_item.get("fieldEvidence", {}).get("amount", [])
        field_updates.append("amount")

    if not merged_item.get("reference") and text_item.get("reference"):
        merged_item["reference"] = text_item["reference"]
        merged_field_confidence["reference"] = max(
            float(merged_field_confidence.get("reference", 0.0)),
            float(text_item.get("fieldConfidence", {}).get("reference", 0.0)),
        )
        merged_field_evidence["reference"] = text_item.get("fieldEvidence", {}).get("reference", [])
        field_updates.append("reference")

    if (
        (not merged_item.get("party") or merged_item.get("party") == merged_item.get("fileName"))
        and text_item.get("party")
    ):
        merged_item["party"] = text_item["party"]
        merged_field_confidence["party"] = max(
            float(merged_field_confidence.get("party", 0.0)),
            float(text_item.get("fieldConfidence", {}).get("party", 0.0)),
        )
        merged_field_evidence["party"] = text_item.get("fieldEvidence", {}).get("party", [])
        field_updates.append("party")

    if merged_item.get("detectedType") == "Unknown" and text_item.get("detectedType") != "Unknown":
        merged_item["detectedType"] = text_item["detectedType"]
        merged_item["target"] = text_item.get("target", merged_item.get("target", "WP1"))
        merged_item["suggestedGlAccount"] = text_item.get("suggestedGlAccount", merged_item.get("suggestedGlAccount", ""))
        field_updates.append("document_type")

    if field_updates:
        merged_item["fieldConfidence"] = merged_field_confidence
        merged_item["fieldEvidence"] = merged_field_evidence
        merged_item["overallConfidenceScore"] = max(
            float(merged_item.get("overallConfidenceScore", 0.0)),
            float(text_item.get("overallConfidenceScore", 0.0)),
        )
        merged_evidence.append(
            f"Embedded PDF text strengthened these fields: {', '.join(field_updates)}."
        )
        if pdf_warning and pdf_warning not in merged_warnings:
            merged_warnings.append(pdf_warning)
        merged_item["warnings"] = merged_warnings
        merged_item["evidence"] = [line for line in merged_evidence if line]
        merged_item["notes"] = "AI extraction was strengthened with embedded PDF text."
        merged_item["extractionMethod"] = f"{vision_item.get('extractionMethod', 'ai-vision')}+pdf-text-merge"
        vision_items = [merged_item]
        vision_item = merged_item

    if _pdf_item_quality_score(text_item) <= _pdf_item_quality_score(vision_item):
        return vision_items

    warnings = list(text_item.get("warnings", []))
    if pdf_warning and pdf_warning not in warnings:
        warnings.append(pdf_warning)
    warnings.append("Embedded PDF text refinement replaced a weaker AI extraction result.")
    text_item["warnings"] = warnings
    text_item["notes"] = "AI extraction was refined with embedded PDF text."
    text_item["extractionMethod"] = f"{vision_item.get('extractionMethod', 'ai-vision')}+pdf-text-refine"
    return [text_item]


def _extract_pdf_text(data: bytes) -> tuple[str, str]:
    texts: list[str] = []
    warnings: list[str] = []

    try:
        reader = PdfReader(io.BytesIO(data))
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
        if text.strip():
            texts.append(text)
    except Exception:
        warnings.append("pypdf could not read the PDF text layer.")

    if fitz is not None:
        try:
            document = fitz.open(stream=data, filetype="pdf")
            try:
                fitz_text = "\n".join(document.load_page(page_index).get_text("text") or "" for page_index in range(document.page_count))
                if fitz_text.strip():
                    texts.append(fitz_text)
            finally:
                document.close()
        except Exception:
            warnings.append("PyMuPDF could not read the PDF text layer.")

    if not texts:
        return "", "No embedded PDF text found. Scanned PDFs need AI vision extraction."

    selected = max(
        texts,
        key=lambda candidate: (
            len(candidate.strip()),
            sum(1 for token in ("invoice", "date", "total", "deliver to", "bill to", "customer") if token in candidate.lower()),
        ),
    )

    if warnings:
        return selected, " ".join(warnings)
    return selected, ""


def _unreadable_file_item(
    filename: str,
    content_type: str,
    file_size: int,
    warning: str,
    upload_lane: str | None = None,
    client_entity_name: str | None = None,
) -> list[dict[str, Any]]:
    heuristic = detect_type(filename, upload_lane)
    return [
        build_item(
            file_name=filename,
            file_type=content_type or "unknown",
            file_size=file_size,
            uploaded_at=current_timestamp(),
            client_entity_name=client_entity_name,
            detected_type=heuristic["detectedType"],
            target=heuristic["target"],
            notes="File content was not readable. Review downstream fields.",
            evidence=heuristic["evidence"],
            warnings=[*heuristic["warnings"], warning],
            suggested_gl_account=heuristic["suggestedGlAccount"],
            extraction_method="unreadable-fallback",
            overall_confidence_score=max(0.2, float(heuristic.get("confidenceScore", 0.0))),
        )
    ]
