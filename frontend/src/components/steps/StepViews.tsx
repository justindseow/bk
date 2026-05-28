import type { SampleSession } from '../../types/session'
import { WorkpaperFrame } from '../layout/WorkpaperFrame'

interface StepProps {
  session: SampleSession
}

const formatMoney = (amount: number) =>
  new Intl.NumberFormat('en-MY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)

const statusClass = (status: string) =>
  `badge badge-${status
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`

export function DocumentCollection({ session }: StepProps) {
  return (
    <WorkpaperFrame
      period={session.client.period}
      subtitle="Collect source documents first. The bank statement is collected now but only used after WP1."
      title="Document Collection"
      footer={
        <>
          <div className="metric">
            <span>Documents ready</span>
            <strong>{session.documents.length}</strong>
          </div>
          <div className="metric">
            <span>Bank statement</span>
            <strong>Set aside</strong>
          </div>
          <button className="primary-button" type="button">
            Start WP1
          </button>
        </>
      }
    >
      <div className="collection-grid">
        {[
          'Sales invoices and merchant statements',
          'Purchase invoices and payment vouchers',
          'Receipts, utilities, payroll support',
          'Bank statement for verification step',
        ].map((item) => (
          <label className="check-card" key={item}>
            <input defaultChecked={item !== 'Bank statement for verification step'} type="checkbox" />
            <span>{item}</span>
          </label>
        ))}
      </div>
      <div className="info-panel gold">
        <strong>Document-first rule</strong>
        <p>Post source documents into WP1 before loading or matching the bank statement.</p>
      </div>
    </WorkpaperFrame>
  )
}

export function WP1DocumentLedger({ session }: StepProps) {
  return (
    <WorkpaperFrame
      period={session.client.period}
      subtitle={`${session.client.entityName} - all source documents posted before bank verification`}
      title="Document Posting Ledger - WP 1"
      footer={
        <>
          <div className="metric">
            <span>Posted</span>
            <strong>
              {
                session.documents.filter((doc) =>
                  ['Posted', 'Split Done', 'Reclassified'].includes(doc.status),
                ).length
              }
            </strong>
          </div>
          <div className="metric">
            <span>Splits</span>
            <strong>{session.documents.filter((doc) => doc.status === 'Split Done').length}</strong>
          </div>
          <div className="metric">
            <span>Reclassify</span>
            <strong>{session.documents.filter((doc) => doc.status === 'Reclassified').length}</strong>
          </div>
          <button className="primary-button" type="button">
            Add Document
          </button>
        </>
      }
    >
      <table className="data-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Date</th>
            <th>Doc Ref</th>
            <th>Vendor / Customer</th>
            <th>Doc Type</th>
            <th className="right">Amount (RM)</th>
            <th>Flow</th>
            <th>GL Account</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {session.documents.map((doc) => (
            <tr key={doc.id}>
              <td className="muted">{doc.id}</td>
              <td>{doc.date}</td>
              <td className="mono">{doc.docRef}</td>
              <td>
                <strong>{doc.party}</strong>
                {doc.note ? <small>{doc.note}</small> : null}
              </td>
              <td>{doc.docType}</td>
              <td className={doc.flow === 'IN' ? 'right amount-in' : 'right amount-out'}>
                {doc.flow === 'OUT' ? `(${formatMoney(doc.amount)})` : formatMoney(doc.amount)}
              </td>
              <td>
                <span className={doc.flow === 'IN' ? 'flow flow-in' : 'flow flow-out'}>{doc.flow}</span>
              </td>
              <td className="mono">{doc.glAccount}</td>
              <td>
                <span className={statusClass(doc.status)}>{doc.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </WorkpaperFrame>
  )
}

export function WP2BankVerification({ session }: StepProps) {
  return (
    <WorkpaperFrame
      period={session.client.period}
      subtitle={`${session.client.bankAccount} - loaded after document posting`}
      title="Bank Verification Sheet - WP 2"
      footer={
        <>
          <div className="metric">
            <span>Matched</span>
            <strong>{session.bankRows.filter((row) => row.status === 'Matched').length}</strong>
          </div>
          <div className="metric">
            <span>Bank+</span>
            <strong>{session.bankRows.filter((row) => row.status === 'Added (Bank+)').length}</strong>
          </div>
          <div className="metric">
            <span>Recon</span>
            <strong>RM 0</strong>
          </div>
          <button className="primary-button" type="button">
            Add Bank Entry
          </button>
        </>
      }
    >
      <table className="data-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Date</th>
            <th>Bank Description</th>
            <th className="right">Amount (RM)</th>
            <th>Dir</th>
            <th>Status</th>
            <th>Matched to Doc(s)</th>
            <th>Remarks</th>
          </tr>
        </thead>
        <tbody>
          {session.bankRows.map((row) => (
            <tr key={row.id}>
              <td className="muted">{row.id}</td>
              <td>{row.date}</td>
              <td>
                <strong>{row.description}</strong>
              </td>
              <td className={row.direction === 'CR' ? 'right amount-in' : 'right amount-out'}>
                {row.direction === 'DR' ? `(${formatMoney(row.amount)})` : formatMoney(row.amount)}
              </td>
              <td>
                <span className={row.direction === 'CR' ? 'flow flow-in' : 'flow flow-out'}>
                  {row.direction}
                </span>
              </td>
              <td>
                <span className={statusClass(row.status)}>{row.status}</span>
              </td>
              <td className="mono">{row.matchedTo}</td>
              <td>{row.remarks}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="recon-panel">
        <div>
          <h3>Bank Statement</h3>
          <p>Closing balance RM 48,320.00</p>
          <p>Less timing items RM 1,200.00</p>
        </div>
        <div>
          <h3>Adjusted Balance</h3>
          <p>Adjusted bank RM 47,120.00</p>
          <p>Adjusted book RM 47,120.00</p>
        </div>
        <strong>Difference RM 0.00</strong>
      </div>
    </WorkpaperFrame>
  )
}

export function AdjustingEntries({ session }: StepProps) {
  return (
    <WorkpaperFrame
      period={session.client.period}
      subtitle="Period-end entries with no bank movement."
      title="Adjusting Entries"
      footer={
        <>
          <div className="metric">
            <span>Entries</span>
            <strong>{session.adjustingEntries.length}</strong>
          </div>
          <div className="metric">
            <span>Reversals</span>
            <strong>{session.adjustingEntries.filter((entry) => entry.reversal !== 'No reversal').length}</strong>
          </div>
          <button className="primary-button" type="button">
            Add Adjusting Entry
          </button>
        </>
      }
    >
      <div className="entry-list">
        {session.adjustingEntries.map((entry) => (
          <article className="adjusting-card" key={entry.id}>
            <div>
              <span className="mono">{entry.id}</span>
              <h3>{entry.description}</h3>
              <p>{entry.date}</p>
            </div>
            <div className="entry-lines">
              <span>DR {entry.debitAccount}</span>
              <strong>{formatMoney(entry.amount)}</strong>
              <span>CR {entry.creditAccount}</span>
              <strong>{formatMoney(entry.amount)}</strong>
            </div>
            <span className={entry.reversal === 'No reversal' ? 'badge badge-posted' : 'badge badge-pending'}>
              {entry.reversal}
            </span>
          </article>
        ))}
      </div>
    </WorkpaperFrame>
  )
}

export function ReviewValidation({ session }: StepProps) {
  return (
    <WorkpaperFrame
      period={session.client.period}
      subtitle="Automatic checks before generating the journal voucher."
      title="Session Review and Validation"
      footer={
        <>
          <div className="metric">
            <span>JV Lines</span>
            <strong>12</strong>
          </div>
          <div className="metric">
            <span>Unresolved</span>
            <strong>0</strong>
          </div>
          <button className="primary-button" type="button">
            Generate Journal Voucher
          </button>
        </>
      }
    >
      <div className="validation-grid">
        {['DR equals CR', 'Bank difference is RM 0', 'No unresolved bank rows', 'All splits balance'].map(
          (check) => (
            <div className="validation-card" key={check}>
              <strong>Pass</strong>
              <span>{check}</span>
            </div>
          ),
        )}
      </div>
      <div className="info-panel">
        <strong>Advisory notes</strong>
        <p>{session.documents.find((doc) => doc.status === 'Reclassified')?.note}</p>
        <p>Outstanding cheque remains a timing item for next month.</p>
      </div>
    </WorkpaperFrame>
  )
}

export function JournalVoucher({ session }: StepProps) {
  return (
    <WorkpaperFrame
      period={session.client.period}
      subtitle={`${session.client.preparedBy} - source-tagged posting output`}
      title="Journal Voucher"
      footer={
        <>
          <div className="metric">
            <span>Balanced</span>
            <strong>Yes</strong>
          </div>
          <button className="secondary-button" type="button">
            PDF
          </button>
          <button className="primary-button" type="button">
            Excel
          </button>
        </>
      }
    >
      <table className="data-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Date</th>
            <th>Description</th>
            <th>GL Code</th>
            <th>Account Name</th>
            <th className="right">Debit (RM)</th>
            <th className="right">Credit (RM)</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          <tr className="section-row">
            <td colSpan={8}>Revenue and expenses from documents</td>
          </tr>
          <tr>
            <td className="mono">001</td>
            <td>03 Jan</td>
            <td>Maya Food Supply - sales receipt</td>
            <td className="mono">1020</td>
            <td>CIMB Current Account</td>
            <td className="right amount-in">12,500.00</td>
            <td className="right">-</td>
            <td>
              <span className="source source-doc">Doc</span>
            </td>
          </tr>
          <tr>
            <td className="mono">002</td>
            <td>03 Jan</td>
            <td className="indent">Sales Revenue</td>
            <td className="mono">4100</td>
            <td>Sales Revenue</td>
            <td className="right">-</td>
            <td className="right amount-out">12,500.00</td>
            <td>
              <span className="source source-doc">Doc</span>
            </td>
          </tr>
          <tr className="section-row">
            <td colSpan={8}>Adjusting entries</td>
          </tr>
          {session.adjustingEntries.map((entry, index) => (
            <tr key={entry.id}>
              <td className="mono">{String(index + 3).padStart(3, '0')}</td>
              <td>{entry.date}</td>
              <td>{entry.description}</td>
              <td className="mono">{entry.debitAccount.slice(0, 4)}</td>
              <td>{entry.debitAccount.slice(7)}</td>
              <td className="right amount-in">{formatMoney(entry.amount)}</td>
              <td className="right">-</td>
              <td>
                <span className="source source-adj">Adjusting</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </WorkpaperFrame>
  )
}

export function HandoverNote({ session }: StepProps) {
  return (
    <WorkpaperFrame
      period="February 2025"
      subtitle={`Generated from ${session.client.period} session.`}
      title="Handover Note - Next Session Checklist"
      footer={
        <>
          <div className="metric">
            <span>Checklist items</span>
            <strong>{session.checklistItems.length}</strong>
          </div>
          <button className="primary-button" type="button">
            Export Note
          </button>
        </>
      }
    >
      <div className="checklist-list">
        {session.checklistItems.map((item) => (
          <article className="checklist-row" key={item.id}>
            <span>{item.section}</span>
            <div>
              <h3>{item.action}</h3>
              <p>{item.reference}</p>
              <small>{item.note}</small>
            </div>
            <strong>RM {formatMoney(item.amount)}</strong>
          </article>
        ))}
      </div>
    </WorkpaperFrame>
  )
}

export function ExcelDownload({ session }: StepProps) {
  return (
    <WorkpaperFrame
      period={session.client.period}
      subtitle="Download the current session as an Excel workbook. The backend receives JSON only for this export."
      title="Excel Download"
      footer={
        <>
          <div className="metric">
            <span>Workbook tabs</span>
            <strong>8</strong>
          </div>
          <button className="primary-button" type="button">
            Download Excel
          </button>
        </>
      }
    >
      <div className="tabs-preview">
        {[
          'Journal Voucher',
          'Trial Balance',
          'Document Ledger (WP1)',
          'Bank Verification (WP2)',
          'Adjusting Entries',
          'Next Session Checklist',
          'Depreciation Schedule',
          'Prepaid Schedule',
        ].map((tab, index) => (
          <div className={index >= 5 ? 'excel-tab persistent' : 'excel-tab'} key={tab}>
            {tab}
          </div>
        ))}
      </div>
      <div className="info-panel green">
        <strong>No server-side storage</strong>
        <p>The Excel file is generated from this browser session JSON and returned immediately.</p>
      </div>
    </WorkpaperFrame>
  )
}
