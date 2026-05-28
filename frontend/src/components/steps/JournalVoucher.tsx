import { useMemo, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { buildValidationResults } from '../../state/validation'
import type { JournalLine, SampleSession, WorkflowStepId } from '../../types/session'
import { WorkpaperFrame } from '../layout/WorkpaperFrame'

interface JournalVoucherProps {
  session: SampleSession
  onSessionChange: Dispatch<SetStateAction<SampleSession>>
  onStepChange: (step: WorkflowStepId) => void
}

type SourceType = JournalLine['source']

const sourceOrder: SourceType[] = ['Doc', 'Split', 'Reclassify', 'Bank+', 'Adjusting']

const sourceLabels: Record<SourceType, string> = {
  Doc: 'Document postings',
  Split: 'Split postings',
  Reclassify: 'Reclassifications',
  'Bank+': 'Bank-only entries',
  Adjusting: 'Adjusting entries',
}

const formatMoney = (amount: number) =>
  new Intl.NumberFormat('en-MY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)

const formatDateTime = (value?: string) => {
  if (!value) return '-'
  return new Intl.DateTimeFormat('en-MY', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

const voucherReference = (period: string) => {
  const clean = period.replace(/\s+/g, '').toUpperCase()
  return `JV-${clean}-001`
}

const referenceForLine = (session: SampleSession, line: JournalLine) => {
  const document = session.documents.find((item) => item.id === line.documentId)
  if (document) return document.docRef

  const bankRow = session.bankRows.find((item) => item.id === line.documentId)
  if (bankRow) return bankRow.reference

  const adjustingEntry = session.adjustingEntries.find((item) => item.id === line.documentId)
  return adjustingEntry?.id ?? line.documentId
}

const notesForLine = (session: SampleSession, line: JournalLine) => {
  if (line.source === 'Bank+') return 'Bank-only entry from WP2'
  if (line.source === 'Adjusting') {
    const entry = session.adjustingEntries.find((item) => item.id === line.documentId)
    return entry?.reverseNextMonth ? 'Reverse next month' : 'Period-end entry'
  }
  if (line.source === 'Split') return 'Confirmed split line'
  if (line.source === 'Reclassify') return 'Confirmed reclassification'
  return 'Posted from WP1'
}

const snapshotMatchesCurrent = (snapshot: JournalLine[], current: JournalLine[]) =>
  JSON.stringify(snapshot) === JSON.stringify(current)

export function JournalVoucher({ session, onSessionChange, onStepChange }: JournalVoucherProps) {
  const [runCount, setRunCount] = useState(1)
  const validation = useMemo(() => buildValidationResults(session), [session, runCount])
  const journalLines = validation.journalLines
  const hasLines = journalLines.length > 0
  const isBalanced = Math.abs(validation.difference) < 0.01
  const canFinalise = validation.ready && hasLines && isBalanced
  const staleFinalisation =
    session.journalVoucherFinalised &&
    !snapshotMatchesCurrent(session.finalisedJournalLinesSnapshot, journalLines)

  const groupedLines = sourceOrder
    .map((source) => ({
      source,
      lines: journalLines.filter((line) => line.source === source),
    }))
    .filter((group) => group.lines.length)

  const sourceDocumentCount = new Set(
    journalLines
      .filter((line) => ['Doc', 'Split', 'Reclassify'].includes(line.source))
      .map((line) => line.documentId),
  ).size
  const bankPlusCount = session.bankOnlyEntries.length
  const adjustingCount = session.adjustingEntries.length

  const finalise = () => {
    if (!canFinalise) return
    onSessionChange((current) => ({
      ...current,
      journalVoucherReady: true,
      journalVoucherFinalised: true,
      journalVoucherFinalisedAt: new Date().toISOString(),
      finalisedJournalLinesSnapshot: journalLines,
    }))
  }

  return (
    <>
      <section className={canFinalise ? 'jv-control-banner ready' : 'jv-control-banner blocked'}>
        <div>
          <span>{canFinalise ? 'Validation passed' : 'Return to review required'}</span>
          <h2>{canFinalise ? 'Journal Voucher ready for final review' : 'Journal Voucher not ready'}</h2>
          <p>
            {canFinalise
              ? 'Review the journal voucher below before finalising the session output.'
              : 'Resolve critical validation issues in Review and Validation before finalising.'}
          </p>
          {staleFinalisation ? (
            <p className="jv-warning">This Journal Voucher was finalised before later session changes. Revalidate and finalise again.</p>
          ) : null}
        </div>
        <div className="review-actions">
          <button className="secondary-button" onClick={() => setRunCount((count) => count + 1)} type="button">
            Re-run Validation
          </button>
          <button className="secondary-button" onClick={() => onStepChange('review')} type="button">
            Go to Review
          </button>
          <button className="primary-button" disabled={!canFinalise} onClick={finalise} type="button">
            Finalise Journal Voucher
          </button>
        </div>
      </section>

      <div className="wp1-summary-grid jv-summary-grid">
        <SummaryCard label="Total Debit" tone="green" value={`RM ${formatMoney(validation.totalDebits)}`} />
        <SummaryCard label="Total Credit" tone="green" value={`RM ${formatMoney(validation.totalCredits)}`} />
        <SummaryCard
          label="Difference"
          tone={isBalanced ? 'green' : 'red'}
          value={`RM ${formatMoney(Math.abs(validation.difference))}`}
        />
        <SummaryCard label="Journal Lines" tone="blue" value={journalLines.length.toString()} />
        <SummaryCard label="Source Documents" value={sourceDocumentCount.toString()} />
        <SummaryCard label="Bank+ Entries" tone="orange" value={bankPlusCount.toString()} />
        <SummaryCard label="Adjusting Entries" tone="teal" value={adjustingCount.toString()} />
        <SummaryCard
          label="Finalisation Status"
          tone={session.journalVoucherFinalised && !staleFinalisation ? 'green' : 'purple'}
          value={session.journalVoucherFinalised && !staleFinalisation ? 'Finalised' : 'Open'}
        />
      </div>

      <WorkpaperFrame
        period={session.client.period}
        subtitle={`${session.client.preparedBy} - ${voucherReference(session.client.period)}`}
        title="Journal Voucher"
        footer={
          <>
            <div className="metric">
              <span>Prepared Date</span>
              <strong>{new Date().toLocaleDateString('en-MY')}</strong>
            </div>
            <div className="metric">
              <span>Finalised</span>
              <strong className={session.journalVoucherFinalised ? 'metric-ok' : 'metric-alert'}>
                {session.journalVoucherFinalised ? formatDateTime(session.journalVoucherFinalisedAt) : 'Not yet'}
              </strong>
            </div>
            <button className="secondary-button" disabled={!canFinalise} onClick={() => window.print()} type="button">
              Print / PDF Preview
            </button>
            <button className="primary-button" disabled={!canFinalise} type="button">
              Excel Export
            </button>
          </>
        }
      >
        <VoucherHeader session={session} validationReady={validation.ready} staleFinalisation={staleFinalisation} />

        <div className="jv-readiness-grid">
          <ReadinessItem label="Debit / Credit balanced" pass={isBalanced} />
          <ReadinessItem label="WP1 resolved" pass={validation.summary.wp1Unresolved === 0} />
          <ReadinessItem label="WP2 reconciled" pass={validation.summary.wp2Unresolved === 0} />
          <ReadinessItem label="Adjusting completed" pass={validation.summary.adjustingPending === 0} />
        </div>

        {!hasLines ? (
          <div className="review-empty-state">
            <strong>No journal lines generated yet.</strong>
            <p>Complete WP1, WP2, and Adjusting Entries first.</p>
          </div>
        ) : (
          <JournalVoucherTable groupedLines={groupedLines} session={session} />
        )}

        <div className="jv-total-panel">
          <div>
            <span>Total Debit</span>
            <strong>RM {formatMoney(validation.totalDebits)}</strong>
          </div>
          <div>
            <span>Total Credit</span>
            <strong>RM {formatMoney(validation.totalCredits)}</strong>
          </div>
          <div className={isBalanced ? 'ok' : 'alert'}>
            <span>Difference</span>
            <strong>RM {formatMoney(Math.abs(validation.difference))}</strong>
          </div>
        </div>

        <SignOffBlock preparedBy={session.client.preparedBy} />
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

function VoucherHeader({
  session,
  validationReady,
  staleFinalisation,
}: {
  session: SampleSession
  validationReady: boolean
  staleFinalisation: boolean
}) {
  return (
    <section className="jv-header-card">
      <div>
        <span>Entity</span>
        <strong>{session.client.entityName}</strong>
      </div>
      <div>
        <span>Period</span>
        <strong>{session.client.period}</strong>
      </div>
      <div>
        <span>Voucher Ref</span>
        <strong>{voucherReference(session.client.period)}</strong>
      </div>
      <div>
        <span>Prepared Date</span>
        <strong>{new Date().toLocaleDateString('en-MY')}</strong>
      </div>
      <div>
        <span>Prepared By</span>
        <strong>{session.client.preparedBy}</strong>
      </div>
      <div>
        <span>Validation</span>
        <strong className={validationReady ? 'amount-in' : 'amount-out'}>
          {validationReady ? 'Passed' : 'Review Required'}
        </strong>
      </div>
      <div>
        <span>Finalisation</span>
        <strong className={session.journalVoucherFinalised && !staleFinalisation ? 'amount-in' : 'amount-out'}>
          {session.journalVoucherFinalised && !staleFinalisation ? 'Finalised' : 'Open'}
        </strong>
      </div>
    </section>
  )
}

function ReadinessItem({ label, pass }: { label: string; pass: boolean }) {
  return (
    <article className={pass ? 'jv-readiness pass' : 'jv-readiness fail'}>
      <span>{pass ? 'Pass' : 'Review'}</span>
      <strong>{label}</strong>
    </article>
  )
}

function JournalVoucherTable({
  groupedLines,
  session,
}: {
  groupedLines: Array<{ source: SourceType; lines: JournalLine[] }>
  session: SampleSession
}) {
  let rowNumber = 0

  return (
    <div className="table-scroll">
      <table className="data-table jv-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Date</th>
            <th>Source</th>
            <th>Reference</th>
            <th>Description</th>
            <th>Account Code</th>
            <th>Account Name</th>
            <th className="right">Debit</th>
            <th className="right">Credit</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {groupedLines.flatMap((group) => {
            const debitSubtotal = group.lines.reduce((sum, line) => sum + line.debit, 0)
            const creditSubtotal = group.lines.reduce((sum, line) => sum + line.credit, 0)

            return [
              <tr className="section-row" key={`${group.source}-section`}>
                <td colSpan={10}>{sourceLabels[group.source]}</td>
              </tr>,
              ...group.lines.map((line) => {
                rowNumber += 1
                return (
                  <tr key={line.id}>
                    <td className="mono">{String(rowNumber).padStart(3, '0')}</td>
                    <td>{line.date}</td>
                    <td>
                      <span className={`source source-${line.source.toLowerCase().replace('+', 'plus')}`}>
                        {line.source}
                      </span>
                    </td>
                    <td className="mono">{referenceForLine(session, line)}</td>
                    <td>{line.description}</td>
                    <td className="mono">{line.accountCode}</td>
                    <td>{line.accountName}</td>
                    <td className="right amount-in">{line.debit ? formatMoney(line.debit) : '-'}</td>
                    <td className="right amount-out">{line.credit ? formatMoney(line.credit) : '-'}</td>
                    <td>{notesForLine(session, line)}</td>
                  </tr>
                )
              }),
              <tr className="jv-subtotal-row" key={`${group.source}-subtotal`}>
                <td colSpan={7}>Subtotal - {sourceLabels[group.source]}</td>
                <td className="right">RM {formatMoney(debitSubtotal)}</td>
                <td className="right">RM {formatMoney(creditSubtotal)}</td>
                <td />
              </tr>,
            ]
          })}
        </tbody>
      </table>
    </div>
  )
}

function SignOffBlock({ preparedBy }: { preparedBy: string }) {
  return (
    <section className="jv-signoff">
      {[
        ['Prepared by', preparedBy],
        ['Reviewed by', ''],
        ['Approved by', ''],
        ['Date', ''],
      ].map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value || ' '}</strong>
        </div>
      ))}
      <div className="jv-signoff-notes">
        <span>Notes</span>
        <strong> </strong>
      </div>
    </section>
  )
}
