import { useMemo, useState } from 'react'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import { findAccount } from '../../data/accounts'
import { generateDraftJournalLinesFromBankEntries } from '../../state/journalBuilder'
import type {
  AccountOption,
  BankOnlyEntry,
  BankRow,
  SampleSession,
  SourceDocument,
  TimingItem,
  TimingItemType,
} from '../../types/session'
import { WorkpaperFrame } from '../layout/WorkpaperFrame'

interface WP2BankVerificationProps {
  session: SampleSession
  onSessionChange: Dispatch<SetStateAction<SampleSession>>
}

type ModalState =
  | { type: 'match-multiple'; bankRow: BankRow }
  | { type: 'new-entry'; bankRow: BankRow }
  | { type: 'timing-item'; bankRow: BankRow }
  | null

const BANK_CLOSING_BALANCE = 48320
const BOOK_BALANCE_BEFORE_BANK_ONLY = 42595

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

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

const dateDay = (date: string) => Number(date.slice(0, 2))

const flowMatchesDirection = (document: SourceDocument, bankRow: BankRow) =>
  (document.flow === 'IN' && bankRow.direction === 'CR') ||
  (document.flow === 'OUT' && bankRow.direction === 'DR')

const scoreDocumentMatch = (document: SourceDocument, bankRow: BankRow) => {
  let score = 0
  if (!flowMatchesDirection(document, bankRow)) return score
  if (Math.abs(document.amount - bankRow.amount) < 0.01) score += 5
  if (bankRow.reference && normalize(document.docRef) === normalize(bankRow.reference)) score += 6
  if (Math.abs(dateDay(document.date) - dateDay(bankRow.date)) <= 3) score += 2

  const docWords = new Set(normalize(`${document.party} ${document.docRef}`).split(' ').filter(Boolean))
  const bankWords = normalize(`${bankRow.description} ${bankRow.reference}`).split(' ').filter(Boolean)
  score += bankWords.filter((word) => docWords.has(word)).length
  return score
}

const suggestedDocumentsForRow = (session: SampleSession, bankRow: BankRow) => {
  const explicit = bankRow.suggestedDocumentIds
    ?.map((id) => session.documents.find((document) => document.id === id))
    .filter((document): document is SourceDocument => Boolean(document))

  if (explicit?.length) return explicit

  return session.documents
    .map((document) => ({ document, score: scoreDocumentMatch(document, bankRow) }))
    .filter((item) => item.score >= 5)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.document)
}

const documentLabel = (document: SourceDocument) => `${document.docRef} - ${document.party}`

const amountIn = (row: BankRow) => (row.direction === 'CR' ? row.amount : 0)

const amountOut = (row: BankRow) => (row.direction === 'DR' ? row.amount : 0)

export function WP2BankVerification({ session, onSessionChange }: WP2BankVerificationProps) {
  const [modal, setModal] = useState<ModalState>(null)
  const bankPlusLines = useMemo(() => generateDraftJournalLinesFromBankEntries(session), [session])

  const reconciliation = useMemo(() => {
    const outstandingCheques = session.timingItems
      .filter((item) => item.timingType === 'Outstanding cheque')
      .reduce((sum, item) => sum + item.amount, 0)
    const depositsInTransit = session.timingItems
      .filter((item) => item.timingType === 'Deposit in transit')
      .reduce((sum, item) => sum + item.amount, 0)
    const bankOnlyAdjustment = session.bankOnlyEntries.reduce((sum, entry) => {
      const row = session.bankRows.find((bankRow) => bankRow.id === entry.bankRowId)
      return row ? sum + row.amount : sum
    }, 0)
    const adjustedBank = BANK_CLOSING_BALANCE - outstandingCheques + depositsInTransit
    const adjustedBook = BOOK_BALANCE_BEFORE_BANK_ONLY + bankOnlyAdjustment

    return {
      outstandingCheques,
      depositsInTransit,
      bankOnlyAdjustment,
      adjustedBank,
      adjustedBook,
      difference: Number((adjustedBank - adjustedBook).toFixed(2)),
    }
  }, [session.bankOnlyEntries, session.bankRows, session.timingItems])

  const summary = useMemo(
    () => ({
      rows: session.bankRows.length,
      matched: session.bankRows.filter((row) => row.status === 'Matched').length,
      matchMultiple: session.bankRows.filter((row) => row.status === 'Match Multiple').length,
      newRows: session.bankRows.filter((row) => row.status === 'New').length,
      timingItems: session.timingItems.length,
      needsReview: session.bankRows.filter((row) => row.status === 'Needs Review').length,
    }),
    [session.bankRows, session.timingItems.length],
  )

  const markSingleMatched = (bankRow: BankRow) => {
    const suggested = suggestedDocumentsForRow(session, bankRow)
    const firstMatch = suggested[0]
    if (!firstMatch || firstMatch.status === 'Pending Review') return

    onSessionChange((current) => ({
      ...current,
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

  return (
    <>
      <div className="wp1-summary-grid">
        <SummaryCard label="Bank Rows" value={summary.rows.toString()} />
        <SummaryCard label="Matched" tone="green" value={summary.matched.toString()} />
        <SummaryCard label="Match Multiple" tone="blue" value={summary.matchMultiple.toString()} />
        <SummaryCard label="New" tone="orange" value={summary.newRows.toString()} />
        <SummaryCard label="Timing Items" tone="purple" value={summary.timingItems.toString()} />
        <SummaryCard label="Needs Review" tone="red" value={summary.needsReview.toString()} />
      </div>

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
              <strong className={Math.abs(reconciliation.difference) < 0.01 ? 'metric-ok' : 'metric-alert'}>
                RM {formatMoney(Math.abs(reconciliation.difference))}
              </strong>
            </div>
            <button className="primary-button" disabled={Math.abs(reconciliation.difference) >= 0.01} type="button">
              Verified
            </button>
          </>
        }
      >
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
              {session.bankRows.map((row) => {
                const suggested = suggestedDocumentsForRow(session, row)
                const canTreatAsTiming =
                  row.matchedTo === 'Books only' ||
                  row.description.toLowerCase().includes('cheque') ||
                  row.description.toLowerCase().includes('deposit')
                const suggestedText =
                  row.status === 'New'
                    ? 'No source document'
                    : suggested.length
                      ? suggested.map((document) => document.docRef).join(' + ')
                      : row.matchedTo || 'Review required'
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
                    <td className="mono">{suggestedText}</td>
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
              ...current,
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
              ...current,
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
              ...current,
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
}: {
  label: string
  value: string
  tone?: 'neutral' | 'green' | 'orange' | 'purple' | 'red' | 'blue'
}) {
  return (
    <article className={`summary-card tone-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  )
}

function ReconciliationPanel({
  reconciliation,
  session,
}: {
  reconciliation: {
    outstandingCheques: number
    depositsInTransit: number
    bankOnlyAdjustment: number
    adjustedBank: number
    adjustedBook: number
    difference: number
  }
  session: SampleSession
}) {
  const isBalanced = Math.abs(reconciliation.difference) < 0.01

  return (
    <section className="wp2-recon-panel">
      <div className="recon-card">
        <h3>Bank Statement</h3>
        <ReconLine label="Closing balance" value={BANK_CLOSING_BALANCE} />
        <ReconLine isNegative label="Less: outstanding cheques" value={reconciliation.outstandingCheques} />
        <ReconLine label="Add: deposits in transit" value={reconciliation.depositsInTransit} />
        <ReconLine isTotal label="Adjusted bank balance" value={reconciliation.adjustedBank} />
      </div>
      <div className="recon-card">
        <h3>Book Balance</h3>
        <ReconLine label="Before bank-only entries" value={BOOK_BALANCE_BEFORE_BANK_ONLY} />
        <ReconLine label="Add / less: WP2 bank-only entries" value={reconciliation.bankOnlyAdjustment} />
        <ReconLine isTotal label="Adjusted book balance" value={reconciliation.adjustedBook} />
        <div className={isBalanced ? 'recon-difference ok' : 'recon-difference alert'}>
          <span>Difference</span>
          <strong>RM {formatMoney(Math.abs(reconciliation.difference))}</strong>
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
  value: number
  isNegative?: boolean
  isTotal?: boolean
}) {
  return (
    <div className={isTotal ? 'recon-line total' : 'recon-line'}>
      <span>{label}</span>
      <strong className={isNegative && value ? 'amount-out' : ''}>
        {isNegative && value ? `(${formatMoney(value)})` : formatMoney(value)}
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
                {document.date} · {document.docType} · RM {formatMoney(document.amount)}
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
  const [selectedCode, setSelectedCode] = useState(existingEntry?.accountCode ?? '')
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
          <strong>No source document</strong>
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
