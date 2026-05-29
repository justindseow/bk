import { useMemo, useState } from 'react'
import type { ComponentType } from 'react'
import './App.css'
import { DemoControls } from './components/demo/DemoControls'
import { AppShell } from './components/layout/AppShell'
import { workflowSteps } from './components/layout/workflow'
import { DocumentCollection } from './components/steps/StepViews'
import { AdjustingEntries } from './components/steps/AdjustingEntries'
import { ExcelDownload } from './components/steps/ExcelDownload'
import { HandoverNote } from './components/steps/HandoverNote'
import { JournalVoucher } from './components/steps/JournalVoucher'
import { ReviewValidation } from './components/steps/ReviewValidation'
import { WP1DocumentLedger } from './components/steps/WP1DocumentLedger'
import { WP2BankVerification } from './components/steps/WP2BankVerification'
import { sampleSession } from './data/sampleSession'
import { generateJournalLines } from './state/journalBuilder'
import type { SampleSession, WorkflowStepId } from './types/session'

type ReadOnlyStepId = Exclude<
  WorkflowStepId,
  'wp1' | 'wp2' | 'adjusting' | 'review' | 'journal' | 'handover' | 'download'
>

const stepComponents: Record<ReadOnlyStepId, ComponentType<{ session: SampleSession }>> = {
  collection: DocumentCollection,
}

const pageGuidance: Record<WorkflowStepId, { helper: string; nextAction: string; steps: string[] }> = {
  collection: {
    helper: 'Collect the month source documents first. Keep the bank statement ready, but use it after WP1.',
    nextAction: 'Next action: open WP1 and start posting the source documents.',
    steps: ['Check that source documents are available.', 'Keep the bank statement aside.', 'Move to WP1 when ready.'],
  },
  wp1: {
    helper: 'Post each source document into the ledger. Complete splits, reclassifications, and missing GL accounts before moving to bank verification.',
    nextAction: 'Next action: clear Needs Split, Reclassify, and Pending Review rows.',
    steps: ['Add or paste document rows.', 'Fix any Split, Reclassify, or Select GL rows.', 'Move to WP2 after document rows are clean.'],
  },
  wp2: {
    helper: 'Verify bank movements against the WP1 documents. Add bank-only entries only where no source document exists.',
    nextAction: 'Next action: resolve Match Multiple, New, and Needs Review bank rows.',
    steps: ['Add or paste bank statement rows.', 'Match bank rows to WP1 documents.', 'Record bank-only or timing items where needed.'],
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
  const [session, setSession] = useState<SampleSession>(sampleSession)
  const activeMeta = useMemo(
    () => workflowSteps.find((step) => step.id === activeStep) ?? workflowSteps[0],
    [activeStep],
  )
  const guidance = pageGuidance[activeStep]
  const activeIndex = workflowSteps.findIndex((step) => step.id === activeStep)
  const previousStep = activeIndex > 0 ? workflowSteps[activeIndex - 1] : undefined
  const nextStep = activeIndex >= 0 && activeIndex < workflowSteps.length - 1 ? workflowSteps[activeIndex + 1] : undefined
  const journalVoucherNeedsReview = session.journalVoucherFinalised && !snapshotMatchesCurrent(session)
  const ActiveStep =
    activeStep === 'wp1' ||
    activeStep === 'wp2' ||
    activeStep === 'adjusting' ||
    activeStep === 'review' ||
    activeStep === 'journal' ||
    activeStep === 'handover' ||
    activeStep === 'download'
      ? null
      : stepComponents[activeStep]

  return (
    <AppShell activeStep={activeStep} onStepChange={setActiveStep} session={session}>
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
            <button className="secondary-button" onClick={() => setActiveStep(previousStep.id)} type="button">
              Back: {previousStep.shortTitle}
            </button>
          ) : null}
          {nextStep ? (
            <button className="primary-button" onClick={() => setActiveStep(nextStep.id)} type="button">
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
        onStepChange={setActiveStep}
      />
      {activeStep === 'wp1' ? (
        <WP1DocumentLedger
          onSessionChange={setSession}
          onStepChange={setActiveStep}
          session={session}
        />
      ) : activeStep === 'wp2' ? (
        <WP2BankVerification onSessionChange={setSession} session={session} />
      ) : activeStep === 'adjusting' ? (
        <AdjustingEntries onSessionChange={setSession} session={session} />
      ) : activeStep === 'review' ? (
        <ReviewValidation
          onSessionChange={setSession}
          onStepChange={setActiveStep}
          session={session}
        />
      ) : activeStep === 'journal' ? (
        <JournalVoucher
          onSessionChange={setSession}
          onStepChange={setActiveStep}
          session={session}
        />
      ) : activeStep === 'handover' ? (
        <HandoverNote onSessionChange={setSession} session={session} />
      ) : activeStep === 'download' ? (
        <ExcelDownload session={session} />
      ) : ActiveStep ? (
        <ActiveStep session={session} />
      ) : null}
    </AppShell>
  )
}

export default App
