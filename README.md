# MacroByte BK Tool

Fresh document-first bookkeeping workflow tool for one client/month session.

This is not the old OCR bookkeeping tool. The app is session-based: the user opens a client/month session, works through the workflow, exports Excel/PDF, then closes. There is no database and no server-side stored client data.

## Current Scope

- React + TypeScript frontend
- FastAPI backend
- Health check endpoint
- Stateless Excel workbook export with openpyxl
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
npm.cmd run dev -- --host 127.0.0.1
```

The Vite app runs at:

```text
http://127.0.0.1:5173
```

If port 5173 is already in use, Vite will choose the next available port, such as 5174.

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

Excel export:

```text
POST http://127.0.0.1:8000/export/excel
```

## Exporting Excel

1. Start the backend on port 8000.
2. Start the frontend.
3. Open Step 08, Excel Download.
4. Review any readiness warnings.
5. Click `Download Excel Workbook`.

The frontend sends the current browser session JSON to the backend. The backend generates the `.xlsx` file in memory and returns it immediately. No client data is stored server-side.

## Troubleshooting

- Backend not running: start the backend with `uvicorn main:app --reload --host 127.0.0.1 --port 8000`.
- CORS issue: use `127.0.0.1` for both frontend and backend, or confirm the frontend is running on port 5173 or 5174.
- Port already in use: Vite may move from 5173 to 5174 automatically. For the backend, choose another port and update the frontend export URL if needed.
- PowerShell npm policy issue: use `npm.cmd` instead of `npm`.

## Persistence Rule

The browser session JSON is the working state. The backend receives JSON only to generate exports and must not store client data server-side.
