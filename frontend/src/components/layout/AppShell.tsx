import type { ReactNode } from 'react'
import type { SampleSession, WorkflowStepId } from '../../types/session'
import { workflowSteps } from './workflow'

interface AppShellProps {
  activeStep: WorkflowStepId
  session: SampleSession
  children: ReactNode
  onStepChange: (step: WorkflowStepId) => void
}

export function AppShell({ activeStep, session, children, onStepChange }: AppShellProps) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <span className="brand-kicker">MacroByte</span>
          <h1>BK Tool</h1>
          <p>Document-first monthly bookkeeping session</p>
        </div>

        <nav className="workflow-nav" aria-label="Bookkeeping workflow">
          {workflowSteps.map((step) => (
            <button
              className={step.id === activeStep ? 'nav-step active' : 'nav-step'}
              key={step.id}
              onClick={() => onStepChange(step.id)}
              type="button"
            >
              <span className="nav-number">{step.number}</span>
              <span>
                <strong>{step.shortTitle}</strong>
                <small>{step.eyebrow}</small>
              </span>
            </button>
          ))}
        </nav>

        <div className="sidebar-note">
          <strong>Session only</strong>
          <span>No database, no OCR, no AR/AP in this phase.</span>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div>
            <span className="topbar-label">Entity</span>
            <strong>{session.client.entityName}</strong>
          </div>
          <div>
            <span className="topbar-label">Period</span>
            <strong>{session.client.period}</strong>
          </div>
          <div>
            <span className="topbar-label">Bank</span>
            <strong>{session.client.bankAccount}</strong>
          </div>
        </header>

        <main className="content-area">{children}</main>
      </div>
    </div>
  )
}
