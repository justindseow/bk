import { useMemo, useState } from 'react'
import type { ComponentType } from 'react'
import './App.css'
import { AppShell } from './components/layout/AppShell'
import { workflowSteps } from './components/layout/workflow'
import {
  AdjustingEntries,
  DocumentCollection,
  ExcelDownload,
  HandoverNote,
  JournalVoucher,
  ReviewValidation,
  WP2BankVerification,
} from './components/steps/StepViews'
import { WP1DocumentLedger } from './components/steps/WP1DocumentLedger'
import { sampleSession } from './data/sampleSession'
import type { SampleSession, WorkflowStepId } from './types/session'

type ReadOnlyStepId = Exclude<WorkflowStepId, 'wp1'>

const stepComponents: Record<ReadOnlyStepId, ComponentType<{ session: SampleSession }>> = {
  collection: DocumentCollection,
  wp2: WP2BankVerification,
  adjusting: AdjustingEntries,
  review: ReviewValidation,
  journal: JournalVoucher,
  handover: HandoverNote,
  download: ExcelDownload,
}

function App() {
  const [activeStep, setActiveStep] = useState<WorkflowStepId>('collection')
  const [session, setSession] = useState<SampleSession>(sampleSession)
  const activeMeta = useMemo(
    () => workflowSteps.find((step) => step.id === activeStep) ?? workflowSteps[0],
    [activeStep],
  )
  const ActiveStep = activeStep === 'wp1' ? null : stepComponents[activeStep]

  return (
    <AppShell activeStep={activeStep} onStepChange={setActiveStep} session={session}>
      <div className="view-heading">
        <span>{activeMeta.number}</span>
        <div>
          <p>{activeMeta.eyebrow}</p>
          <h2>{activeMeta.title}</h2>
        </div>
      </div>
      {activeStep === 'wp1' ? (
        <WP1DocumentLedger onSessionChange={setSession} session={session} />
      ) : ActiveStep ? (
        <ActiveStep session={session} />
      ) : null}
    </AppShell>
  )
}

export default App
