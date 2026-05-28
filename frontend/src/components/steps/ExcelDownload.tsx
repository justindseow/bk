import { useMemo, useState } from 'react'
import { buildGeneratedHandoverItems } from '../../state/handoverBuilder'
import { generateJournalLines } from '../../state/journalBuilder'
import { buildValidationResults } from '../../state/validation'
import type { SampleSession } from '../../types/session'
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
      const response = await fetch('http://127.0.0.1:8000/export/excel', {
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
        subtitle="The backend receives this browser session JSON, generates the workbook, and returns it immediately."
        title="Excel Download"
        footer={
          <>
            <div className="metric">
              <span>Filename</span>
              <strong>{filename}</strong>
            </div>
            <div className="metric">
              <span>Server Storage</span>
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
