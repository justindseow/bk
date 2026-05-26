# MacroByte BK Tool

Fresh document-first bookkeeping workflow tool for one client/month session.

This is not the old OCR bookkeeping tool. The app is session-based: the user opens a client/month session, works through the workflow, exports Excel/PDF, then closes. There is no database and no server-side stored client data.

## Current Scope

- React + TypeScript frontend
- FastAPI backend
- Health check endpoint
- Placeholder Excel export endpoint
- Shared sample session data for XYZ Co Sdn Bhd, January 2025
- No database
- No AR/AP
- No OCR

## Workflow Views

1. Document Collection
2. WP1 Document Posting Ledger
3. WP2 Bank Verification
4. Adjusting Entries
5. Review and Validation
6. Journal Voucher
7. Handover Note
8. Excel Download

## Frontend Setup

```powershell
cd frontend
npm install
npm run dev
```

The Vite app runs at:

```text
http://localhost:5173
```

## Backend Setup

From the repository root:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

The API runs at:

```text
http://127.0.0.1:8000
```

Health check:

```text
GET http://127.0.0.1:8000/health
```

Placeholder export:

```text
POST http://127.0.0.1:8000/export/excel
```

## Persistence Rule

The browser session JSON is the working state. The backend receives JSON only to generate exports and must not store client data server-side.
