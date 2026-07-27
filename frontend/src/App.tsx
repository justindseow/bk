import { useEffect, useMemo, useState } from 'react'
import './App.css'
import { DemoControls } from './components/demo/DemoControls'
import { AppShell } from './components/layout/AppShell'
import { workflowSteps } from './components/layout/workflow'
import { AdjustingEntries } from './components/steps/AdjustingEntries'
import { ExcelDownload } from './components/steps/ExcelDownload'
import { HandoverNote } from './components/steps/HandoverNote'
import { JournalVoucher } from './components/steps/JournalVoucher'
import { ReviewValidation } from './components/steps/ReviewValidation'
import { SourceDocumentIntake } from './components/steps/SourceDocumentIntake'
import { WP1DocumentLedger } from './components/steps/WP1DocumentLedger'
import { WP2BankVerification } from './components/steps/WP2BankVerification'
import { createBlankBkTestSession } from './state/demoSessions'
import { generateJournalLines } from './state/journalBuilder'
import type { SampleSession, WorkflowStepId } from './types/session'
import { telemetryEvent, telemetryIssue, telemetryMetadata } from './utils/telemetry'

const pageGuidance: Record<WorkflowStepId, { helper: string; nextAction: string; steps: string[] }> = {
  collection: {
    helper: 'Upload source documents first, choose whether each row belongs in WP1 or WP2, then import for review.',
    nextAction: 'Next action: add BK test documents and import the review rows downstream.',
    steps: ['Upload source documents or CSV exports.', 'Correct only the document type or target if needed.', 'Import review rows into WP1 or WP2.'],
  },
  wp1: {
    helper: 'Post each source document into the ledger. Complete splits, reclassifications, and missing GL accounts before moving to bank verification.',
    nextAction: 'Next action: clear Needs Split, Reclassify, and Pending Review rows.',
    steps: ['Add or paste document rows.', 'Fix any Split, Reclassify, or Select GL rows.', 'Move to WP2 after document rows are clean.'],
  },
  wp2: {
    helper: 'Verify imported bank movements against the WP1 documents, then confirm the statement and book balances before signing off WP2.',
    nextAction: 'Next action: resolve Match Multiple, New, and Needs Review bank rows, then confirm the two balances.',
    steps: ['Review the bank rows already imported from Intake.', 'Match bank rows to WP1 documents or record Bank+ / timing items.', 'Confirm the closing balance and book balance before verifying WP2.'],
  },
  adjusting: {
    helper: 'Post month-end entries that do not have a bank movement, such as reversals, accruals, and depreciation.',
    nextAction: 'Next action: confirm due reversals and post any required depreciation.',
    steps: ['Confirm reversals.', 'Add accruals if needed.', 'Post depreciation for capitalised assets.'],
  },
  review: {
    helper: 'Run the final control checks before the Journal Voucher. Critical items must be cleared before finalisation.',
    nextAction: 'Next action: use each issue button to return to the step that needs attention.',
    steps: ['Click Run Validation.', 'Open the linked step for any critical issue.', 'Finalise for JV when all critical issues are cleared.'],
  },
  journal: {
    helper: 'Review the generated Journal Voucher and finalise it only when validation has passed.',
    nextAction: 'Next action: finalise the Journal Voucher or return to Review and Validation.',
    steps: ['Check total debit and credit.', 'Confirm validation status is ready.', 'Finalise the Journal Voucher.'],
  },
  handover: {
    helper: 'Prepare the next-month handover note from timing items, reversals, recurring entries, and carry-forward schedules.',
    nextAction: 'Next action: review the checklist and add any manual notes for next month.',
    steps: ['Review generated checklist items.', 'Add any manual note.', 'Mark items noted or not applicable.'],
  },
  download: {
    helper: 'Download the end-of-session workbook for filing and next-month continuity.',
    nextAction: 'Next action: start the backend, then download the Excel workbook.',
    steps: ['Check readiness warnings.', 'Start the backend if Excel export is offline.', 'Download the workbook and open it in Excel.'],
  },
}

const snapshotMatchesCurrent = (session: SampleSession) =>
  JSON.stringify(session.finalisedJournalLinesSnapshot) === JSON.stringify(generateJournalLines(session))

function App() {
  const [activeStep, setActiveStep] = useState<WorkflowStepId>('collection')
  const [session, setSession] = useState<SampleSession>(() => createBlankBkTestSession())
  const [wp1FocusDocumentId, setWp1FocusDocumentId] = useState<string | null>(null)
  const activeMeta = useMemo(
    () => workflowSteps.find((step) => step.id === activeStep) ?? workflowSteps[0],
    [activeStep],
  )
  const guidance = pageGuidance[activeStep]
  const activeIndex = workflowSteps.findIndex((step) => step.id === activeStep)
  const previousStep = activeIndex > 0 ? workflowSteps[activeIndex - 1] : undefined
  const nextStep = activeIndex >= 0 && activeIndex < workflowSteps.length - 1 ? workflowSteps[activeIndex + 1] : undefined
  const journalVoucherNeedsReview = session.journalVoucherFinalised && !snapshotMatchesCurrent(session)

  useEffect(() => {
    telemetryMetadata('entity_name', session.client.entityName)
    telemetryMetadata('period', session.client.period)
  }, [session.client.entityName, session.client.period])

  useEffect(() => {
    telemetryEvent('step_viewed', {
      step: activeStep,
      source_documents: session.documents.length,
      bank_rows: session.bankRows.length,
      intake_rows: session.sourceIntakeItems.length,
    })

    const timer = window.setTimeout(() => {
      telemetryIssue('step_possible_stuck', {
        step: activeStep,
        review_rows: session.sourceIntakeItems.filter((item) => item.status === 'Needs Review').length,
        documents: session.documents.length,
        bank_rows: session.bankRows.length,
      })
    }, 5 * 60 * 1000)

    return () => window.clearTimeout(timer)
  }, [activeStep, session.bankRows.length, session.documents.length, session.sourceIntakeItems])

  const changeStep = (nextStepId: WorkflowStepId) => {
    if (nextStepId === activeStep) return
    telemetryEvent('step_changed', {
      from_step: activeStep,
      to_step: nextStepId,
    })
    setActiveStep(nextStepId)
  }

  const navigateToWp1Document = (documentId: string) => {
    setWp1FocusDocumentId(documentId)
    changeStep('wp1')
  }

  return (
    <AppShell activeStep={activeStep} onStepChange={changeStep} session={session}>
      <div className="view-heading">
        <span>{activeMeta.number}</span>
        <div>
          <p>{activeMeta.eyebrow}</p>
          <h2>{activeMeta.title}</h2>
        </div>
      </div>
      <section className="page-guidance">
        <div>
          <strong>{guidance.helper}</strong>
          <span>{guidance.nextAction}</span>
        </div>
        <ol className="guidance-steps">
          {guidance.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <div className="page-guidance-actions">
          {previousStep ? (
            <button className="secondary-button" onClick={() => changeStep(previousStep.id)} type="button">
              Back: {previousStep.shortTitle}
            </button>
          ) : null}
          {nextStep ? (
            <button className="primary-button" onClick={() => changeStep(nextStep.id)} type="button">
              Next: {nextStep.shortTitle}
            </button>
          ) : null}
        </div>
      </section>
      {journalVoucherNeedsReview ? (
        <section className="session-warning">
          <strong>Journal Voucher should be revalidated.</strong>
          <span>Changes were made after finalisation. Open Review and Validation, then finalise the Journal Voucher again.</span>
        </section>
      ) : null}
      <DemoControls
        activeStep={activeStep}
        onSessionChange={setSession}
        onStepChange={changeStep}
      />
      {activeStep === 'collection' ? (
        <SourceDocumentIntake
          onSessionChange={setSession}
          onStepChange={changeStep}
          session={session}
        />
      ) : activeStep === 'wp1' ? (
        <WP1DocumentLedger
          focusDocumentId={wp1FocusDocumentId}
          onClearFocus={() => setWp1FocusDocumentId(null)}
          onSessionChange={setSession}
          onStepChange={changeStep}
          session={session}
        />
      ) : activeStep === 'wp2' ? (
        <WP2BankVerification onNavigateToDocument={navigateToWp1Document} onSessionChange={setSession} onStepChange={changeStep} session={session} />
      ) : activeStep === 'adjusting' ? (
        <AdjustingEntries onSessionChange={setSession} session={session} />
      ) : activeStep === 'review' ? (
        <ReviewValidation
          onSessionChange={setSession}
          onStepChange={changeStep}
          session={session}
        />
      ) : activeStep === 'journal' ? (
        <JournalVoucher
          onSessionChange={setSession}
          onStepChange={changeStep}
          session={session}
        />
      ) : activeStep === 'handover' ? (
        <HandoverNote onSessionChange={setSession} session={session} />
      ) : activeStep === 'download' ? (
        <ExcelDownload session={session} />
      ) : null}
    </AppShell>
  )
}

export default App
