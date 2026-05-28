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

## Guided QA

Use the `Demo / QA Controls` panel near the top of the app to test the full workflow without needing accounting knowledge.

Recommended test order:

1. Click `Start Guided Test`.
2. Follow the guided instruction card from WP1 through Excel Download.
3. Use `Next Step` after checking each expected result.
4. Use `Make Full Session Ready for JV` when you want to skip manual preparation and test Review, Journal Voucher, Handover, and Excel.
5. Use `Finalise Demo Journal Voucher` to test the finalised JV and handover state.

Demo resets:

- `Reset to Clean Demo Session`: restores the starter January 2025 demo session for hands-on testing.
- `Reset to Session With Issues`: creates a controlled problem session with one WP1 split issue, one WP2 review issue, and one adjusting entry account issue.
- `Make WP1 Ready`: resolves WP1 splits, reclassifications, and missing GL accounts.
- `Make WP2 Ready`: resolves WP1 and WP2, including multi-match, Bank+ entries, and timing item reconciliation.
- `Make Adjusting Entries Ready`: marks reversals, accruals, and depreciation as ready.
- `Make Full Session Ready for JV`: creates a known good session with validation ready for Journal Voucher.
- `Finalise Demo Journal Voucher`: creates the known good session and marks the JV as finalised.

## Troubleshooting

- Backend not running: start the backend with `uvicorn main:app --reload --host 127.0.0.1 --port 8000`.
- CORS issue: use `127.0.0.1` for both frontend and backend, or confirm the frontend is running on port 5173 or 5174.
- Port already in use: Vite may move from 5173 to 5174 automatically. For the backend, choose another port and update the frontend export URL if needed.
- PowerShell npm policy issue: use `npm.cmd` instead of `npm`.

## Persistence Rule

The browser session JSON is the working state. The backend receives JSON only to generate exports and must not store client data server-side.
