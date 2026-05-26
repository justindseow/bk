import { useMemo, useState } from 'react'
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
  WP1DocumentLedger,
  WP2BankVerification,
} from './components/steps/StepViews'
import { sampleSession } from './data/sampleSession'
import type { WorkflowStepId } from './types/session'

const stepComponents = {
  collection: DocumentCollection,
  wp1: WP1DocumentLedger,
  wp2: WP2BankVerification,
  adjusting: AdjustingEntries,
  review: ReviewValidation,
  journal: JournalVoucher,
  handover: HandoverNote,
  download: ExcelDownload,
}

function App() {
  const [activeStep, setActiveStep] = useState<WorkflowStepId>('collection')
  const activeMeta = useMemo(
    () => workflowSteps.find((step) => step.id === activeStep) ?? workflowSteps[0],
    [activeStep],
  )
  const ActiveStep = stepComponents[activeStep]

  return (
    <AppShell activeStep={activeStep} onStepChange={setActiveStep} session={sampleSession}>
      <div className="view-heading">
        <span>{activeMeta.number}</span>
        <div>
          <p>{activeMeta.eyebrow}</p>
          <h2>{activeMeta.title}</h2>
        </div>
      </div>
      <ActiveStep session={sampleSession} />
    </AppShell>
  )
}

export default App
