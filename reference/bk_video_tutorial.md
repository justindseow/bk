# BK Tool Video Tutorial

## Purpose

This is a screen-recording script for a bookkeeper who is using the BK Tool for one client and one month.

Use this as the source for:

- a narrated walkthrough video
- a Loom recording
- a handoff session with a BK

Recommended video length:

- Full version: 8 to 12 minutes
- Short version: 3 to 4 minutes

---

## BK Version

This version is for the BK only.

Do not explain backend logic, OpenRouter, OCR models, audit packs, or technical fallback internals in the main BK tutorial.

What the BK needs to understand:

- upload source documents
- review anything unclear
- import ready rows into WP1 and WP2
- complete WP1
- complete WP2
- finish Adjusting, Review, JV, Handover, and Download

---

## Recording Setup

Before recording:

1. Open the app in a clean browser session.
2. Use a sanitised test session only.
3. Prepare one example batch with:
   - purchase invoices
   - one bank statement
   - at least one file that lands in `Needs Review`
4. Zoom the browser to a readable level.
5. Keep the left navigation visible at all times.

---

## Suggested Title

`BK Tool Walkthrough: From Source Documents to WP1, WP2, JV, and Download`

---

## Scene 1: Intro

### On Screen

Open the app on the `Intake` step.

### Voiceover

`This tool is used to process one bookkeeping session for one client and one month.`

`We start by uploading source documents, then we move the clean rows into WP1 and WP2, finish the bookkeeping checks, generate the journal voucher, prepare the handover note, and download the final workbook.`

---

## Scene 2: Left Navigation

### On Screen

Hover or point through the left menu:

- `Intake`
- `WP1 Ledger`
- `WP2 Verify`
- `Adjusting`
- `Review`
- `JV`
- `Handover`
- `Download`

### Voiceover

`The workflow runs from top to bottom.`

`Intake is where documents are uploaded and interpreted.`

`WP1 is for source document posting.`

`WP2 is for bank verification.`

`Then we complete adjusting entries, run validation, finalise the JV, review the handover note, and download the workbook.`

---

## Scene 3: Intake Upload

### On Screen

Show the upload buttons:

- `Add Mixed Docs`
- `Add Purchase Docs`
- `Add Sales Docs`
- `Add Bank Docs`
- `Add Payment Docs`

### Voiceover

`If the batch contains many document types together, use Add Mixed Docs.`

`If you already know the document family, use the more specific button. That gives the extractor stronger context.`

`For example, purchase invoices should usually go through Add Purchase Docs, while bank statements should go through Add Bank Docs.`

---

## Scene 4: Intake Result Summary

### On Screen

Show the queue summary cards and the status banner.

### Voiceover

`After upload, the app groups files into queues.`

`Clean Uploads are the easiest ones.`

`Unclassified Uploads or Needs Attention items are the ones that still need a bookkeeper check.`

`Bank Uploads are separated so they can move into WP2 more cleanly.`

`If the top banner mentions backup extraction, it means the app still recovered the file, but BK should be a bit more careful when checking it.`

---

## Scene 5: Review a File With Issues

### On Screen

Open a file card with `Review issue`.

Show:

- `Open Original`
- issue fields
- detected type
- target
- date
- reference
- amount
- GL or bank direction
- `Mark Ready`

### Voiceover

`For any file in review, open the issue and compare the extracted result against the original document.`

`If the document type is wrong, correct it here.`

`If the target should be WP1 or WP2, correct it here.`

`Then check the date, reference, description, amount, and GL or bank direction.`

`When the row looks right, click Mark Ready.`

`This does not post it yet. It only confirms that the intake row is ready to move downstream.`

---

## Scene 6: Clean Files and Accepted Rows

### On Screen

Open a clean file card.

Show `Open Original` and `View Extracted Rows`.

### Voiceover

`Even for accepted files, BK can still preview the original source and inspect the extracted rows.`

`Use this as a light spot-check before import.`

`You do not need to manually review every accepted row if the batch looks clean, but you should sample-check enough to be comfortable.`

---

## Scene 7: Import Ready Rows

### On Screen

Scroll to the accepted/ready section and click `Import Ready Rows`.

Then point to the buttons:

- `Open WP1`
- `Open WP2`

### Voiceover

`Once the rows are ready, click Import Ready Rows.`

`This moves WP1-target rows into the document ledger and WP2-target rows into bank verification.`

`After import, open WP1 for document posting and open WP2 for bank verification.`

---

## Scene 8: WP1 Ledger

### On Screen

Open `WP1 Ledger`.

Show:

- posted rows
- unresolved items
- `Split`
- `Reclassify`
- `Edit GL`
- `Edit`

### Voiceover

`WP1 is the document posting ledger.`

`Here BK checks that each source document is in the right type, amount, and GL account.`

`If one source document needs to be split across more than one posting, use Split.`

`If the type or treatment is wrong, use Reclassify.`

`If the account is missing or incorrect, use Edit GL.`

`The goal in WP1 is to clear unresolved items before moving on.`

---

## Scene 9: WP2 Verify

### On Screen

Open `WP2 Verify`.

Show:

- imported bank rows
- match statuses
- `Mark Matched`
- `New Entry`
- `Timing Item`
- verification setup area

### Voiceover

`WP2 is for bank verification.`

`Bank rows imported from Intake appear here.`

`BK reviews each bank movement against the WP1 documents already posted.`

`If a row matches an existing source document, mark it as matched.`

`If it is a genuine bank-only item, use New Entry.`

`If it belongs in a timing difference, use Timing Item.`

`Before signing off WP2, confirm the bank statement closing balance and the book balance before WP2-only entries.`

`WP2 should only be verified when the unresolved bank rows are cleared and the difference is zero.`

---

## Scene 10: Adjusting Entries

### On Screen

Open `Adjusting`.

Show the different adjusting sections.

### Voiceover

`After WP1 and WP2 are ready, move to Adjusting Entries.`

`This is where accruals, reversals, depreciation, and other month-end adjustments are reviewed or added.`

`Only continue when the adjusting entries are complete for the session.`

---

## Scene 11: Review and Validation

### On Screen

Open `Review`.

Run validation if needed.

Show any warnings or clean state.

### Voiceover

`Review and Validation is the final control check before the journal voucher.`

`Use this step to catch anything still unresolved in WP1, WP2, or Adjusting.`

`If validation shows a critical issue, go back to the linked step and resolve it first.`

---

## Scene 12: JV

### On Screen

Open `JV`.

Show the generated journal lines and finalise action.

### Voiceover

`Once validation is clean, open JV.`

`Review the generated journal voucher lines.`

`Finalise the JV only when you are satisfied the session is complete.`

---

## Scene 13: Handover

### On Screen

Open `Handover`.

Show generated checklist items.

### Voiceover

`The Handover step prepares notes for the next session or the next reviewer.`

`Use it to capture anything important that should not be lost, such as unresolved items, follow-ups, or special treatment for the next month.`

---

## Scene 14: Download

### On Screen

Open `Download`.

Show `Download Excel Workbook`.

### Voiceover

`The final step is Download.`

`This exports the session workbook for filing and continuity.`

`Check any readiness warnings, then download the Excel workbook.`

---

## Short Troubleshooting Section

### On Screen

Return to `Intake`.

### Voiceover

`If a file is unclear, always open the original source and compare it with the extracted row.`

`If a row lands in Needs Review, that does not mean the session failed. It just means BK input is required before posting.`

`If the bank statement seems too short or incomplete, check whether the bank file was imported correctly in Intake before continuing in WP2.`

`If Import Ready Rows has already been clicked, the rows have already moved downstream even if the button looks disabled afterwards.`

---

## Closing Line

### Voiceover

`The simplest way to use this tool is: upload, review only what needs attention, import ready rows, complete WP1, complete WP2, finish adjusting and validation, finalise the JV, then download the workbook.`

---

## Recording Notes For Owner

Use these recording choices:

- Record at 125% browser zoom if text feels too small.
- Keep the cursor slow and deliberate.
- Pause briefly before each click.
- Use one real example of:
  - a clean purchase invoice
  - one review item
  - one bank statement
- If the video is long, split it into two parts:
  - Part 1: Intake, WP1, WP2
  - Part 2: Adjusting, Review, JV, Handover, Download

---

## Optional Short Version Script

`Upload the source documents in Intake.`

`Review only the rows that need attention, and spot-check accepted rows using Open Original and View Extracted Rows.`

`Click Import Ready Rows to move the cleaned data into WP1 and WP2.`

`Complete WP1 document posting, then verify the bank statement in WP2.`

`Finish adjusting entries, run validation, finalise the journal voucher, review the handover note, and download the workbook.`
