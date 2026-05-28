import { useMemo, useState } from 'react'
import type { ComponentType } from 'react'
import './App.css'
import { AppShell } from './components/layout/AppShell'
import { workflowSteps } from './components/layout/workflow'
import { DocumentCollection, ExcelDownload } from './components/steps/StepViews'
import { AdjustingEntries } from './components/steps/AdjustingEntries'
import { HandoverNote } from './components/steps/HandoverNote'
import { JournalVoucher } from './components/steps/JournalVoucher'
import { ReviewValidation } from './components/steps/ReviewValidation'
import { WP1DocumentLedger } from './components/steps/WP1DocumentLedger'
import { WP2BankVerification } from './components/steps/WP2BankVerification'
import { sampleSession } from './data/sampleSession'
import type { SampleSession, WorkflowStepId } from './types/session'

type ReadOnlyStepId = Exclude<
  WorkflowStepId,
  'wp1' | 'wp2' | 'adjusting' | 'review' | 'journal' | 'handover'
>

const stepComponents: Record<ReadOnlyStepId, ComponentType<{ session: SampleSession }>> = {
  collection: DocumentCollection,
  download: ExcelDownload,
}

function App() {
  const [activeStep, setActiveStep] = useState<WorkflowStepId>('collection')
  const [session, setSession] = useState<SampleSession>(sampleSession)
  const activeMeta = useMemo(
    () => workflowSteps.find((step) => step.id === activeStep) ?? workflowSteps[0],
    [activeStep],
  )
  const ActiveStep =
    activeStep === 'wp1' ||
    activeStep === 'wp2' ||
    activeStep === 'adjusting' ||
    activeStep === 'review' ||
    activeStep === 'journal' ||
    activeStep === 'handover'
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
      {activeStep === 'wp1' ? (
        <WP1DocumentLedger onSessionChange={setSession} session={session} />
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
      ) : ActiveStep ? (
        <ActiveStep session={session} />
      ) : null}
    </AppShell>
  )
}

export default App
