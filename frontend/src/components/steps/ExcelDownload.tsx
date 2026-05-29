import { useMemo, useState } from 'react'
import { buildGeneratedHandoverItems } from '../../state/handoverBuilder'
import { generateJournalLines } from '../../state/journalBuilder'
import { buildValidationResults } from '../../state/validation'
import type { SampleSession } from '../../types/session'
import { apiBaseUrl } from '../../utils/api'
import { WorkpaperFrame } from '../layout/WorkpaperFrame'

interface ExcelDownloadProps {
  session: SampleSession
}

type ExportHistoryItem = {
  id: string
  filename: string
  exportedAt: string
  status: 'Downloaded' | 'Failed'
}

type FeedbackFormState = {
  testerName: string
  testerEmail: string
  rating: string
  easeOfUse: string
  confusingStep: string
  message: string
  mayContact: boolean
}

const workbookTabs = [
  {
    name: 'Journal Voucher',
    description: 'Final debit and credit listing with sign-off block.',
    carryForward: false,
  },
  {
    name: 'Trial Balance',
    description: 'Account-level movements generated from journal lines.',
    carryForward: false,
  },
  {
    name: 'Document Ledger WP1',
    description: 'Document-first audit trail with split and reclassify notes.',
    carryForward: false,
  },
  {
    name: 'Bank Verification WP2',
    description: 'Bank statement verification and reconciliation panel.',
    carryForward: false,
  },
  {
    name: 'Adjusting Entries',
    description: 'Reversals, accruals, and depreciation entries.',
    carryForward: false,
  },
  {
    name: 'Next Session Checklist',
    description: 'Carry-forward handover checklist for the next month.',
    carryForward: true,
  },
  {
    name: 'Depreciation Schedule',
    description: 'Carry-forward asset depreciation schedule.',
    carryForward: true,
  },
  {
    name: 'Prepaid Schedule',
    description: 'Carry-forward prepayment release schedule.',
    carryForward: true,
  },
]

const formatMoney = (amount: number) =>
  `RM ${new Intl.NumberFormat('en-MY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)}`

const filenameForSession = (session: SampleSession) => {
  const entity = session.client.entityName.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '')
  const [month, year] = session.client.period.split(' ')
  const period = month && year ? `${month.slice(0, 3)}_${year}` : session.client.period.replace(/\s+/g, '_')
  return `MacroByte_BK_${entity}_${period}.xlsx`
}

export function ExcelDownload({ session }: ExcelDownloadProps) {
  const [history, setHistory] = useState<ExportHistoryItem[]>([])
  const [exporting, setExporting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [messageType, setMessageType] = useState<'ok' | 'warning' | 'error'>('warning')
  const [feedback, setFeedback] = useState<FeedbackFormState>({
    testerName: '',
    testerEmail: '',
    rating: 'Good',
    easeOfUse: 'Mostly easy',
    confusingStep: '',
    message: '',
    mayContact: false,
  })
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false)
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null)
  const [feedbackMessageType, setFeedbackMessageType] = useState<'ok' | 'error'>('ok')

  const validation = useMemo(() => buildValidationResults(session), [session])
  const journalLines = useMemo(() => generateJournalLines(session), [session])
  const filename = filenameForSession(session)
  const generatedHandoverItems = useMemo(() => buildGeneratedHandoverItems(session), [session])

  const warnings = [
    !session.journalVoucherFinalised ? 'Journal Voucher is not finalised yet.' : null,
    validation.summary.criticalIssues > 0
      ? `${validation.summary.criticalIssues} critical validation issue(s) remain.`
      : null,
    journalLines.length === 0 ? 'No journal lines generated yet.' : null,
  ].filter((warning): warning is string => Boolean(warning))

  const exportSession: SampleSession = {
    ...session,
    handoverItems: session.handoverItems.length ? session.handoverItems : generatedHandoverItems,
  }

  const downloadWorkbook = async () => {
    setExporting(true)
    setMessage(null)

    try {
      const response = await fetch(`${apiBaseUrl()}/export/excel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: exportSession }),
      })

      if (!response.ok) {
        await response.text()
        throw new Error('export-failed')
      }

      const blob = await response.blob()
      if (blob.type !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
        throw new Error('invalid-workbook-response')
      }

      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)

      setHistory((current) => [
        {
          id: `export-${Date.now()}`,
          filename,
          exportedAt: new Date().toLocaleString('en-MY'),
          status: 'Downloaded',
        },
        ...current,
      ])
      setMessageType('ok')
      setMessage('Excel workbook downloaded for this session.')
    } catch (error) {
      const friendly =
        error instanceof TypeError
          ? 'Excel export service is not running. Please start the backend and try again.'
          : error instanceof Error && error.message === 'invalid-workbook-response'
            ? 'Excel export failed. Please restart the backend and try again.'
          : 'Excel export failed. Please check the session data and try again.'
      setHistory((current) => [
        {
          id: `export-${Date.now()}`,
          filename,
          exportedAt: new Date().toLocaleString('en-MY'),
          status: 'Failed',
        },
        ...current,
      ])
      setMessageType('error')
      setMessage(friendly)
    } finally {
      setExporting(false)
    }
  }

  const submitFeedback = async () => {
    if (feedback.message.trim().length < 5) {
      setFeedbackMessageType('error')
      setFeedbackMessage('Please add a short note before submitting feedback.')
      return
    }

    setFeedbackSubmitting(true)
    setFeedbackMessage(null)

    try {
      const response = await fetch(`${apiBaseUrl()}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tester_name: feedback.testerName.trim(),
          tester_email: feedback.testerEmail.trim(),
          rating: feedback.rating,
          ease_of_use: feedback.easeOfUse,
          confusing_step: feedback.confusingStep,
          message: feedback.message.trim(),
          may_contact: feedback.mayContact,
          entity: session.client.entityName,
          period: session.client.period,
          journal_voucher_finalised: session.journalVoucherFinalised,
          critical_issues: validation.summary.criticalIssues,
        }),
      })

      if (!response.ok) {
        throw new Error(await response.text())
      }

      setFeedbackMessageType('ok')
      setFeedbackMessage('Thank you. Your feedback was sent.')
      setFeedback((current) => ({ ...current, message: '', confusingStep: '' }))
    } catch (error) {
      setFeedbackMessageType('error')
      setFeedbackMessage(
        error instanceof TypeError
          ? 'Feedback service is not running. Please start the backend and try again.'
          : 'Feedback could not be sent right now. Please try again later.',
      )
    } finally {
      setFeedbackSubmitting(false)
    }
  }

  return (
    <>
      <section className={warnings.length ? 'export-readiness warning' : 'export-readiness ready'}>
        <div>
          <span>{warnings.length ? 'Review before export' : 'Ready to export'}</span>
          <h2>{warnings.length ? 'Workbook can be downloaded with warnings' : 'Excel workbook ready'}</h2>
          <p>
            {warnings.length
              ? 'The file can still be generated, but review the items below before relying on it.'
              : 'The session is ready for the end-of-month Excel output.'}
          </p>
        </div>
        <button className="primary-button" disabled={exporting} onClick={downloadWorkbook} type="button">
          {exporting ? 'Preparing Workbook...' : 'Download Excel Workbook'}
        </button>
      </section>

      {warnings.length ? (
        <div className="export-warning-list">
          {warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      ) : null}

      {message ? <div className={`export-message ${messageType}`}>{message}</div> : null}

      <div className="wp1-summary-grid export-summary-grid">
        <SummaryCard label="Workbook Tabs" tone="blue" value="8" />
        <SummaryCard label="Journal Lines" tone={journalLines.length ? 'green' : 'red'} value={journalLines.length.toString()} />
        <SummaryCard label="Total Debit" tone="green" value={formatMoney(validation.totalDebits)} />
        <SummaryCard label="Total Credit" tone="green" value={formatMoney(validation.totalCredits)} />
        <SummaryCard
          label="Difference"
          tone={Math.abs(validation.difference) < 0.01 ? 'green' : 'red'}
          value={formatMoney(Math.abs(validation.difference))}
        />
        <SummaryCard
          label="JV Status"
          tone={session.journalVoucherFinalised ? 'green' : 'orange'}
          value={session.journalVoucherFinalised ? 'Finalised' : 'Open'}
        />
      </div>

      <WorkpaperFrame
        period={session.client.period}
        subtitle="The workbook is prepared from the current session and returned immediately."
        title="Excel Download"
        footer={
          <>
            <div className="metric">
              <span>Filename</span>
              <strong>{filename}</strong>
            </div>
            <div className="metric">
              <span>Saved on Server</span>
              <strong>None</strong>
            </div>
            <button className="primary-button" disabled={exporting} onClick={downloadWorkbook} type="button">
              Download Excel Workbook
            </button>
          </>
        }
      >
        <section className="export-tab-grid">
          {workbookTabs.map((tab, index) => (
            <article className={tab.carryForward ? 'export-tab carry-forward' : 'export-tab'} key={tab.name}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <div>
                <h3>{tab.name}</h3>
                <p>{tab.description}</p>
              </div>
              {tab.carryForward ? <strong>Carry-forward</strong> : null}
            </article>
          ))}
        </section>

        <section className="download-history">
          <div className="download-history-head">
            <h3>Download History</h3>
            <span>Current browser session only</span>
          </div>
          {history.length ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Filename</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {history.map((item) => (
                  <tr key={item.id}>
                    <td>{item.exportedAt}</td>
                    <td className="mono">{item.filename}</td>
                    <td>
                      <span className={item.status === 'Downloaded' ? 'badge badge-posted' : 'badge badge-pending-review'}>
                        {item.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="handover-empty">No downloads in this browser session yet.</div>
          )}
        </section>

        <section className="feedback-panel">
          <div className="feedback-head">
            <span>BK feedback</span>
            <h3>How was this test session?</h3>
            <p>Your feedback is emailed to the MacroByte reviewer. No feedback is stored in the app.</p>
          </div>

          {feedbackMessage ? (
            <div className={`export-message ${feedbackMessageType}`}>{feedbackMessage}</div>
          ) : null}

          <div className="feedback-grid">
            <label>
              <span>Your name</span>
              <input
                value={feedback.testerName}
                onChange={(event) => setFeedback({ ...feedback, testerName: event.target.value })}
                placeholder="Optional"
              />
            </label>
            <label>
              <span>Your email</span>
              <input
                value={feedback.testerEmail}
                onChange={(event) => setFeedback({ ...feedback, testerEmail: event.target.value })}
                placeholder="Optional"
                type="email"
              />
            </label>
            <label>
              <span>Overall rating</span>
              <select
                value={feedback.rating}
                onChange={(event) => setFeedback({ ...feedback, rating: event.target.value })}
              >
                <option>Excellent</option>
                <option>Good</option>
                <option>Okay</option>
                <option>Needs work</option>
              </select>
            </label>
            <label>
              <span>Ease of use</span>
              <select
                value={feedback.easeOfUse}
                onChange={(event) => setFeedback({ ...feedback, easeOfUse: event.target.value })}
              >
                <option>Very easy</option>
                <option>Mostly easy</option>
                <option>Some parts confusing</option>
                <option>Hard to follow</option>
              </select>
            </label>
            <label className="wide-field">
              <span>Which step was confusing?</span>
              <select
                value={feedback.confusingStep}
                onChange={(event) => setFeedback({ ...feedback, confusingStep: event.target.value })}
              >
                <option value="">None / not sure</option>
                <option>Document Collection</option>
                <option>WP1 Document Posting Ledger</option>
                <option>WP2 Bank Verification</option>
                <option>Adjusting Entries</option>
                <option>Review and Validation</option>
                <option>Journal Voucher</option>
                <option>Handover Note</option>
                <option>Excel Download</option>
              </select>
            </label>
            <label className="wide-field">
              <span>Feedback notes</span>
              <textarea
                value={feedback.message}
                onChange={(event) => setFeedback({ ...feedback, message: event.target.value })}
                placeholder="What felt easy, confusing, missing, or different from the real BK workflow?"
                rows={5}
              />
            </label>
          </div>

          <label className="feedback-checkbox">
            <input
              checked={feedback.mayContact}
              onChange={(event) => setFeedback({ ...feedback, mayContact: event.target.checked })}
              type="checkbox"
            />
            <span>You may contact me about this feedback.</span>
          </label>

          <div className="feedback-actions">
            <button
              className="primary-button"
              disabled={feedbackSubmitting}
              onClick={submitFeedback}
              type="button"
            >
              {feedbackSubmitting ? 'Sending Feedback...' : 'Submit Feedback'}
            </button>
          </div>
        </section>
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
  tone?: 'neutral' | 'green' | 'orange' | 'purple' | 'red' | 'teal' | 'blue'
}) {
  return (
    <article className={`summary-card tone-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  )
}
