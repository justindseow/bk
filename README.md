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

For local environment variables, copy `backend/.env.example` and set the values in your shell or deployment host. The app does not read a `.env` file automatically; deployment hosts such as Render should store these as environment variables.

Health check:

```text
GET http://127.0.0.1:8000/health
```

Feedback email:

```text
POST http://127.0.0.1:8000/feedback
```

The feedback endpoint sends an email through SMTP and does not store feedback in a database.

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

The frontend sends the current browser session data to the backend. The backend generates the `.xlsx` file in memory and returns it immediately. No client data is stored server-side.

Backend Excel smoke test:

```text
GET http://127.0.0.1:8000/export/test-excel
```

This should download a small workbook that opens in Excel.

## Shareable Test Link

For BK testing through a shareable web link, deploy the app as one Vercel project. Vercel hosts the Vite frontend and the FastAPI endpoints under the same domain.

1. Go to Vercel and import `https://github.com/justindseow/bk`.
2. Keep the project root as the repository root.
3. Vercel should use `vercel.json`.
4. Share the Vercel frontend URL with the BK.

Vercel build settings if entered manually:

```text
Install command: cd frontend && npm install
Build command: cd frontend && npm run build
Output directory: frontend/dist
```

The backend routes are served by Vercel Python Functions:

```text
GET /health
POST /export/excel
GET /export/test-excel
POST /feedback
```

No `VITE_API_BASE_URL` is needed on Vercel when frontend and API are deployed together. For local development, keep `VITE_API_BASE_URL=http://127.0.0.1:8000`.

Useful Vercel references:

- Vite on Vercel: https://vercel.com/docs/frameworks/vite
- FastAPI on Vercel: https://vercel.com/docs/frameworks/backend/fastapi

Keep the testing instruction clear: use sanitised test data only unless authorised.

## Feedback Email Setup

Step 08 includes a `Submit Feedback` form. The frontend sends the feedback to the backend, and the backend sends it by email using SMTP.

Required backend environment variables:

```text
FEEDBACK_TO_EMAIL=your-email@example.com
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USE_TLS=true
SMTP_USERNAME=your-smtp-username
SMTP_PASSWORD=your-smtp-password-or-app-password
SMTP_FROM_EMAIL=your-email@example.com
```

For Gmail or Microsoft accounts, use an app password or SMTP credential created for this purpose. Do not put email passwords in the frontend.

## Guided QA

Use the `Demo / QA Controls` panel near the top of the app to test the full workflow without needing accounting knowledge. The panel opens with a `Start here` area:

- `Guided Demo Test`: best first run for a bookkeeper reviewing the workflow.
- `Use Your Own Test Data`: clears the current session and opens WP1 for sanitised manual testing.
- `Known Good Session`: jumps to a clean session that is ready for Review and Journal Voucher testing.

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

## BK Test Session

Use `Demo / QA Controls` and choose `Use Your Own Test Data` when the bookkeeper wants to test the workflow with sanitised real examples.

Important: use sanitised sample data first. Do not upload or paste confidential client files unless authorised. This mode is still manual entry only: there is no OCR, PDF auto-reading, or AI extraction.

Manual WP1 document entry:

1. Open Step 02, `WP1 Document Posting Ledger`.
2. Click `Download WP1 Template` if you want a sample spreadsheet layout.
3. Click `Add Document`.
4. Enter date, document reference, vendor/customer, document type, amount, GL account, and notes.
5. Save the document row.
6. Use the existing `Split`, `Reclassify`, `Edit GL`, `Edit`, and `Delete` actions as needed.

Paste WP1 documents from Excel:

1. Copy rows from Excel with these columns: `Date`, `Document Ref`, `Vendor / Customer`, `Document Type`, `Amount`, `GL Account`, `Notes`.
2. Paste them into the `Paste from Excel` box on WP1.
3. Click `Preview Paste`.
4. Check the preview, then click `Import Preview Rows`.

Manual WP2 bank row entry:

1. Open Step 03, `WP2 Bank Verification`.
2. Click `Download WP2 Template` if you want a sample spreadsheet layout.
3. Click `Add Bank Row`.
4. Enter date, bank description, reference, money in or money out, and notes.
5. Save the bank row.
6. Use `Mark Matched`, `New Entry`, `Timing Item`, `Edit`, or `Delete` as needed.

Paste WP2 bank rows from Excel:

1. Copy rows from Excel with these columns: `Date`, `Bank Description`, `Reference`, `Money In`, `Money Out`, `Notes`.
2. Paste them into the `Paste Bank Statement Rows` box on WP2.
3. Click `Preview Paste`.
4. Check the preview, then click `Import Preview Rows`.

The `Download WP1 Template` and `Download WP2 Template` buttons create CSV templates in the browser. `Clear Current Session Data` clears the active session only; the demo presets remain available.

## Troubleshooting

- Backend not running: start the backend with `uvicorn main:app --reload --host 127.0.0.1 --port 8000`.
- CORS issue: use `127.0.0.1` for both frontend and backend, or confirm the frontend is running on port 5173 or 5174.
- Shareable link cannot export or submit feedback: confirm `VITE_API_BASE_URL` points to the deployed backend, and `FRONTEND_ORIGINS` includes the deployed frontend URL.
- Feedback email not sent: confirm all `SMTP_*` values and `FEEDBACK_TO_EMAIL` are set in the backend host.
- Port already in use: Vite may move from 5173 to 5174 automatically. For the backend, choose another port and update the frontend export URL if needed.
- PowerShell npm policy issue: use `npm.cmd` instead of `npm`.

## Known Limitations

- AR/AP workflows are intentionally not included yet.
- OCR, PDF auto-reading, and document extraction are intentionally not included.
- There is no database and no server-side client data persistence.
- The current app is designed for one browser session, one client, and one monthly period at a time.
- Excel export requires the FastAPI backend to be running.

## Persistence Rule

The browser session is the working state. The backend receives the current session only to generate exports and must not store client data server-side.
