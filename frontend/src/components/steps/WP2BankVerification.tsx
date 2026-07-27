import { useMemo, useState } from 'react'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import { findAccount } from '../../data/accounts'
import { generateDraftJournalLinesFromBankEntries } from '../../state/journalBuilder'
import { calculateWp2Reconciliation } from '../../state/validation'
import type {
  AccountOption,
  BankOnlyEntry,
  BankRow,
  BankStatus,
  SampleSession,
  SourceDocument,
  TimingItem,
  TimingItemType,
  WorkflowStepId,
} from '../../types/session'
import { WorkpaperFrame } from '../layout/WorkpaperFrame'
import { downloadCsv } from '../../utils/downloadCsv'
import {
  bankOnlySuggestionForRow,
  suggestedDocumentsForBankRow,
} from '../../utils/wp2Heuristics'

interface WP2BankVerificationProps {
  session: SampleSession
  onSessionChange: Dispatch<SetStateAction<SampleSession>>
  onNavigateToDocument: (documentId: string) => void
  onStepChange: (step: WorkflowStepId) => void
}

type ModalState =
  | { type: 'match-multiple'; bankRow: BankRow }
  | { type: 'new-entry'; bankRow: BankRow }
  | { type: 'timing-item'; bankRow: BankRow }
  | { type: 'add-bank-row' }
  | { type: 'edit-bank-row'; bankRow: BankRow }
  | null

type BankRowFormState = {
  date: string
  description: string
  reference: string
  moneyIn: number
  moneyOut: number
  notes: string
}

const bankOnlyAccountCodes = ['6370', '6200', '7100', '6390', '2110', '6600']

const bankOnlyAccounts = bankOnlyAccountCodes
  .map((code) => findAccount(code))
  .filter((account): account is AccountOption => Boolean(account))

const formatMoney = (amount: number) =>
  new Intl.NumberFormat('en-MY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)

const statusKey = (status: string) =>
  status
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

const statusClass = (status: string) => `badge badge-${statusKey(status)}`

const suggestedDocumentsForRow = (session: SampleSession, bankRow: BankRow) => {
  const explicit = bankRow.suggestedDocumentIds
    ?.map((id) => session.documents.find((document) => document.id === id))
    .filter((document): document is SourceDocument => Boolean(document))

  if (explicit?.length) return explicit

  return suggestedDocumentsForBankRow(session.documents, bankRow)
}

const documentLabel = (document: SourceDocument) => `${document.docRef} - ${document.party}`

const amountIn = (row: BankRow) => (row.direction === 'CR' ? row.amount : 0)

const amountOut = (row: BankRow) => (row.direction === 'DR' ? row.amount : 0)

const nextBankRowId = (rows: BankRow[]) => {
  const maxNumber = rows.reduce((max, row) => {
    const numeric = Number(row.id.replace(/\D/g, ''))
    return Number.isFinite(numeric) ? Math.max(max, numeric) : max
  }, 0)
  return String(maxNumber + 1).padStart(2, '0')
}

const bankFormFromRow = (row?: BankRow): BankRowFormState => ({
  date: row?.date ?? '',
  description: row?.description ?? '',
  reference: row?.reference ?? '',
  moneyIn: row?.direction === 'CR' ? row.amount : 0,
  moneyOut: row?.direction === 'DR' ? row.amount : 0,
  notes: row?.remarks ?? '',
})

const parseAmount = (value: string) => Number(value.replace(/[(),RM\s]/gi, '').replace(/,/g, '')) || 0

const bankRowFromForm = (form: BankRowFormState, id: string): BankRow => {
  const moneyIn = Number(form.moneyIn || 0)
  const moneyOut = Number(form.moneyOut || 0)
  const direction = moneyIn > 0 ? 'CR' : 'DR'
  return {
    id,
    date: form.date.trim(),
    description: form.description.trim(),
    reference: form.reference.trim(),
    amount: moneyIn > 0 ? moneyIn : moneyOut,
    direction,
    status: 'Needs Review',
    matchedTo: 'Review against WP1',
    remarks: form.notes.trim() || 'Manual bank row',
  }
}

const parseWp2Paste = (text: string): BankRowFormState[] =>
  text
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) => row.split('\t').map((cell) => cell.trim()))
    .filter((cells) => cells[0]?.toLowerCase() !== 'date')
    .map(([date = '', description = '', reference = '', moneyIn = '', moneyOut = '', notes = '']) => ({
      date,
      description,
      reference,
      moneyIn: parseAmount(moneyIn),
      moneyOut: parseAmount(moneyOut),
      notes,
    }))

export function WP2BankVerification({ session, onSessionChange, onNavigateToDocument, onStepChange }: WP2BankVerificationProps) {
  const [modal, setModal] = useState<ModalState>(null)
  const [pasteText, setPasteText] = useState('')
  const [pastePreview, setPastePreview] = useState<BankRowFormState[]>([])
  const [rowFilter, setRowFilter] = useState<BankStatus | null>(null)
  const bankPlusLines = useMemo(() => generateDraftJournalLinesFromBankEntries(session), [session])

  const reconciliation = useMemo(() => calculateWp2Reconciliation(session), [session])

  const summary = useMemo(
    () => ({
      rows: session.bankRows.length,
      matched: session.bankRows.filter((row) => row.status === 'Matched').length,
      matchMultiple: session.bankRows.filter((row) => row.status === 'Match Multiple').length,
      proposedMatch: session.bankRows.filter((row) => row.status === 'Proposed Match').length,
      newRows: session.bankRows.filter((row) => row.status === 'New').length,
      timingItems: session.timingItems.length,
      needsReview: session.bankRows.filter((row) => row.status === 'Needs Review').length,
    }),
    [session.bankRows, session.timingItems.length],
  )
  const filteredRows = rowFilter
    ? session.bankRows.filter((row) => row.status === rowFilter)
    : session.bankRows

  const hasConfirmedBalances =
    reconciliation.bankClosingBalance !== null && reconciliation.bookBalanceBeforeBankOnly !== null
  const unresolvedRowCount = summary.needsReview + summary.newRows + summary.matchMultiple + summary.proposedMatch
  const canVerifyWp2 =
    session.bankRows.length > 0 &&
    hasConfirmedBalances &&
    unresolvedRowCount === 0 &&
    reconciliation.difference !== null &&
    Math.abs(reconciliation.difference) < 0.01

  const markWp2Dirty = (current: SampleSession) => ({
    ...current,
    wp2VerifiedAt: undefined,
    journalVoucherReady: false,
  })

  const markSingleMatched = (bankRow: BankRow) => {
    const suggested = suggestedDocumentsForRow(session, bankRow)
    const firstMatch = suggested[0]
    if (!firstMatch || firstMatch.status === 'Pending Review') return

    onSessionChange((current) => ({
      ...markWp2Dirty(current),
      bankMatches: [
        ...current.bankMatches.filter((match) => match.bankRowId !== bankRow.id),
        {
          bankRowId: bankRow.id,
          documentIds: [firstMatch.id],
          matchType: 'Manual',
          confirmedAt: new Date().toISOString(),
        },
      ],
      bankRows: current.bankRows.map((row) =>
        row.id === bankRow.id
          ? {
              ...row,
              status: 'Matched',
              matchedTo: firstMatch.docRef,
              remarks: 'Verified against WP1',
            }
          : row,
      ),
    }))
  }

  const deleteBankRow = (bankRowId: string) => {
    if (!window.confirm('Delete this bank row from the current session?')) return
    onSessionChange((current) => ({
      ...markWp2Dirty(current),
      bankRows: current.bankRows.filter((row) => row.id !== bankRowId),
      bankMatches: current.bankMatches.filter((match) => match.bankRowId !== bankRowId),
      bankOnlyEntries: current.bankOnlyEntries.filter((entry) => entry.bankRowId !== bankRowId),
      timingItems: current.timingItems.filter((item) => item.bankRowId !== bankRowId),
    }))
  }

  const importPreviewRows = () => {
    onSessionChange((current) => {
      let counter = 0
      const rows = pastePreview.map((row) => {
        counter += 1
        return bankRowFromForm(row, `B${String(current.bankRows.length + counter).padStart(3, '0')}`)
      })
      return {
        ...markWp2Dirty(current),
        bankRows: [...current.bankRows, ...rows],
      }
    })
    setPastePreview([])
    setPasteText('')
  }

  const verifyWp2 = () => {
    if (!canVerifyWp2) return
    onSessionChange((current) => ({
      ...current,
      wp2VerifiedAt: new Date().toISOString(),
      journalVoucherReady: false,
    }))
    onStepChange('adjusting')
  }

  return (
    <>
      <section className="manual-entry-panel">
        <div className="manual-entry-copy">
          <span>WP2 Bank Review</span>
          <strong>Review the bank rows imported from Intake first.</strong>
          <p>Add or paste bank rows only when Intake missed something, or when BK needs to correct a statement line manually.</p>
        </div>
        <div className="manual-entry-actions">
          <button
            className="secondary-button"
            onClick={() =>
              downloadCsv('MacroByte_WP2_Bank_Template.csv', [
                ['Date', 'Bank Description', 'Reference', 'Money In', 'Money Out', 'Notes'],
                ['03 Jan', 'Sample Customer IBG', 'INV-TEST-001', '1000', '', 'Sanitised bank row'],
              ])
            }
            type="button"
          >
            Download WP2 Template
          </button>
          <button className="secondary-button" onClick={() => setModal({ type: 'add-bank-row' })} type="button">
            Add Bank Row
          </button>
          <button
            className="secondary-button"
            disabled={!pasteText.trim()}
            onClick={() => setPastePreview(parseWp2Paste(pasteText))}
            type="button"
          >
            Preview Paste
          </button>
        </div>
      </section>

      <section className="manual-entry-panel">
        <div className="manual-entry-copy">
          <span>Verification Setup</span>
          <strong>Confirm the two balances before signing off WP2.</strong>
          <p>Use the closing balance from the bank statement and the book balance before any WP2-only entries.</p>
        </div>
        <div className="manual-form-grid wp2-balance-grid">
          <label>
            <span>Bank statement closing balance</span>
            <input
              min="0"
              step="0.01"
              type="number"
              value={session.wp2BankClosingBalance ?? ''}
              onChange={(event) =>
                onSessionChange((current) => ({
                  ...markWp2Dirty(current),
                  wp2BankClosingBalance:
                    event.target.value === '' ? null : Number(event.target.value),
                }))
              }
            />
          </label>
          <label>
            <span>Book balance before WP2-only entries</span>
            <input
              min="0"
              step="0.01"
              type="number"
              value={session.wp2BookBalanceBeforeBankOnly ?? ''}
              onChange={(event) =>
                onSessionChange((current) => ({
                  ...markWp2Dirty(current),
                  wp2BookBalanceBeforeBankOnly:
                    event.target.value === '' ? null : Number(event.target.value),
                }))
              }
            />
          </label>
        </div>
      </section>

      <section className="paste-panel">
        <label>
          <span>Paste Bank Statement Rows</span>
          <small>Expected columns: Date, Bank Description, Reference, Money In, Money Out, Notes.</small>
          <textarea
            placeholder="Date&#9;Bank Description&#9;Reference&#9;Money In&#9;Money Out&#9;Notes"
            rows={4}
            value={pasteText}
            onChange={(event) => setPasteText(event.target.value)}
          />
        </label>
        {pastePreview.length ? (
          <div className="paste-preview">
            <div className="paste-preview-head">
              <strong>{pastePreview.length} row(s) ready to import</strong>
              <button className="primary-button" onClick={importPreviewRows} type="button">
                Import Preview Rows
              </button>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Bank Description</th>
                    <th>Reference</th>
                    <th className="right">Money In</th>
                    <th className="right">Money Out</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {pastePreview.map((row, index) => (
                    <tr key={`${row.reference}-${index}`}>
                      <td>{row.date}</td>
                      <td>{row.description}</td>
                      <td className="mono">{row.reference}</td>
                      <td className="right amount-in">{row.moneyIn ? formatMoney(row.moneyIn) : '-'}</td>
                      <td className="right amount-out">{row.moneyOut ? `(${formatMoney(row.moneyOut)})` : '-'}</td>
                      <td>{row.notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </section>

      <div className="wp1-summary-grid">
        <SummaryCard
          isActive={rowFilter === null}
          label="Bank Rows"
          value={summary.rows.toString()}
          onClick={() => setRowFilter(null)}
        />
        <SummaryCard
          isActive={rowFilter === 'Matched'}
          label="Matched"
          tone="green"
          value={summary.matched.toString()}
          onClick={() => setRowFilter(rowFilter === 'Matched' ? null : 'Matched')}
        />
        <SummaryCard
          isActive={rowFilter === 'Match Multiple'}
          label="Match Multiple"
          tone="blue"
          value={summary.matchMultiple.toString()}
          onClick={() => setRowFilter(rowFilter === 'Match Multiple' ? null : 'Match Multiple')}
        />
        <SummaryCard
          isActive={rowFilter === 'Proposed Match'}
          label="Proposed Match"
          tone="teal"
          value={summary.proposedMatch.toString()}
          onClick={() => setRowFilter(rowFilter === 'Proposed Match' ? null : 'Proposed Match')}
        />
        <SummaryCard
          isActive={rowFilter === 'New'}
          label="New"
          tone="orange"
          value={summary.newRows.toString()}
          onClick={() => setRowFilter(rowFilter === 'New' ? null : 'New')}
        />
        <SummaryCard
          isActive={rowFilter === 'Outstanding / Timing Item'}
          label="Timing Items"
          tone="purple"
          value={summary.timingItems.toString()}
          onClick={() => setRowFilter(rowFilter === 'Outstanding / Timing Item' ? null : 'Outstanding / Timing Item')}
        />
        <SummaryCard
          isActive={rowFilter === 'Needs Review'}
          label="Needs Review"
          tone="red"
          value={summary.needsReview.toString()}
          onClick={() => setRowFilter(rowFilter === 'Needs Review' ? null : 'Needs Review')}
        />
      </div>

      {session.wp2VerifiedAt ? (
        <section className="intake-queue-callout ready">
          <strong>WP2 is verified.</strong>
          <p>Verified at {new Date(session.wp2VerifiedAt).toLocaleString('en-MY')}. Continue to Adjusting Entries unless the bank rows change again.</p>
        </section>
      ) : null}
      {!hasConfirmedBalances && session.bankRows.length > 0 ? (
        <section className="intake-queue-callout warning">
          <strong>WP2 still needs the two balance inputs.</strong>
          <p>Enter the statement closing balance and the book balance before the verification button can be trusted.</p>
        </section>
      ) : null}
      {unresolvedRowCount > 0 ? (
        <section className="intake-queue-callout warning">
          <strong>Resolve the remaining bank exceptions before sign-off.</strong>
          <p>{unresolvedRowCount} bank row{unresolvedRowCount === 1 ? '' : 's'} still need matching, Bank+, or timing-item handling.</p>
        </section>
      ) : null}

      <WorkpaperFrame
        period={session.client.period}
        subtitle={`${session.client.bankAccount} - verify against WP1 documents already posted`}
        title="Bank Verification Sheet - WP 2"
        footer={
          <>
            <div className="metric">
              <span>Bank+ Lines</span>
              <strong>{bankPlusLines.length}</strong>
            </div>
            <div className="metric">
              <span>Recon Difference</span>
              <strong
                className={
                  hasConfirmedBalances && reconciliation.difference !== null && Math.abs(reconciliation.difference) < 0.01
                    ? 'metric-ok'
                    : 'metric-alert'
                }
              >
                RM {formatMoney(Math.abs(reconciliation.difference ?? 0))}
              </strong>
            </div>
            <button
              className="primary-button"
              disabled={!canVerifyWp2}
              onClick={verifyWp2}
              title={
                canVerifyWp2
                  ? 'Mark WP2 verified and continue to Adjusting Entries.'
                  : 'WP2 needs resolved bank rows, confirmed balances, and RM 0.00 difference before sign-off.'
              }
              type="button"
            >
              {session.wp2VerifiedAt ? 'WP2 Verified' : 'Verify WP2'}
            </button>
          </>
        }
      >
        {rowFilter ? (
          <div className="wp2-filter-bar">
            <span>Showing <strong>{filteredRows.length}</strong> of {summary.rows} rows — {rowFilter}</span>
            <button className="text-button" onClick={() => setRowFilter(null)} type="button">Clear filter</button>
          </div>
        ) : null}
        <div className="table-scroll">
          <table className="data-table wp2-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Date</th>
                <th>Bank Description</th>
                <th>Reference</th>
                <th className="right">Money In</th>
                <th className="right">Money Out</th>
                <th>Suggested Match</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row) => {
                const suggested = suggestedDocumentsForRow(session, row)
                const canTreatAsTiming =
                  row.matchedTo === 'Books only' ||
                  row.description.toLowerCase().includes('cheque') ||
                  row.description.toLowerCase().includes('deposit')
                const bankOnlySuggestion = bankOnlySuggestionForRow(row)
                const fallbackText =
                  row.matchedTo ||
                  (row.status === 'New'
                    ? bankOnlySuggestion
                      ? `Likely Bank+ - ${bankOnlySuggestion.accountLabel}`
                      : 'No source document'
                    : 'Review required')
                return (
                  <tr className={`wp2-row status-row-${statusKey(row.status)}`} key={row.id}>
                    <td className="muted">{row.id}</td>
                    <td>{row.date}</td>
                    <td>
                      <strong>{row.description}</strong>
                      <small>{row.remarks}</small>
                    </td>
                    <td className="mono">{row.reference}</td>
                    <td className="right amount-in">{amountIn(row) ? formatMoney(amountIn(row)) : '-'}</td>
                    <td className="right amount-out">
                      {amountOut(row) ? `(${formatMoney(amountOut(row))})` : '-'}
                    </td>
                    <td className="mono suggested-match-cell">
                      {suggested.length ? (
                        suggested.slice(0, 2).map((document, index) => (
                          <span key={document.id}>
                            {index > 0 ? ' + ' : ''}
                            <button
                              className="suggested-match-link"
                              onClick={() => onNavigateToDocument(document.id)}
                              title={`${document.docRef} — ${document.party} (RM ${formatMoney(document.amount)})`}
                              type="button"
                            >
                              {document.party} — RM {formatMoney(document.amount)}
                            </button>
                          </span>
                        ))
                      ) : (
                        fallbackText
                      )}
                    </td>
                    <td>
                      <span className={statusClass(row.status)}>{row.status}</span>
                    </td>
                    <td>
                      <div className="action-group wp2-actions">
                        {row.status === 'Match Multiple' ? (
                          <button
                            className="text-button multi-action"
                            onClick={() => setModal({ type: 'match-multiple', bankRow: row })}
                            type="button"
                          >
                            Match Multiple
                          </button>
                        ) : null}
                        {row.status === 'New' ? (
                          <button
                            className="text-button split-action"
                            onClick={() => setModal({ type: 'new-entry', bankRow: row })}
                            type="button"
                          >
                            New Entry
                          </button>
                        ) : null}
                        {row.status === 'Proposed Match' ? (
                          <>
                            <button
                              className="text-button confirm-action"
                              disabled={!suggested[0] || suggested[0].status === 'Pending Review'}
                              onClick={() => markSingleMatched(row)}
                              type="button"
                            >
                              Confirm Match
                            </button>
                            <button
                              className="text-button split-action"
                              onClick={() => setModal({ type: 'new-entry', bankRow: row })}
                              type="button"
                            >
                              New Entry
                            </button>
                          </>
                        ) : null}
                        {row.status === 'Needs Review' ? (
                          <>
                            <button
                              className="text-button"
                              disabled={!suggested[0] || suggested[0].status === 'Pending Review'}
                              onClick={() => markSingleMatched(row)}
                              type="button"
                            >
                              Mark Matched
                            </button>
                            <button
                              className="text-button split-action"
                              onClick={() => setModal({ type: 'new-entry', bankRow: row })}
                              type="button"
                            >
                              New Entry
                            </button>
                            {canTreatAsTiming ? (
                              <button
                                className="text-button reclass-action"
                                onClick={() => setModal({ type: 'timing-item', bankRow: row })}
                                type="button"
                              >
                                Timing Item
                              </button>
                            ) : null}
                          </>
                        ) : null}
                        {row.status === 'Matched' || row.status === 'Outstanding / Timing Item' ? (
                          <span className="verified-text">Verified</span>
                        ) : null}
                        <button className="text-button" onClick={() => setModal({ type: 'edit-bank-row', bankRow: row })} type="button">
                          Edit
                        </button>
                        <button className="text-button" onClick={() => deleteBankRow(row.id)} type="button">
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <ReconciliationPanel reconciliation={reconciliation} session={session} />
      </WorkpaperFrame>

      {modal?.type === 'add-bank-row' ? (
        <BankRowModal
          onClose={() => setModal(null)}
          onSave={(form) => {
            onSessionChange((current) => ({
              ...markWp2Dirty(current),
              bankRows: [...current.bankRows, bankRowFromForm(form, nextBankRowId(current.bankRows))],
            }))
            setModal(null)
          }}
        />
      ) : null}

      {modal?.type === 'edit-bank-row' ? (
        <BankRowModal
          bankRow={modal.bankRow}
          onClose={() => setModal(null)}
          onSave={(form) => {
            onSessionChange((current) => ({
              ...markWp2Dirty(current),
              bankRows: current.bankRows.map((row) =>
                row.id === modal.bankRow.id
                  ? { ...bankRowFromForm(form, row.id), status: row.status, matchedTo: row.matchedTo }
                  : row,
              ),
            }))
            setModal(null)
          }}
        />
      ) : null}

      {modal?.type === 'match-multiple' ? (
        <MatchMultipleModal
          bankRow={modal.bankRow}
          session={session}
          onClose={() => setModal(null)}
          onConfirm={(documentIds) => {
            const documents = documentIds
              .map((id) => session.documents.find((document) => document.id === id))
              .filter((document): document is SourceDocument => Boolean(document))
            onSessionChange((current) => ({
              ...markWp2Dirty(current),
              bankMatches: [
                ...current.bankMatches.filter((match) => match.bankRowId !== modal.bankRow.id),
                {
                  bankRowId: modal.bankRow.id,
                  documentIds,
                  matchType: 'Multiple',
                  confirmedAt: new Date().toISOString(),
                },
              ],
              bankRows: current.bankRows.map((row) =>
                row.id === modal.bankRow.id
                  ? {
                      ...row,
                      status: 'Matched',
                      matchedTo: documents.map((document) => document.docRef).join(' + '),
                      remarks: `${documents.length} documents linked`,
                    }
                  : row,
              ),
            }))
            setModal(null)
          }}
        />
      ) : null}

      {modal?.type === 'new-entry' ? (
        <NewEntryModal
          bankRow={modal.bankRow}
          existingEntry={session.bankOnlyEntries.find((entry) => entry.bankRowId === modal.bankRow.id)}
          onClose={() => setModal(null)}
          onConfirm={(entry) => {
            onSessionChange((current) => ({
              ...markWp2Dirty(current),
              bankOnlyEntries: [
                ...current.bankOnlyEntries.filter((item) => item.bankRowId !== entry.bankRowId),
                entry,
              ],
              bankRows: current.bankRows.map((row) =>
                row.id === entry.bankRowId
                  ? {
                      ...row,
                      status: 'Matched',
                      matchedTo: `${entry.accountCode} - ${entry.accountName}`,
                      remarks: 'Bank+ entry posted',
                    }
                  : row,
              ),
            }))
            setModal(null)
          }}
        />
      ) : null}

      {modal?.type === 'timing-item' ? (
        <TimingItemModal
          bankRow={modal.bankRow}
          existingItem={session.timingItems.find((item) => item.bankRowId === modal.bankRow.id)}
          onClose={() => setModal(null)}
          onConfirm={(timingItem) => {
            onSessionChange((current) => ({
              ...markWp2Dirty(current),
              timingItems: [
                ...current.timingItems.filter((item) => item.bankRowId !== timingItem.bankRowId),
                timingItem,
              ],
              bankRows: current.bankRows.map((row) =>
                row.id === timingItem.bankRowId
                  ? {
                      ...row,
                      status: 'Outstanding / Timing Item',
                      matchedTo: timingItem.timingType,
                      remarks: timingItem.note,
                    }
                  : row,
              ),
            }))
            setModal(null)
          }}
        />
      ) : null}
    </>
  )
}

function SummaryCard({
  label,
  value,
  tone = 'neutral',
  onClick,
  isActive,
}: {
  label: string
  value: string
  tone?: 'neutral' | 'green' | 'orange' | 'purple' | 'red' | 'blue' | 'teal'
  onClick?: () => void
  isActive?: boolean
}) {
  const cls = [
    'summary-card',
    `tone-${tone}`,
    onClick ? 'summary-card-button' : '',
    isActive ? 'active' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <article className={cls} tabIndex={onClick ? 0 : undefined} onClick={onClick}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  )
}

function BankRowModal({
  bankRow,
  onClose,
  onSave,
}: {
  bankRow?: BankRow
  onClose: () => void
  onSave: (form: BankRowFormState) => void
}) {
  const [form, setForm] = useState<BankRowFormState>(bankFormFromRow(bankRow))
  const canSave = Boolean(
    form.date.trim() &&
      form.description.trim() &&
      form.reference.trim() &&
      (Number(form.moneyIn || 0) > 0 || Number(form.moneyOut || 0) > 0) &&
      !(Number(form.moneyIn || 0) > 0 && Number(form.moneyOut || 0) > 0),
  )

  return (
    <ModalFrame
      eyebrow="Manual WP2 entry"
      onClose={onClose}
      title={bankRow ? 'Edit Bank Row' : 'Add Bank Row'}
    >
      <div className="manual-form-grid">
        <label>
          <span>Date</span>
          <input value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} />
        </label>
        <label>
          <span>Bank Description</span>
          <input
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
          />
        </label>
        <label>
          <span>Reference</span>
          <input value={form.reference} onChange={(event) => setForm({ ...form, reference: event.target.value })} />
        </label>
        <label>
          <span>Money In</span>
          <input
            min="0"
            step="0.01"
            type="number"
            value={form.moneyIn}
            onChange={(event) => setForm({ ...form, moneyIn: Number(event.target.value), moneyOut: 0 })}
          />
        </label>
        <label>
          <span>Money Out</span>
          <input
            min="0"
            step="0.01"
            type="number"
            value={form.moneyOut}
            onChange={(event) => setForm({ ...form, moneyOut: Number(event.target.value), moneyIn: 0 })}
          />
        </label>
        <label className="wide-field">
          <span>Notes</span>
          <input value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
        </label>
      </div>

      <div className={canSave ? 'balance-box ok' : 'balance-box error'}>
        <span>Bank row check</span>
        <strong>{canSave ? 'Ready to save' : 'Enter either money in or money out'}</strong>
      </div>

      <div className="modal-actions">
        <button className="secondary-button" onClick={onClose} type="button">
          Cancel
        </button>
        <button className="primary-button" disabled={!canSave} onClick={() => onSave(form)} type="button">
          Save Bank Row
        </button>
      </div>
    </ModalFrame>
  )
}

function ReconciliationPanel({
  reconciliation,
  session,
}: {
  reconciliation: {
    bankClosingBalance: number | null
    bookBalanceBeforeBankOnly: number | null
    outstandingCheques: number
    depositsInTransit: number
    bankOnlyAdjustment: number
    adjustedBank: number | null
    adjustedBook: number | null
    difference: number | null
  }
  session: SampleSession
}) {
  const isBalanced =
    reconciliation.bankClosingBalance !== null &&
    reconciliation.bookBalanceBeforeBankOnly !== null &&
    reconciliation.difference !== null &&
    Math.abs(reconciliation.difference) < 0.01

  return (
    <section className="wp2-recon-panel">
      <div className="recon-card">
        <h3>Bank Statement</h3>
        <ReconLine label="Closing balance" value={reconciliation.bankClosingBalance} />
        <ReconLine isNegative label="Less: outstanding cheques" value={reconciliation.outstandingCheques} />
        <ReconLine label="Add: deposits in transit" value={reconciliation.depositsInTransit} />
        <ReconLine isTotal label="Adjusted bank balance" value={reconciliation.adjustedBank} />
      </div>
      <div className="recon-card">
        <h3>Book Balance</h3>
        <ReconLine label="Before bank-only entries" value={reconciliation.bookBalanceBeforeBankOnly} />
        <ReconLine label="Add / less: WP2 bank-only entries" value={reconciliation.bankOnlyAdjustment} />
        <ReconLine isTotal label="Adjusted book balance" value={reconciliation.adjustedBook} />
        <div className={isBalanced ? 'recon-difference ok' : 'recon-difference alert'}>
          <span>Difference</span>
          <strong>{reconciliation.difference === null ? 'Not set' : `RM ${formatMoney(Math.abs(reconciliation.difference))}`}</strong>
        </div>
      </div>
      <div className="recon-card timing-card">
        <h3>Timing Items</h3>
        {session.timingItems.length ? (
          session.timingItems.map((item) => (
            <div className="timing-note" key={item.bankRowId}>
              <strong>{item.timingType}</strong>
              <span>RM {formatMoney(item.amount)}</span>
              <p>{item.note}</p>
            </div>
          ))
        ) : (
          <p>No timing items confirmed yet.</p>
        )}
      </div>
    </section>
  )
}

function ReconLine({
  label,
  value,
  isNegative = false,
  isTotal = false,
}: {
  label: string
  value: number | null
  isNegative?: boolean
  isTotal?: boolean
}) {
  return (
    <div className={isTotal ? 'recon-line total' : 'recon-line'}>
      <span>{label}</span>
      <strong className={isNegative && value ? 'amount-out' : ''}>
        {value === null ? 'Not set' : isNegative && value ? `(${formatMoney(value)})` : formatMoney(value)}
      </strong>
    </div>
  )
}

function MatchMultipleModal({
  bankRow,
  session,
  onClose,
  onConfirm,
}: {
  bankRow: BankRow
  session: SampleSession
  onClose: () => void
  onConfirm: (documentIds: string[]) => void
}) {
  const matchedDocumentIds = new Set(session.bankMatches.flatMap((match) => match.documentIds))
  const availableDocuments = session.documents.filter((document) => !matchedDocumentIds.has(document.id))
  const suggestedIds = bankRow.suggestedDocumentIds ?? []
  const [selectedIds, setSelectedIds] = useState<string[]>(suggestedIds)
  const selectedDocuments = selectedIds
    .map((id) => session.documents.find((document) => document.id === id))
    .filter((document): document is SourceDocument => Boolean(document))
  const selectedTotal = selectedDocuments.reduce((sum, document) => sum + document.amount, 0)
  const difference = Number((bankRow.amount - selectedTotal).toFixed(2))
  const isBalanced = Math.abs(difference) < 0.01

  const toggleDocument = (documentId: string) => {
    setSelectedIds((current) =>
      current.includes(documentId)
        ? current.filter((id) => id !== documentId)
        : [...current, documentId],
    )
  }

  return (
    <ModalFrame eyebrow={`Row ${bankRow.id} - ${bankRow.reference}`} onClose={onClose} title="Match Multiple Documents">
      <div className="modal-source-bar">
        <div>
          <span>Bank row</span>
          <strong>{bankRow.description}</strong>
        </div>
        <div>
          <span>Bank amount</span>
          <strong>RM {formatMoney(bankRow.amount)}</strong>
        </div>
        <div>
          <span>Direction</span>
          <strong>{bankRow.direction}</strong>
        </div>
      </div>

      <div className="match-doc-list">
        {availableDocuments.map((document) => (
          <label className="match-doc-option" key={document.id}>
            <input
              checked={selectedIds.includes(document.id)}
              onChange={() => toggleDocument(document.id)}
              type="checkbox"
            />
            <span>
              <strong>{documentLabel(document)}</strong>
              <small>
                {document.date} - {document.docType} - RM {formatMoney(document.amount)}
              </small>
            </span>
          </label>
        ))}
      </div>

      <div className={isBalanced ? 'balance-box ok' : 'balance-box error'}>
        <span>Selected total RM {formatMoney(selectedTotal)}</span>
        <strong>
          {isBalanced ? 'Balanced' : `Difference RM ${formatMoney(Math.abs(difference))}`}
        </strong>
      </div>

      <div className="modal-actions">
        <button className="secondary-button" onClick={onClose} type="button">
          Cancel
        </button>
        <button
          className="primary-button"
          disabled={!isBalanced}
          onClick={() => onConfirm(selectedIds)}
          type="button"
        >
          Confirm Match
        </button>
      </div>
    </ModalFrame>
  )
}

function NewEntryModal({
  bankRow,
  existingEntry,
  onClose,
  onConfirm,
}: {
  bankRow: BankRow
  existingEntry?: BankOnlyEntry
  onClose: () => void
  onConfirm: (entry: BankOnlyEntry) => void
}) {
  const suggestedBankOnly = bankOnlySuggestionForRow(bankRow)
  const [selectedCode, setSelectedCode] = useState(existingEntry?.accountCode ?? suggestedBankOnly?.accountCode ?? '')
  const [description, setDescription] = useState(existingEntry?.description ?? bankRow.description)
  const selectedAccount = selectedCode ? findAccount(selectedCode) : undefined
  const canConfirm = Boolean(selectedAccount && description.trim())

  return (
    <ModalFrame eyebrow={`Row ${bankRow.id} - ${bankRow.reference}`} onClose={onClose} title="Add New Bank Entry">
      <div className="modal-source-bar">
        <div>
          <span>Bank row</span>
          <strong>{bankRow.description}</strong>
        </div>
        <div>
          <span>Amount</span>
          <strong>RM {formatMoney(bankRow.amount)}</strong>
        </div>
        <div>
          <span>Reason</span>
          <strong>{suggestedBankOnly?.reason || 'No source document'}</strong>
        </div>
      </div>

      <div className="new-entry-grid">
        <label>
          <span>GL account</span>
          <select value={selectedCode} onChange={(event) => setSelectedCode(event.target.value)}>
            <option value="">Select account</option>
            {bankOnlyAccounts.map((account) => (
              <option key={account.code} value={account.code}>
                {account.code} - {account.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Description</span>
          <input value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
      </div>

      <div className="gl-result">
        <span>Journal source</span>
        <strong>Bank+</strong>
      </div>

      <div className="modal-actions">
        <button className="secondary-button" onClick={onClose} type="button">
          Cancel
        </button>
        <button
          className="primary-button"
          disabled={!canConfirm}
          onClick={() =>
            selectedAccount &&
            onConfirm({
              bankRowId: bankRow.id,
              accountCode: selectedAccount.code,
              accountName: selectedAccount.name,
              description: description.trim(),
              confirmedAt: new Date().toISOString(),
            })
          }
          type="button"
        >
          Confirm Entry
        </button>
      </div>
    </ModalFrame>
  )
}

function TimingItemModal({
  bankRow,
  existingItem,
  onClose,
  onConfirm,
}: {
  bankRow: BankRow
  existingItem?: TimingItem
  onClose: () => void
  onConfirm: (item: TimingItem) => void
}) {
  const [timingType, setTimingType] = useState<TimingItemType>(
    existingItem?.timingType ?? 'Outstanding cheque',
  )
  const [note, setNote] = useState(existingItem?.note ?? '')
  const canConfirm = note.trim().length > 0

  return (
    <ModalFrame eyebrow={`Row ${bankRow.id} - ${bankRow.reference}`} onClose={onClose} title="Timing Item">
      <div className="modal-source-bar">
        <div>
          <span>Item</span>
          <strong>{bankRow.description}</strong>
        </div>
        <div>
          <span>Amount</span>
          <strong>RM {formatMoney(bankRow.amount)}</strong>
        </div>
        <div>
          <span>Type</span>
          <select value={timingType} onChange={(event) => setTimingType(event.target.value as TimingItemType)}>
            <option>Outstanding cheque</option>
            <option>Deposit in transit</option>
          </select>
        </div>
      </div>

      <label className="single-field">
        <span>Carry-forward note</span>
        <input
          placeholder="Expected to clear in February bank statement"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>

      <div className={canConfirm ? 'balance-box ok' : 'balance-box error'}>
        <span>Next session reminder</span>
        <strong>{canConfirm ? 'Ready' : 'Carry-forward note required'}</strong>
      </div>

      <div className="modal-actions">
        <button className="secondary-button" onClick={onClose} type="button">
          Cancel
        </button>
        <button
          className="primary-button"
          disabled={!canConfirm}
          onClick={() =>
            onConfirm({
              bankRowId: bankRow.id,
              timingType,
              amount: bankRow.amount,
              direction: bankRow.direction,
              note: note.trim(),
              confirmedAt: new Date().toISOString(),
            })
          }
          type="button"
        >
          Confirm Timing Item
        </button>
      </div>
    </ModalFrame>
  )
}

function ModalFrame({
  eyebrow,
  title,
  children,
  onClose,
}: {
  eyebrow: string
  title: string
  children: ReactNode
  onClose: () => void
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section aria-modal="true" className="modal-panel" role="dialog">
        <header className="modal-head">
          <div>
            <h3>{title}</h3>
            <p>{eyebrow}</p>
          </div>
          <button aria-label="Close modal" onClick={onClose} type="button">
            x
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  )
}
