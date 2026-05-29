import { useMemo, useState } from 'react'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import { accountOptions, accountsForDocumentType, findAccount, formatAccount } from '../../data/accounts'
import { generateDraftJournalLinesFromWP1 } from '../../state/journalBuilder'
import type {
  AccountOption,
  DirectorTransactionNature,
  DocumentType,
  EntryDirection,
  ReclassifyDecision,
  ReclassifyType,
  SampleSession,
  SourceDocument,
  SplitDecision,
  SplitLine,
  SplitType,
} from '../../types/session'
import { WorkpaperFrame } from '../layout/WorkpaperFrame'
import { downloadCsv } from '../../utils/downloadCsv'

interface WP1DocumentLedgerProps {
  session: SampleSession
  onSessionChange: Dispatch<SetStateAction<SampleSession>>
  onStepChange: (step: 'wp2') => void
}

type ModalState =
  | { type: 'split'; document: SourceDocument }
  | { type: 'reclassify'; document: SourceDocument }
  | { type: 'edit-gl'; document: SourceDocument }
  | { type: 'add-document' }
  | { type: 'edit-document'; document: SourceDocument }
  | null

type DocumentFormState = {
  date: string
  docRef: string
  party: string
  docType: DocumentType
  amount: number
  glAccount: string
  note: string
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

const statusKey = (status: string) =>
  status
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

const splitTypes: SplitType[] = ['Prepayment', 'Payroll', 'Loan repayment', 'Bulk payment']

const reclassifyTypes: ReclassifyType[] = ['Asset purchase', 'Director transaction']

const documentTypes: DocumentType[] = [
  'Sales Invoice',
  'Purchase Invoice',
  'Payment Voucher',
  'Receipt',
  'Payroll Summary',
  'Loan / HP Statement',
  'Merchant Statement',
  'Utility Bill',
]

const directorOptions: Array<{
  nature: DirectorTransactionNature
  account: AccountOption
  description: string
}> = [
  {
    nature: 'Loan to/from Director',
    account: findAccount('2800')!,
    description: 'Director funding or repayment posted to director loan.',
  },
  {
    nature: 'Capital Injection',
    account: findAccount('3100')!,
    description: 'Shareholder capital. Keep support with company records.',
  },
  {
    nature: 'Drawing',
    account: findAccount('3200')!,
    description: 'Director withdrawal or return of prior drawings.',
  },
]

const accountFromCode = (code: string) => findAccount(code) ?? accountOptions[0]

const makeLine = (
  id: string,
  accountCode: string,
  direction: EntryDirection,
  amount: number,
  description: string,
): SplitLine => {
  const account = accountFromCode(accountCode)
  return {
    id,
    accountCode: account.code,
    accountName: account.name,
    direction,
    amount,
    description,
  }
}

const defaultSplitType = (document: SourceDocument): SplitType => {
  if (document.splitType) return document.splitType
  if (document.docType === 'Payroll Summary') return 'Payroll'
  if (document.docType === 'Loan / HP Statement') return 'Loan repayment'
  return 'Prepayment'
}

const defaultSplitLines = (document: SourceDocument, splitType: SplitType): SplitLine[] => {
  if (splitType === 'Prepayment') {
    return [
      makeLine('line-1', '6380', 'DR', 500, 'Insurance expense - current month'),
      makeLine('line-2', '1120', 'DR', Math.max(document.amount - 500, 0), 'Prepaid balance'),
    ]
  }

  if (splitType === 'Payroll') {
    return [
      makeLine('line-1', '6100', 'DR', 9600, 'Gross salaries'),
      makeLine('line-2', '6110', 'DR', 1248, 'Employer EPF'),
      makeLine('line-3', '6120', 'DR', 176, 'Employer SOCSO'),
      makeLine('line-4', '6130', 'DR', 17, 'Employer EIS'),
      makeLine('line-5', '2400', 'CR', 1800, 'EPF payable'),
      makeLine('line-6', '2430', 'CR', 609, 'PCB payable'),
    ]
  }

  if (splitType === 'Loan repayment') {
    return [
      makeLine('line-1', '2700', 'DR', 1650, 'Principal repayment'),
      makeLine('line-2', '6600', 'DR', Math.max(document.amount - 1650, 0), 'Interest expense'),
    ]
  }

  return [
    makeLine('line-1', '5020', 'DR', 3200, 'Berjaya Fresh invoice INV-BF-881'),
    makeLine('line-2', '5020', 'DR', 3300, 'Berjaya Fresh invoice INV-BF-894'),
    makeLine('line-3', '5020', 'DR', Math.max(document.amount - 6500, 0), 'Berjaya Fresh invoice INV-BF-901'),
  ]
}

const flowForDocumentType = (docType: DocumentType) =>
  ['Sales Invoice', 'Receipt', 'Merchant Statement'].includes(docType) ? 'IN' : 'OUT'

const nextDocumentId = (documents: SourceDocument[]) => {
  const maxNumber = documents.reduce((max, document) => {
    const numeric = Number(document.id.replace(/\D/g, ''))
    return Number.isFinite(numeric) ? Math.max(max, numeric) : max
  }, 0)
  return String(maxNumber + 1).padStart(2, '0')
}

const formFromDocument = (document?: SourceDocument): DocumentFormState => ({
  date: document?.date ?? '',
  docRef: document?.docRef ?? '',
  party: document?.party ?? '',
  docType: document?.docType ?? 'Purchase Invoice',
  amount: document?.amount ?? 0,
  glAccount: document?.glAccount ?? '',
  note: document?.note ?? '',
})

const documentFromForm = (form: DocumentFormState, id: string): SourceDocument => ({
  id,
  date: form.date.trim(),
  docRef: form.docRef.trim(),
  party: form.party.trim(),
  docType: form.docType,
  amount: Number(form.amount || 0),
  flow: flowForDocumentType(form.docType),
  glAccount: form.glAccount.trim(),
  status: form.glAccount.trim() ? 'Posted' : 'Pending Review',
  note: form.note.trim() || undefined,
})

const parseAmount = (value: string) => Number(value.replace(/[(),RM\s]/gi, '').replace(/,/g, '')) || 0

const parseWp1Paste = (text: string): DocumentFormState[] =>
  text
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) => row.split('\t').map((cell) => cell.trim()))
    .filter((cells) => cells[0]?.toLowerCase() !== 'date')
    .map(([date = '', docRef = '', party = '', docType = 'Purchase Invoice', amount = '0', glAccount = '', note = '']) => ({
      date,
      docRef,
      party,
      docType: documentTypes.includes(docType as DocumentType) ? (docType as DocumentType) : 'Purchase Invoice',
      amount: parseAmount(amount),
      glAccount,
      note,
    }))

export function WP1DocumentLedger({ session, onSessionChange, onStepChange }: WP1DocumentLedgerProps) {
  const [modal, setModal] = useState<ModalState>(null)
  const [pasteText, setPasteText] = useState('')
  const [pastePreview, setPastePreview] = useState<DocumentFormState[]>([])
  const draftJournalLines = useMemo(() => generateDraftJournalLinesFromWP1(session), [session])
  const unresolvedWp1Rows = useMemo(
    () =>
      session.documents.filter(
        (document) =>
          ['Needs Split', 'Reclassify', 'Pending Review'].includes(document.status) || !document.glAccount,
      ),
    [session.documents],
  )

  const summary = useMemo(() => {
    const posted = session.documents.filter((document) =>
      ['Posted', 'Split Done', 'Reclassified'].includes(document.status),
    ).length
    return {
      totalDocuments: session.documents.length,
      posted,
      needsSplit: session.documents.filter((document) => document.status === 'Needs Split').length,
      reclassify: session.documents.filter((document) => document.status === 'Reclassify').length,
      revenue: session.documents
        .filter((document) => document.flow === 'IN')
        .reduce((sum, document) => sum + document.amount, 0),
      costs: session.documents
        .filter((document) => document.flow === 'OUT')
        .reduce((sum, document) => sum + document.amount, 0),
    }
  }, [session.documents])

  const updateDocument = (documentId: string, updater: (document: SourceDocument) => SourceDocument) => {
    onSessionChange((current) => ({
      ...current,
      documents: current.documents.map((document) =>
        document.id === documentId ? updater(document) : document,
      ),
    }))
  }

  const markAsPosted = (document: SourceDocument) => {
    if (document.status === 'Needs Split' || document.status === 'Reclassify') return

    updateDocument(document.id, (current) => ({
      ...current,
      status: current.glAccount ? 'Posted' : 'Pending Review',
      note: current.glAccount ? current.note : 'GL account required before posting.',
    }))
  }

  const deleteDocument = (documentId: string) => {
    if (!window.confirm('Delete this document row from the current session?')) return
    onSessionChange((current) => ({
      ...current,
      documents: current.documents.filter((document) => document.id !== documentId),
      splitDecisions: current.splitDecisions.filter((decision) => decision.documentId !== documentId),
      reclassifyDecisions: current.reclassifyDecisions.filter((decision) => decision.documentId !== documentId),
      bankMatches: current.bankMatches
        .map((match) => ({
          ...match,
          documentIds: match.documentIds.filter((id) => id !== documentId),
        }))
        .filter((match) => match.documentIds.length),
      journalVoucherReady: false,
    }))
  }

  const importPreviewRows = () => {
    onSessionChange((current) => {
      let counter = 0
      const rows = pastePreview.map((row) => {
        counter += 1
        return documentFromForm(row, `M${String(current.documents.length + counter).padStart(3, '0')}`)
      })
      return {
        ...current,
        documents: [...current.documents, ...rows],
        journalVoucherReady: false,
      }
    })
    setPastePreview([])
    setPasteText('')
  }

  return (
    <>
      <section className="manual-entry-panel">
        <div className="manual-entry-copy">
          <span>BK Test Session</span>
          <strong>Add your WP1 document rows here.</strong>
          <p>Use Add Document for one row, or paste rows copied from Excel and preview before importing.</p>
        </div>
        <div className="manual-entry-actions">
          <button
            className="secondary-button"
            onClick={() =>
              downloadCsv('MacroByte_WP1_Document_Template.csv', [
                ['Date', 'Document Ref', 'Vendor / Customer', 'Document Type', 'Amount', 'GL Account', 'Notes'],
                ['03 Jan', 'INV-TEST-001', 'Sample Customer', 'Sales Invoice', '1000', '4100 - Sales Revenue', 'Sanitised test row'],
              ])
            }
            type="button"
          >
            Download WP1 Template
          </button>
          <button className="secondary-button" onClick={() => setModal({ type: 'add-document' })} type="button">
            Add Document
          </button>
          <button
            className="secondary-button"
            onClick={() => {
              const rows = parseWp1Paste(pasteText)
              setPastePreview(rows)
            }}
            disabled={!pasteText.trim()}
            type="button"
          >
            Preview Paste
          </button>
        </div>
      </section>

      <section className="paste-panel">
        <label>
          <span>Paste from Excel</span>
          <small>Expected columns: Date, Document Ref, Vendor / Customer, Document Type, Amount, GL Account, Notes.</small>
          <textarea
            placeholder="Date&#9;Document Ref&#9;Vendor / Customer&#9;Document Type&#9;Amount&#9;GL Account&#9;Notes"
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
                    <th>Document Ref</th>
                    <th>Vendor / Customer</th>
                    <th>Document Type</th>
                    <th className="right">Amount</th>
                    <th>GL Account</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {pastePreview.map((row, index) => (
                    <tr key={`${row.docRef}-${index}`}>
                      <td>{row.date}</td>
                      <td className="mono">{row.docRef}</td>
                      <td>{row.party}</td>
                      <td>{row.docType}</td>
                      <td className="right">RM {formatMoney(row.amount)}</td>
                      <td className="mono">{row.glAccount || 'Select GL later'}</td>
                      <td>{row.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </section>

      <div className="wp1-summary-grid">
        <SummaryCard label="Total Documents" value={summary.totalDocuments.toString()} />
        <SummaryCard label="Posted" tone="green" value={summary.posted.toString()} />
        <SummaryCard label="Needs Split" tone="orange" value={summary.needsSplit.toString()} />
        <SummaryCard label="Reclassify" tone="purple" value={summary.reclassify.toString()} />
        <SummaryCard label="Total Revenue" tone="green" value={`RM ${formatMoney(summary.revenue)}`} />
        <SummaryCard label="Total Costs / Expenses" tone="red" value={`RM ${formatMoney(summary.costs)}`} />
      </div>

      <WorkpaperFrame
        period={session.client.period}
        subtitle={`${session.client.entityName} - source documents posted before bank verification`}
        title="Document Posting Ledger - WP 1"
        footer={
          <>
            <div className="metric">
              <span>Posting Lines</span>
              <strong>{draftJournalLines.length}</strong>
            </div>
            <div className="metric">
              <span>Split Decisions</span>
              <strong>{session.splitDecisions.length}</strong>
            </div>
            <div className="metric">
              <span>Reclassifications</span>
              <strong>{session.reclassifyDecisions.length}</strong>
            </div>
            <button
              className="primary-button"
              disabled={unresolvedWp1Rows.length > 0}
              onClick={() => onStepChange('wp2')}
              title={
                unresolvedWp1Rows.length
                  ? 'Complete split, reclassify, and GL account items before moving to WP2.'
                  : 'Go to WP2 Bank Verification.'
              }
              type="button"
            >
              {unresolvedWp1Rows.length ? `Fix ${unresolvedWp1Rows.length} WP1 Item(s)` : 'Ready for WP2'}
            </button>
          </>
        }
      >
        <div className="table-scroll">
          <table className="data-table wp1-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Date</th>
                <th>Document Ref</th>
                <th>Vendor / Customer</th>
                <th>Document Type</th>
                <th className="right">Amount</th>
                <th>GL Account</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {session.documents.map((document) => {
                const canMarkPosted =
                  document.status !== 'Needs Split' && document.status !== 'Reclassify' && document.status !== 'Split Done' && document.status !== 'Reclassified'
                return (
                  <tr className={`wp1-row status-row-${statusKey(document.status)}`} key={document.id}>
                    <td className="muted">{document.id}</td>
                    <td>{document.date}</td>
                    <td className="mono">{document.docRef}</td>
                    <td>
                      <strong>{document.party}</strong>
                      {document.note ? <small>{document.note}</small> : null}
                    </td>
                    <td>
                      <span className="doc-type-chip">{document.docType}</span>
                    </td>
                    <td className={document.flow === 'IN' ? 'right amount-in' : 'right amount-out'}>
                      {document.flow === 'OUT'
                        ? `(${formatMoney(document.amount)})`
                        : formatMoney(document.amount)}
                    </td>
                    <td className={document.glAccount ? 'mono' : 'missing-gl'}>
                      {document.glAccount || 'Select GL'}
                    </td>
                    <td>
                      <span className={statusClass(document.status)}>{document.status}</span>
                    </td>
                    <td>
                      <div className="action-group">
                        {(document.status === 'Needs Split' || document.status === 'Split Done') && (
                          <button className="text-button split-action" onClick={() => setModal({ type: 'split', document })} type="button">
                            Split
                          </button>
                        )}
                        {(document.status === 'Reclassify' || document.status === 'Reclassified') && (
                          <button className="text-button reclass-action" onClick={() => setModal({ type: 'reclassify', document })} type="button">
                            Reclassify
                          </button>
                        )}
                        <button
                          className="text-button"
                          disabled={!canMarkPosted}
                          onClick={() => markAsPosted(document)}
                          title={
                            document.status === 'Needs Split'
                              ? 'Complete split before posting.'
                              : document.status === 'Reclassify'
                                ? 'Complete reclassification before posting.'
                                : 'Mark row as posted.'
                          }
                          type="button"
                        >
                          Mark as Posted
                        </button>
                        <button className="text-button" onClick={() => setModal({ type: 'edit-gl', document })} type="button">
                          Edit GL
                        </button>
                        <button className="text-button" onClick={() => setModal({ type: 'edit-document', document })} type="button">
                          Edit
                        </button>
                        <button className="text-button" onClick={() => deleteDocument(document.id)} type="button">
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
      </WorkpaperFrame>

      {modal?.type === 'add-document' ? (
        <DocumentModal
          onClose={() => setModal(null)}
          onSave={(form) => {
            onSessionChange((current) => ({
              ...current,
              documents: [...current.documents, documentFromForm(form, nextDocumentId(current.documents))],
              journalVoucherReady: false,
            }))
            setModal(null)
          }}
        />
      ) : null}

      {modal?.type === 'edit-document' ? (
        <DocumentModal
          document={modal.document}
          onClose={() => setModal(null)}
          onSave={(form) => {
            onSessionChange((current) => ({
              ...current,
              documents: current.documents.map((document) =>
                document.id === modal.document.id ? { ...documentFromForm(form, document.id), status: document.status } : document,
              ),
              journalVoucherReady: false,
            }))
            setModal(null)
          }}
        />
      ) : null}

      {modal?.type === 'split' ? (
        <SplitModal
          document={modal.document}
          existingDecision={session.splitDecisions.find((decision) => decision.documentId === modal.document.id)}
          onClose={() => setModal(null)}
          onConfirm={(decision) => {
            onSessionChange((current) => ({
              ...current,
              splitDecisions: [
                ...current.splitDecisions.filter((item) => item.documentId !== decision.documentId),
                decision,
              ],
              documents: current.documents.map((document) =>
                document.id === decision.documentId
                  ? {
                      ...document,
                      status: 'Split Done',
                      splitType: decision.splitType,
                      note: `${decision.splitType} confirmed with ${decision.lines.length} split lines.`,
                    }
                  : document,
              ),
            }))
            setModal(null)
          }}
        />
      ) : null}

      {modal?.type === 'reclassify' ? (
        <ReclassifyModal
          document={modal.document}
          existingDecision={session.reclassifyDecisions.find(
            (decision) => decision.documentId === modal.document.id,
          )}
          onClose={() => setModal(null)}
          onConfirm={(decision) => {
            onSessionChange((current) => ({
              ...current,
              reclassifyDecisions: [
                ...current.reclassifyDecisions.filter((item) => item.documentId !== decision.documentId),
                decision,
              ],
              documents: current.documents.map((document) =>
                document.id === decision.documentId
                  ? {
                      ...document,
                      status: 'Reclassified',
                      reclassifyType: decision.reclassifyType,
                      glAccount: `${decision.accountCode} - ${decision.accountName}`,
                      note: decision.note,
                    }
                  : document,
              ),
            }))
            setModal(null)
          }}
        />
      ) : null}

      {modal?.type === 'edit-gl' ? (
        <EditGlModal
          document={modal.document}
          onClose={() => setModal(null)}
          onSave={(account) => {
            updateDocument(modal.document.id, (document) => ({
              ...document,
              glAccount: formatAccount(account),
              status: document.status === 'Pending Review' ? 'Posted' : document.status,
              note: document.status === 'Pending Review' ? undefined : document.note,
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
  tone?: 'neutral' | 'green' | 'orange' | 'purple' | 'red'
}) {
  return (
    <article className={`summary-card tone-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  )
}

function DocumentModal({
  document,
  onClose,
  onSave,
}: {
  document?: SourceDocument
  onClose: () => void
  onSave: (form: DocumentFormState) => void
}) {
  const [form, setForm] = useState<DocumentFormState>(formFromDocument(document))
  const canSave = Boolean(form.date.trim() && form.docRef.trim() && form.party.trim() && form.amount > 0)

  return (
    <ModalFrame
      eyebrow="Manual WP1 entry"
      onClose={onClose}
      title={document ? 'Edit Document' : 'Add Document'}
    >
      <div className="manual-form-grid">
        <label>
          <span>Date</span>
          <input value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} />
        </label>
        <label>
          <span>Document Ref</span>
          <input value={form.docRef} onChange={(event) => setForm({ ...form, docRef: event.target.value })} />
        </label>
        <label>
          <span>Vendor / Customer</span>
          <input value={form.party} onChange={(event) => setForm({ ...form, party: event.target.value })} />
        </label>
        <label>
          <span>Document Type</span>
          <select
            value={form.docType}
            onChange={(event) => setForm({ ...form, docType: event.target.value as DocumentType })}
          >
            {documentTypes.map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Amount</span>
          <input
            min="0"
            step="0.01"
            type="number"
            value={form.amount}
            onChange={(event) => setForm({ ...form, amount: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>GL Account</span>
          <select value={form.glAccount} onChange={(event) => setForm({ ...form, glAccount: event.target.value })}>
            <option value="">Select later</option>
            {accountsForDocumentType(form.docType).map((account) => (
              <option key={account.code} value={formatAccount(account)}>
                {formatAccount(account)}
              </option>
            ))}
          </select>
        </label>
        <label className="wide-field">
          <span>Notes</span>
          <input value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
        </label>
      </div>

      <div className="modal-actions">
        <button className="secondary-button" onClick={onClose} type="button">
          Cancel
        </button>
        <button className="primary-button" disabled={!canSave} onClick={() => onSave(form)} type="button">
          Save Document
        </button>
      </div>
    </ModalFrame>
  )
}

function SplitModal({
  document,
  existingDecision,
  onClose,
  onConfirm,
}: {
  document: SourceDocument
  existingDecision?: SplitDecision
  onClose: () => void
  onConfirm: (decision: SplitDecision) => void
}) {
  const [splitType, setSplitType] = useState<SplitType>(existingDecision?.splitType ?? defaultSplitType(document))
  const [lines, setLines] = useState<SplitLine[]>(
    existingDecision?.lines ?? defaultSplitLines(document, existingDecision?.splitType ?? defaultSplitType(document)),
  )

  const total = lines.reduce((sum, line) => sum + Number(line.amount || 0), 0)
  const difference = Number((document.amount - total).toFixed(2))
  const isBalanced = Math.abs(difference) < 0.01

  const replaceLine = (lineId: string, nextLine: SplitLine) => {
    setLines((current) => current.map((line) => (line.id === lineId ? nextLine : line)))
  }

  const changeType = (nextType: SplitType) => {
    setSplitType(nextType)
    setLines(defaultSplitLines(document, nextType))
  }

  return (
    <ModalFrame
      eyebrow={`Row ${document.id} - ${document.docRef}`}
      onClose={onClose}
      title={`${splitType} Split`}
    >
      <div className="modal-source-bar">
        <div>
          <span>Source document</span>
          <strong>{document.party}</strong>
        </div>
        <div>
          <span>Amount</span>
          <strong className="amount-out">RM {formatMoney(document.amount)}</strong>
        </div>
        <div>
          <span>Split type</span>
          <select value={splitType} onChange={(event) => changeType(event.target.value as SplitType)}>
            {splitTypes.map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="split-line-list">
        {lines.map((line) => (
          <SplitLineEditor key={line.id} line={line} onChange={(nextLine) => replaceLine(line.id, nextLine)} />
        ))}
      </div>

      <button
        className="secondary-button modal-add-line"
        onClick={() =>
          setLines((current) => [
            ...current,
            makeLine(`line-${current.length + 1}`, document.glAccount.slice(0, 4) || '5020', 'DR', 0, 'New split line'),
          ])
        }
        type="button"
      >
        Add Split Line
      </button>

      <div className={isBalanced ? 'balance-box ok' : 'balance-box error'}>
        <span>Split total RM {formatMoney(total)}</span>
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
          onClick={() =>
            onConfirm({
              documentId: document.id,
              splitType,
              lines,
              confirmedAt: new Date().toISOString(),
            })
          }
          type="button"
        >
          Confirm Split
        </button>
      </div>
    </ModalFrame>
  )
}

function SplitLineEditor({
  line,
  onChange,
}: {
  line: SplitLine
  onChange: (line: SplitLine) => void
}) {
  const updateAccount = (code: string) => {
    const account = accountFromCode(code)
    onChange({ ...line, accountCode: account.code, accountName: account.name })
  }

  return (
    <div className="split-line-editor">
      <label>
        <span>Account</span>
        <select value={line.accountCode} onChange={(event) => updateAccount(event.target.value)}>
          {accountOptions.map((account) => (
            <option key={account.code} value={account.code}>
              {account.code} - {account.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Direction</span>
        <select
          value={line.direction}
          onChange={(event) => onChange({ ...line, direction: event.target.value as EntryDirection })}
        >
          <option>DR</option>
          <option>CR</option>
        </select>
      </label>
      <label>
        <span>Amount</span>
        <input
          min="0"
          step="0.01"
          type="number"
          value={line.amount}
          onChange={(event) => onChange({ ...line, amount: Number(event.target.value) })}
        />
      </label>
      <label>
        <span>Description</span>
        <input
          type="text"
          value={line.description}
          onChange={(event) => onChange({ ...line, description: event.target.value })}
        />
      </label>
    </div>
  )
}

function ReclassifyModal({
  document,
  existingDecision,
  onClose,
  onConfirm,
}: {
  document: SourceDocument
  existingDecision?: ReclassifyDecision
  onClose: () => void
  onConfirm: (decision: ReclassifyDecision) => void
}) {
  const [reclassifyType, setReclassifyType] = useState<ReclassifyType>(
    existingDecision?.reclassifyType ?? document.reclassifyType ?? 'Asset purchase',
  )
  const [assetAccountCode, setAssetAccountCode] = useState(existingDecision?.accountCode ?? '1530')
  const [usefulLifeMonths, setUsefulLifeMonths] = useState(existingDecision?.usefulLifeMonths ?? 60)
  const [directorNature, setDirectorNature] = useState<DirectorTransactionNature>(
    existingDecision?.directorNature ?? 'Loan to/from Director',
  )

  const selectedDirector = directorOptions.find((option) => option.nature === directorNature) ?? directorOptions[0]
  const assetAccount = accountFromCode(assetAccountCode)
  const selectedAccount = reclassifyType === 'Asset purchase' ? assetAccount : selectedDirector.account

  return (
    <ModalFrame
      eyebrow={`Row ${document.id} - ${document.docRef}`}
      onClose={onClose}
      title={`Reclassify - ${reclassifyType}`}
    >
      <div className="modal-source-bar">
        <div>
          <span>Source document</span>
          <strong>{document.party}</strong>
        </div>
        <div>
          <span>Amount</span>
          <strong>RM {formatMoney(document.amount)}</strong>
        </div>
        <div>
          <span>Type</span>
          <select
            value={reclassifyType}
            onChange={(event) => setReclassifyType(event.target.value as ReclassifyType)}
          >
            {reclassifyTypes.map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
        </div>
      </div>

      {reclassifyType === 'Asset purchase' ? (
        <div className="reclass-panel">
          <label>
            <span>Asset account</span>
            <select value={assetAccountCode} onChange={(event) => setAssetAccountCode(event.target.value)}>
              {['1530'].map((code) => {
                const account = accountFromCode(code)
                return (
                  <option key={account.code} value={account.code}>
                    {account.code} - {account.name}
                  </option>
                )
              })}
            </select>
          </label>
          <label>
            <span>Useful life</span>
            <select
              value={usefulLifeMonths}
              onChange={(event) => setUsefulLifeMonths(Number(event.target.value))}
            >
              <option value={36}>36 months</option>
              <option value={48}>48 months</option>
              <option value={60}>60 months</option>
            </select>
          </label>
          <div className="info-panel green">
            <strong>Depreciation preview</strong>
            <p>Monthly charge RM {formatMoney(document.amount / usefulLifeMonths)} from adjusting entries.</p>
          </div>
        </div>
      ) : (
        <div className="nature-list">
          {directorOptions.map((option) => (
            <button
              className={option.nature === directorNature ? 'nature-option selected' : 'nature-option'}
              key={option.nature}
              onClick={() => setDirectorNature(option.nature)}
              type="button"
            >
              <strong>{option.nature}</strong>
              <span>{option.account.code} - {option.account.name}</span>
              <small>{option.description}</small>
            </button>
          ))}
        </div>
      )}

      <div className="gl-result">
        <span>Resulting account</span>
        <strong>
          {selectedAccount.code} - {selectedAccount.name}
        </strong>
      </div>

      <div className="modal-actions">
        <button className="secondary-button" onClick={onClose} type="button">
          Cancel
        </button>
        <button
          className="primary-button"
          onClick={() =>
            onConfirm({
              documentId: document.id,
              reclassifyType,
              accountCode: selectedAccount.code,
              accountName: selectedAccount.name,
              usefulLifeMonths: reclassifyType === 'Asset purchase' ? usefulLifeMonths : undefined,
              directorNature: reclassifyType === 'Director transaction' ? directorNature : undefined,
              note:
                reclassifyType === 'Asset purchase'
                  ? `Capitalised to ${selectedAccount.code}. Useful life ${usefulLifeMonths} months.`
                  : `${directorNature} posted to ${selectedAccount.code}.`,
              confirmedAt: new Date().toISOString(),
            })
          }
          type="button"
        >
          Confirm Reclassify
        </button>
      </div>
    </ModalFrame>
  )
}

function EditGlModal({
  document,
  onClose,
  onSave,
}: {
  document: SourceDocument
  onClose: () => void
  onSave: (account: AccountOption) => void
}) {
  const initialCode = document.glAccount.slice(0, 4) || accountsForDocumentType(document.docType)[0].code
  const [selectedCode, setSelectedCode] = useState(initialCode)
  const selectedAccount = accountFromCode(selectedCode)

  return (
    <ModalFrame eyebrow={`Row ${document.id} - ${document.docRef}`} onClose={onClose} title="Edit GL Account">
      <div className="modal-source-bar">
        <div>
          <span>Document</span>
          <strong>{document.party}</strong>
        </div>
        <div>
          <span>Document type</span>
          <strong>{document.docType}</strong>
        </div>
      </div>

      <label className="single-field">
        <span>GL account</span>
        <select value={selectedCode} onChange={(event) => setSelectedCode(event.target.value)}>
          {accountsForDocumentType(document.docType).map((account) => (
            <option key={account.code} value={account.code}>
              {account.code} - {account.name}
            </option>
          ))}
        </select>
      </label>

      <div className="gl-result">
        <span>Selected</span>
        <strong>{formatAccount(selectedAccount)}</strong>
      </div>

      <div className="modal-actions">
        <button className="secondary-button" onClick={onClose} type="button">
          Cancel
        </button>
        <button className="primary-button" onClick={() => onSave(selectedAccount)} type="button">
          Save GL
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
