import { useMemo, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { buildValidationResults } from '../../state/validation'
import type { ValidationIssue, ValidationSeverity } from '../../state/validation'
import type { SampleSession, WorkflowStepId } from '../../types/session'
import { WorkpaperFrame } from '../layout/WorkpaperFrame'

interface ReviewValidationProps {
  session: SampleSession
  onSessionChange: Dispatch<SetStateAction<SampleSession>>
  onStepChange: (step: WorkflowStepId) => void
}

const formatMoney = (amount: number) =>
  new Intl.NumberFormat('en-MY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)

const severityClass = (severity: ValidationSeverity) =>
  `badge validation-${severity.toLowerCase()}`

const stepLabel = (step: WorkflowStepId) => {
  const labels: Record<WorkflowStepId, string> = {
    collection: 'Collection',
    wp1: 'WP1',
    wp2: 'WP2',
    adjusting: 'Adjusting',
    review: 'Review',
    journal: 'Journal Voucher',
    handover: 'Handover',
    download: 'Excel Download',
  }
  return labels[step]
}

export function ReviewValidation({ session, onSessionChange, onStepChange }: ReviewValidationProps) {
  const [runCount, setRunCount] = useState(1)
  const validation = useMemo(() => buildValidationResults(session), [session, runCount])
  const criticalIssues = validation.issues.filter((issue) => issue.severity === 'Critical')
  const warningIssues = validation.issues.filter((issue) => issue.severity === 'Warning')

  const finalise = () => {
    if (!validation.ready) return
    onSessionChange((current) => ({ ...current, journalVoucherReady: true }))
  }

  return (
    <>
      <section className={validation.ready ? 'review-banner ready' : 'review-banner blocked'}>
        <div>
          <span>{validation.ready ? 'All critical checks passed' : 'Critical checks need attention'}</span>
          <h2>{validation.ready ? 'Ready for Journal Voucher' : 'Review Required Before Journal Voucher'}</h2>
          <p>
            {validation.ready
              ? 'You can finalise this session for Journal Voucher generation.'
              : 'Resolve the critical items below before finalising the Journal Voucher.'}
          </p>
        </div>
        <div className="review-actions">
          <button className="secondary-button" onClick={() => setRunCount((count) => count + 1)} type="button">
            Run Validation
          </button>
          <button
            className="primary-button"
            disabled={!validation.ready}
            onClick={finalise}
            title={validation.ready ? 'Finalise for Journal Voucher' : 'Critical issues must be resolved first.'}
            type="button"
          >
            Finalise for Journal Voucher
          </button>
        </div>
      </section>

      <div className="wp1-summary-grid">
        <SummaryCard label="Total Debits" tone="green" value={`RM ${formatMoney(validation.totalDebits)}`} />
        <SummaryCard label="Total Credits" tone="green" value={`RM ${formatMoney(validation.totalCredits)}`} />
        <SummaryCard
          label="Difference"
          tone={Math.abs(validation.difference) < 0.01 ? 'green' : 'red'}
          value={`RM ${formatMoney(Math.abs(validation.difference))}`}
        />
        <SummaryCard label="WP1 Unresolved" tone="orange" value={validation.summary.wp1Unresolved.toString()} />
        <SummaryCard label="WP2 Unresolved" tone="orange" value={validation.summary.wp2Unresolved.toString()} />
        <SummaryCard label="Adjusting Pending" tone="purple" value={validation.summary.adjustingPending.toString()} />
        <SummaryCard label="Critical Issues" tone="red" value={validation.summary.criticalIssues.toString()} />
        <SummaryCard label="Warning Items" tone="teal" value={validation.summary.warningItems.toString()} />
      </div>

      <WorkpaperFrame
        period={session.client.period}
        subtitle="Control checkpoint before the Journal Voucher is generated."
        title="Validation Checklist"
        footer={
          <>
            <div className="metric">
              <span>Journal Lines</span>
              <strong>{validation.journalLines.length}</strong>
            </div>
            <div className="metric">
              <span>JV Status</span>
              <strong className={session.journalVoucherReady ? 'metric-ok' : 'metric-alert'}>
                {session.journalVoucherReady ? 'Finalised' : 'Not Finalised'}
              </strong>
            </div>
          </>
        }
      >
        <div className="validation-check-grid">
          {validation.checks.map((check) => (
            <article className={`validation-check-card ${check.severity.toLowerCase()}`} key={check.id}>
              <span className={severityClass(check.severity)}>{check.severity}</span>
              <div>
                <h3>{check.label}</h3>
                <p>{check.detail}</p>
                <small>{check.area}</small>
              </div>
            </article>
          ))}
        </div>
      </WorkpaperFrame>

      <WorkpaperFrame
        period={`${criticalIssues.length} critical · ${warningIssues.length} warnings`}
        subtitle="Items to clear or carry forward before the Journal Voucher."
        title="Issues"
      >
        <IssuesTable issues={validation.issues} onStepChange={onStepChange} />
      </WorkpaperFrame>
    </>
  )
}

function SummaryCard({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: string
  tone?: 'neutral' | 'green' | 'orange' | 'purple' | 'red' | 'teal'
}) {
  return (
    <article className={`summary-card tone-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  )
}

function IssuesTable({
  issues,
  onStepChange,
}: {
  issues: ValidationIssue[]
  onStepChange: (step: WorkflowStepId) => void
}) {
  if (!issues.length) {
    return (
      <div className="review-empty-state">
        <strong>No issues found</strong>
        <p>The session is ready for Journal Voucher finalisation.</p>
      </div>
    )
  }

  return (
    <div className="table-scroll">
      <table className="data-table review-issues-table">
        <thead>
          <tr>
            <th>Severity</th>
            <th>Area</th>
            <th>Issue</th>
            <th>Suggested Action</th>
            <th>Go to Step</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue) => (
            <tr className={`review-issue-row ${issue.severity.toLowerCase()}`} key={issue.id}>
              <td>
                <span className={severityClass(issue.severity)}>{issue.severity}</span>
              </td>
              <td>{issue.area}</td>
              <td>
                <strong>{issue.issue}</strong>
              </td>
              <td>{issue.suggestedAction}</td>
              <td>
                <button className="text-button" onClick={() => onStepChange(issue.step)} type="button">
                  {stepLabel(issue.step)}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
