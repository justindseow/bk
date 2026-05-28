import { useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import {
  createCleanDemoSession,
  createSessionWithIssues,
  finaliseDemoJournalVoucher,
  makeAdjustingReady,
  makeFullSessionReadyForJv,
  makeWp1Ready,
  makeWp2Ready,
} from '../../state/demoSessions'
import type { SampleSession, WorkflowStepId } from '../../types/session'

interface DemoControlsProps {
  activeStep: WorkflowStepId
  onSessionChange: Dispatch<SetStateAction<SampleSession>>
  onStepChange: (step: WorkflowStepId) => void
}

type GuidedStep = {
  step: WorkflowStepId
  title: string
  action: string
  expected: string
}

const guidedSteps: GuidedStep[] = [
  {
    step: 'wp1',
    title: 'WP1 split',
    action: 'Open WP1 and use Split on the annual insurance row.',
    expected: 'The split balances to the document amount and the row can become Split Done.',
  },
  {
    step: 'wp1',
    title: 'WP1 reclassify',
    action: 'Use Reclassify on the refrigerator purchase.',
    expected: 'The row is marked Reclassified and the asset account is saved.',
  },
  {
    step: 'wp2',
    title: 'WP2 match multiple',
    action: 'Open WP2 and confirm the Berjaya bulk payment against the three purchase invoices.',
    expected: 'The selected total equals the bank amount and the row becomes Matched.',
  },
  {
    step: 'wp2',
    title: 'WP2 new bank entry',
    action: 'Create a Bank+ entry for bank charges or monthly rent.',
    expected: 'A GL account is saved and the row no longer needs review.',
  },
  {
    step: 'wp2',
    title: 'WP2 timing item',
    action: 'Mark the uncleared cheque as an outstanding cheque with a carry-forward note.',
    expected: 'The timing item appears in the reconciliation and later in the handover note.',
  },
  {
    step: 'adjusting',
    title: 'Adjusting accrual',
    action: 'Create or review an accrual marked to reverse next month.',
    expected: 'Debit and credit preview balances and a future reversal item is created.',
  },
  {
    step: 'adjusting',
    title: 'Depreciation posting',
    action: 'Post depreciation for the refrigerator asset.',
    expected: 'The depreciation entry is posted and the schedule is ready for export.',
  },
  {
    step: 'review',
    title: 'Review validation',
    action: 'Run validation after using the ready presets.',
    expected: 'Critical issues are cleared and Journal Voucher readiness is available.',
  },
  {
    step: 'journal',
    title: 'Journal Voucher finalisation',
    action: 'Finalise the Journal Voucher.',
    expected: 'A finalised badge and timestamp appear on the Journal Voucher screen.',
  },
  {
    step: 'handover',
    title: 'Handover note generation',
    action: 'Open Handover Note and review the generated checklist.',
    expected: 'Timing items, reversals, and schedules are listed for next month.',
  },
  {
    step: 'download',
    title: 'Excel download',
    action: 'Open Excel Download and download the workbook.',
    expected: 'The workbook downloads with all eight tabs and current session data.',
  },
]

export function DemoControls({ activeStep, onSessionChange, onStepChange }: DemoControlsProps) {
  const [expanded, setExpanded] = useState(false)
  const [guidedActive, setGuidedActive] = useState(false)
  const [guidedIndex, setGuidedIndex] = useState(0)
  const currentStep = guidedSteps[guidedIndex]

  const applyPreset = (builder: (session: SampleSession) => SampleSession, nextStep: WorkflowStepId) => {
    onSessionChange((current) => builder(current))
    onStepChange(nextStep)
    setExpanded(true)
    if (!guidedActive) setGuidedIndex(0)
  }

  const resetClean = () => {
    onSessionChange(createCleanDemoSession())
    onStepChange('collection')
    setGuidedActive(false)
    setGuidedIndex(0)
  }

  const resetIssues = () => {
    onSessionChange(createSessionWithIssues())
    onStepChange('review')
    setExpanded(true)
    setGuidedActive(false)
    setGuidedIndex(0)
  }

  const startGuidedTest = () => {
    onSessionChange(createCleanDemoSession())
    onStepChange(guidedSteps[0].step)
    setExpanded(true)
    setGuidedActive(true)
    setGuidedIndex(0)
  }

  const nextGuidedStep = () => {
    const nextIndex = Math.min(guidedIndex + 1, guidedSteps.length - 1)
    setGuidedIndex(nextIndex)
    onStepChange(guidedSteps[nextIndex].step)
  }

  return (
    <section className="demo-controls">
      <div className="demo-controls-head">
        <div>
          <span>Demo / QA Controls</span>
          <strong>Testing presets only</strong>
        </div>
        <div className="demo-head-actions">
          <button className="secondary-button" onClick={() => setExpanded((value) => !value)} type="button">
            {expanded ? 'Hide Controls' : 'Show Controls'}
          </button>
          <button className="primary-button" onClick={startGuidedTest} type="button">
            Start Guided Test
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="demo-controls-body">
          <div className="demo-warning">Demo controls are for testing only and will reset the current session data.</div>

          <div className="demo-button-grid">
            <button className="text-button" onClick={resetClean} type="button">
              Reset to Clean Demo Session
            </button>
            <button className="text-button" onClick={resetIssues} type="button">
              Reset to Session With Issues
            </button>
            <button
              className="text-button"
              onClick={() => applyPreset(makeWp1Ready, 'wp1')}
              type="button"
            >
              Make WP1 Ready
            </button>
            <button
              className="text-button"
              onClick={() => applyPreset(makeWp2Ready, 'wp2')}
              type="button"
            >
              Make WP2 Ready
            </button>
            <button
              className="text-button"
              onClick={() => applyPreset(makeAdjustingReady, 'adjusting')}
              type="button"
            >
              Make Adjusting Entries Ready
            </button>
            <button
              className="text-button"
              onClick={() => applyPreset(makeFullSessionReadyForJv, 'review')}
              type="button"
            >
              Make Full Session Ready for JV
            </button>
            <button
              className="text-button"
              onClick={() => applyPreset(finaliseDemoJournalVoucher, 'journal')}
              type="button"
            >
              Finalise Demo Journal Voucher
            </button>
          </div>

          <div className="guided-test-panel">
            <div className="guided-current">
              <span>
                Step {guidedIndex + 1} of {guidedSteps.length}
              </span>
              <h3>{currentStep.title}</h3>
              <p>{currentStep.action}</p>
              <strong>Expected result: {currentStep.expected}</strong>
              <div className="guided-actions">
                <button
                  className="secondary-button"
                  onClick={() => onStepChange(currentStep.step)}
                  type="button"
                >
                  Go to Test Step
                </button>
                <button
                  className="primary-button"
                  disabled={guidedIndex === guidedSteps.length - 1}
                  onClick={nextGuidedStep}
                  type="button"
                >
                  Next Step
                </button>
              </div>
            </div>

            <div className="guided-checklist">
              {guidedSteps.map((step, index) => (
                <button
                  className={[
                    'guided-check-item',
                    index === guidedIndex ? 'active' : '',
                    index < guidedIndex ? 'done' : '',
                    activeStep === step.step ? 'current-screen' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  key={step.title}
                  onClick={() => {
                    setGuidedActive(true)
                    setGuidedIndex(index)
                    onStepChange(step.step)
                  }}
                  type="button"
                >
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <strong>{step.title}</strong>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
