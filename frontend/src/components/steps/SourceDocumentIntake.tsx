import type { Dispatch, SetStateAction } from 'react'
import { accountsForDocumentType, formatAccount } from '../../data/accounts'
import type {
  BankRow,
  DocumentType,
  IntakeDocumentType,
  IntakeTarget,
  SampleSession,
  SourceDocument,
  SourceIntakeItem,
  WorkflowStepId,
} from '../../types/session'
import { WorkpaperFrame } from '../layout/WorkpaperFrame'

interface SourceDocumentIntakeProps {
  session: SampleSession
  onSessionChange: Dispatch<SetStateAction<SampleSession>>
  onStepChange: (step: WorkflowStepId) => void
}

type IntakePatch = Partial<Omit<SourceIntakeItem, 'id'>>

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

const intakeTypes: IntakeDocumentType[] = [...documentTypes, 'Bank Statement', 'Unknown']

const readableFileExtensions = ['csv', 'txt', 'tsv']

const formatMoney = (amount: number) =>
  new Intl.NumberFormat('en-MY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)

const parseAmount = (value: string) => {
  const normalized = value.replace(/[()RM\s]/gi, '').replace(/,/g, '')
  const amount = Number(normalized)
  if (!Number.isFinite(amount)) return 0
  return value.includes('(') && value.includes(')') ? Math.abs(amount) : Math.abs(amount)
}

const cleanWords = (value: string) =>
  value
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

const isReadableFile = (file: File) => {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  return file.type.startsWith('text/') || readableFileExtensions.includes(extension)
}

const readFileText = (file: File) =>
  new Promise<string>((resolve) => {
    if (!isReadableFile(file)) {
      resolve('')
      return
    }

    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => resolve('')
    reader.readAsText(file)
  })

const detectType = (fileName: string, text: string): Pick<SourceIntakeItem, 'detectedType' | 'confidence' | 'target'> => {
  const content = normalize(`${fileName} ${text.slice(0, 2000)}`)

  const rules: Array<{ type: IntakeDocumentType; target: IntakeTarget; keywords: string[] }> = [
    { type: 'Bank Statement', target: 'WP2', keywords: ['bank statement', 'account statement', 'cimb', 'maybank', 'public bank', 'debit', 'credit', 'balance'] },
    { type: 'Merchant Statement', target: 'WP1', keywords: ['merchant', 'grab', 'foodpanda', 'payout', 'settlement'] },
    { type: 'Payroll Summary', target: 'WP1', keywords: ['payroll', 'salary', 'epf', 'socso', 'eis', 'pcb'] },
    { type: 'Loan / HP Statement', target: 'WP1', keywords: ['loan', 'hire purchase', 'hp', 'principal', 'interest'] },
    { type: 'Utility Bill', target: 'WP1', keywords: ['tnb', 'tenaga', 'utility', 'electricity', 'water', 'indah water'] },
    { type: 'Sales Invoice', target: 'WP1', keywords: ['sales invoice', 'invoice to customer', 'customer invoice'] },
    { type: 'Purchase Invoice', target: 'WP1', keywords: ['supplier invoice', 'purchase invoice', 'vendor invoice', 'bill'] },
    { type: 'Payment Voucher', target: 'WP1', keywords: ['payment voucher', 'pv', 'payment'] },
    { type: 'Receipt', target: 'WP1', keywords: ['receipt', 'official receipt'] },
  ]

  for (const rule of rules) {
    const hits = rule.keywords.filter((keyword) => content.includes(keyword)).length
    if (hits >= 2) return { detectedType: rule.type, confidence: 'High', target: rule.target }
    if (hits === 1) return { detectedType: rule.type, confidence: 'Medium', target: rule.target }
  }

  return { detectedType: 'Unknown', confidence: 'Low', target: 'WP1' }
}

const extractDate = (source: string) => {
  const iso = source.match(/\b(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/)
  if (iso) return `${iso[3].padStart(2, '0')} ${monthName(Number(iso[2]))}`

  const dayMonth = source.match(/\b(0?[1-9]|[12]\d|3[01])\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i)
  if (dayMonth) return `${dayMonth[1].padStart(2, '0')} ${capitaliseMonth(dayMonth[2])}`

  const slash = source.match(/\b(0?[1-9]|[12]\d|3[01])[-/.](0?[1-9]|1[0-2])[-/.](20\d{2}|\d{2})\b/)
  if (slash) return `${slash[1].padStart(2, '0')} ${monthName(Number(slash[2]))}`

  return ''
}

const monthName = (month: number) =>
  ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1] ?? ''

const capitaliseMonth = (month: string) => `${month.charAt(0).toUpperCase()}${month.slice(1, 3).toLowerCase()}`

const extractReference = (source: string, fallback: string) => {
  const reference = source.match(/\b(?:INV|PV|OR|REC|BILL|PAY|LOAN|CHQ|CN|DN)[-\s]?[A-Z0-9-]{2,}\b/i)
  if (reference) return reference[0].replace(/\s+/g, '-').toUpperCase()
  return cleanWords(fallback).split(' ').slice(0, 3).join('-').toUpperCase()
}

const extractLargestAmount = (source: string) => {
  const matches = source.match(/(?:RM\s*)?\(?\d{1,3}(?:,\d{3})*(?:\.\d{2})?\)?/gi) ?? []
  return matches.reduce((max, value) => Math.max(max, parseAmount(value)), 0)
}

const suggestedAccountForType = (docType: IntakeDocumentType) => {
  if (!documentTypes.includes(docType as DocumentType)) return ''
  return formatAccount(accountsForDocumentType(docType as DocumentType)[0])
}

const splitDelimitedLine = (line: string, delimiter: string) => {
  const cells: string[] = []
  let current = ''
  let inQuotes = false

  for (const character of line) {
    if (character === '"') {
      inQuotes = !inQuotes
    } else if (character === delimiter && !inQuotes) {
      cells.push(current.trim())
      current = ''
    } else {
      current += character
    }
  }

  cells.push(current.trim())
  return cells.map((cell) => cell.replace(/^"|"$/g, ''))
}

const parseTabularRows = (text: string, file: File, uploadedAt: string): SourceIntakeItem[] => {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length < 2) return []

  const delimiter = lines[0].includes('\t') ? '\t' : ','
  const headers = splitDelimitedLine(lines[0], delimiter).map((header) => normalize(header))
  const headerText = headers.join(' ')
  const looksLikeBank = /money in|deposit|credit|money out|withdrawal|debit|bank description|balance/.test(headerText)
  const looksLikeDoc = /document|doc ref|vendor|customer|party|invoice|amount/.test(headerText)

  if (!looksLikeBank && !looksLikeDoc) return []

  const indexFor = (candidates: string[]) =>
    headers.findIndex((header) => candidates.some((candidate) => header.includes(candidate)))

  const dateIndex = indexFor(['date', 'transaction date'])
  const descriptionIndex = indexFor(['description', 'bank description', 'vendor', 'customer', 'party'])
  const referenceIndex = indexFor(['reference', 'doc ref', 'document ref', 'invoice', 'ref'])
  const amountIndex = indexFor(['amount', 'total'])
  const moneyInIndex = indexFor(['money in', 'deposit', 'credit'])
  const moneyOutIndex = indexFor(['money out', 'withdrawal', 'debit'])
  const typeIndex = indexFor(['document type', 'doc type', 'type'])
  const glIndex = indexFor(['gl account', 'account'])
  const notesIndex = indexFor(['note', 'notes', 'remarks'])

  return lines.slice(1, 51).map((line, index) => {
    const cells = splitDelimitedLine(line, delimiter)
    const rowText = cells.join(' ')
    const detection = looksLikeBank
      ? { detectedType: 'Bank Statement' as const, confidence: 'High' as const, target: 'WP2' as const }
      : detectType(`${file.name} ${cells[typeIndex] ?? ''}`, rowText)
    const typeFromRow = cells[typeIndex] as IntakeDocumentType | undefined
    const detectedType = typeFromRow && intakeTypes.includes(typeFromRow) ? typeFromRow : detection.detectedType
    const amount = amountIndex >= 0 ? parseAmount(cells[amountIndex] ?? '') : extractLargestAmount(rowText)
    const moneyIn = moneyInIndex >= 0 ? parseAmount(cells[moneyInIndex] ?? '') : detection.target === 'WP2' && amount > 0 ? amount : 0
    const moneyOut = moneyOutIndex >= 0 ? parseAmount(cells[moneyOutIndex] ?? '') : 0

    return {
      id: `INT-${Date.now()}-${index}`,
      fileName: `${file.name} row ${index + 1}`,
      fileType: file.type || 'text/csv',
      fileSize: file.size,
      uploadedAt,
      detectedType,
      confidence: detection.confidence,
      status: 'Needs Review',
      target: detection.target,
      date: cells[dateIndex] || extractDate(rowText),
      reference: cells[referenceIndex] || extractReference(rowText, file.name),
      party: cells[descriptionIndex] || cleanWords(file.name),
      amount: detection.target === 'WP2' ? Math.max(moneyIn, moneyOut, amount) : amount,
      moneyIn,
      moneyOut,
      suggestedGlAccount: cells[glIndex] || suggestedAccountForType(detectedType),
      notes: cells[notesIndex] || 'Imported from uploaded spreadsheet/CSV.',
      rawPreview: rowText.slice(0, 240),
    }
  })
}

const buildIntakeItemsForFile = async (file: File): Promise<SourceIntakeItem[]> => {
  const uploadedAt = new Date().toISOString()
  const text = await readFileText(file)
  const tabularRows = parseTabularRows(text, file, uploadedAt)
  if (tabularRows.length) return tabularRows

  const detection = detectType(file.name, text)
  const source = `${file.name} ${text.slice(0, 2000)}`
  const amount = extractLargestAmount(source)
  const reference = extractReference(source, file.name)
  const detectedType = detection.detectedType

  return [
    {
      id: `INT-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      fileName: file.name,
      fileType: file.type || 'unknown',
      fileSize: file.size,
      uploadedAt,
      detectedType,
      confidence: detection.confidence,
      status: 'Needs Review',
      target: detection.target,
      date: extractDate(source),
      reference,
      party: cleanWords(file.name),
      amount,
      moneyIn: detection.target === 'WP2' ? amount : 0,
      moneyOut: 0,
      suggestedGlAccount: suggestedAccountForType(detectedType),
      notes: text ? 'Detected from readable file content.' : 'Detected from file name. Review fields before importing.',
      rawPreview: text.slice(0, 240),
    },
  ]
}

const nextDocumentId = (documents: SourceDocument[], offset: number) => {
  const maxNumber = documents.reduce((max, document) => {
    const numeric = Number(document.id.replace(/\D/g, ''))
    return Number.isFinite(numeric) ? Math.max(max, numeric) : max
  }, 0)
  return String(maxNumber + offset + 1).padStart(2, '0')
}

const nextBankRowId = (rows: BankRow[], offset: number) => {
  const maxNumber = rows.reduce((max, row) => {
    const numeric = Number(row.id.replace(/\D/g, ''))
    return Number.isFinite(numeric) ? Math.max(max, numeric) : max
  }, 0)
  return String(maxNumber + offset + 1).padStart(2, '0')
}

const flowForDocumentType = (docType: IntakeDocumentType) =>
  ['Sales Invoice', 'Receipt', 'Merchant Statement'].includes(docType) ? 'IN' : 'OUT'

const sourceDocumentFromIntake = (item: SourceIntakeItem, id: string): SourceDocument => {
  const docType = documentTypes.includes(item.detectedType as DocumentType)
    ? (item.detectedType as DocumentType)
    : 'Purchase Invoice'

  return {
    id,
    date: item.date.trim(),
    docRef: item.reference.trim(),
    party: item.party.trim(),
    docType,
    amount: Number(item.amount || 0),
    flow: flowForDocumentType(docType),
    glAccount: item.suggestedGlAccount.trim(),
    status: item.suggestedGlAccount.trim() ? 'Posted' : 'Pending Review',
    note: item.notes.trim() || undefined,
  }
}

const bankRowFromIntake = (item: SourceIntakeItem, id: string): BankRow => {
  const moneyIn = Number(item.moneyIn || 0)
  const moneyOut = Number(item.moneyOut || 0)
  const direction = moneyIn > 0 ? 'CR' : 'DR'

  return {
    id,
    date: item.date.trim(),
    description: item.party.trim() || item.fileName,
    reference: item.reference.trim(),
    amount: moneyIn > 0 ? moneyIn : moneyOut || Number(item.amount || 0),
    direction,
    status: 'Needs Review',
    matchedTo: 'Review against WP1',
    remarks: item.notes.trim() || 'Imported from source intake.',
  }
}

const canAccept = (item: SourceIntakeItem) =>
  item.target === 'Ignore' ||
  Boolean(item.date.trim() && item.reference.trim() && item.party.trim() && Number(item.amount || 0) > 0)

export function SourceDocumentIntake({ session, onSessionChange, onStepChange }: SourceDocumentIntakeProps) {
  const items = session.sourceIntakeItems
  const acceptedWp1 = items.filter((item) => item.status === 'Accepted' && item.target === 'WP1')
  const acceptedWp2 = items.filter((item) => item.status === 'Accepted' && item.target === 'WP2')
  const needsReview = items.filter((item) => item.status === 'Needs Review').length

  const updateItem = (itemId: string, patch: IntakePatch) => {
    onSessionChange((current) => ({
      ...current,
      sourceIntakeItems: current.sourceIntakeItems.map((item) =>
        item.id === itemId ? { ...item, ...patch, status: item.status === 'Imported' ? item.status : patch.status ?? item.status } : item,
      ),
      journalVoucherReady: false,
    }))
  }

  const handleFiles = async (fileList: FileList | null) => {
    const files = Array.from(fileList ?? [])
    if (!files.length) return
    const batches = await Promise.all(files.map((file) => buildIntakeItemsForFile(file)))
    const nextItems = batches.flat()
    onSessionChange((current) => ({
      ...current,
      sourceIntakeItems: [...current.sourceIntakeItems, ...nextItems],
      journalVoucherReady: false,
    }))
  }

  const importAccepted = () => {
    onSessionChange((current) => {
      const wp1Items = current.sourceIntakeItems.filter((item) => item.status === 'Accepted' && item.target === 'WP1')
      const wp2Items = current.sourceIntakeItems.filter((item) => item.status === 'Accepted' && item.target === 'WP2')
      const documents = wp1Items.map((item, index) => sourceDocumentFromIntake(item, nextDocumentId(current.documents, index)))
      const bankRows = wp2Items.map((item, index) => bankRowFromIntake(item, nextBankRowId(current.bankRows, index)))

      return {
        ...current,
        documents: [...current.documents, ...documents],
        bankRows: [...current.bankRows, ...bankRows],
        sourceIntakeItems: current.sourceIntakeItems.map((item) =>
          item.status === 'Accepted' && item.target !== 'Ignore' ? { ...item, status: 'Imported' } : item,
        ),
        journalVoucherReady: false,
      }
    })
  }

  const clearImported = () => {
    onSessionChange((current) => ({
      ...current,
      sourceIntakeItems: current.sourceIntakeItems.filter((item) => item.status !== 'Imported' && item.status !== 'Ignored'),
    }))
  }

  return (
    <>
      <section className="intake-upload-panel">
        <div className="intake-upload-copy">
          <span>Source Document Intake</span>
          <strong>Upload BK test documents before WP1 and WP2.</strong>
          <p>CSV/TXT rows are read in the browser. PDFs, images, and Excel files become review rows that BKs can correct before importing.</p>
        </div>
        <label className="file-upload-button">
          <input
            multiple
            onChange={(event) => {
              void handleFiles(event.target.files)
              event.target.value = ''
            }}
            type="file"
          />
          Add Source Docs
        </label>
      </section>

      <div className="wp1-summary-grid intake-summary-grid">
        <SummaryCard label="Uploaded / Parsed" value={items.length.toString()} />
        <SummaryCard label="Needs Review" tone="orange" value={needsReview.toString()} />
        <SummaryCard label="Accepted for WP1" tone="green" value={acceptedWp1.length.toString()} />
        <SummaryCard label="Accepted for WP2" tone="blue" value={acceptedWp2.length.toString()} />
        <SummaryCard label="Imported" tone="teal" value={items.filter((item) => item.status === 'Imported').length.toString()} />
        <SummaryCard label="Ignored" tone="red" value={items.filter((item) => item.status === 'Ignored').length.toString()} />
      </div>

      <WorkpaperFrame
        period={session.client.period}
        subtitle={`${session.client.entityName} - review detected source documents before they enter the workpapers`}
        title="Source Document Intake"
        footer={
          <>
            <div className="metric">
              <span>WP1 Ready</span>
              <strong>{acceptedWp1.length}</strong>
            </div>
            <div className="metric">
              <span>WP2 Ready</span>
              <strong>{acceptedWp2.length}</strong>
            </div>
            <button
              className="secondary-button"
              disabled={!items.some((item) => item.status === 'Imported' || item.status === 'Ignored')}
              onClick={clearImported}
              type="button"
            >
              Clear Completed
            </button>
            <button
              className="primary-button"
              disabled={!acceptedWp1.length && !acceptedWp2.length}
              onClick={importAccepted}
              type="button"
            >
              Import Accepted
            </button>
          </>
        }
      >
        {items.length ? (
          <div className="table-scroll">
            <table className="data-table intake-table">
              <thead>
                <tr>
                  <th>File / Row</th>
                  <th>Type</th>
                  <th>Target</th>
                  <th>Date</th>
                  <th>Reference</th>
                  <th>Party / Description</th>
                  <th className="right">Amount</th>
                  <th>GL / Bank Dir</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr className={`intake-row status-row-${item.status.toLowerCase().replace(/\s+/g, '-')}`} key={item.id}>
                    <td>
                      <strong>{item.fileName}</strong>
                      <small>
                        {item.confidence} confidence - {(item.fileSize / 1024).toFixed(1)} KB
                      </small>
                    </td>
                    <td>
                      <select
                        disabled={item.status === 'Imported'}
                        value={item.detectedType}
                        onChange={(event) => {
                          const detectedType = event.target.value as IntakeDocumentType
                          updateItem(item.id, {
                            detectedType,
                            target: detectedType === 'Bank Statement' ? 'WP2' : detectedType === 'Unknown' ? item.target : 'WP1',
                            suggestedGlAccount: suggestedAccountForType(detectedType) || item.suggestedGlAccount,
                          })
                        }}
                      >
                        {intakeTypes.map((type) => (
                          <option key={type}>{type}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        disabled={item.status === 'Imported'}
                        value={item.target}
                        onChange={(event) => updateItem(item.id, { target: event.target.value as IntakeTarget })}
                      >
                        <option>WP1</option>
                        <option>WP2</option>
                        <option>Ignore</option>
                      </select>
                    </td>
                    <td>
                      <input
                        disabled={item.status === 'Imported'}
                        value={item.date}
                        onChange={(event) => updateItem(item.id, { date: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        disabled={item.status === 'Imported'}
                        value={item.reference}
                        onChange={(event) => updateItem(item.id, { reference: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        disabled={item.status === 'Imported'}
                        value={item.party}
                        onChange={(event) => updateItem(item.id, { party: event.target.value })}
                      />
                      {item.rawPreview ? <small>{item.rawPreview}</small> : null}
                    </td>
                    <td className="right">
                      <input
                        className="right"
                        disabled={item.status === 'Imported'}
                        min="0"
                        step="0.01"
                        type="number"
                        value={item.amount}
                        onChange={(event) => {
                          const amount = Number(event.target.value)
                          updateItem(item.id, {
                            amount,
                            moneyIn: item.target === 'WP2' && item.moneyOut === 0 ? amount : item.moneyIn,
                          })
                        }}
                      />
                      <small>RM {formatMoney(Number(item.amount || 0))}</small>
                    </td>
                    <td>
                      {item.target === 'WP2' ? (
                        <select
                          disabled={item.status === 'Imported'}
                          value={item.moneyIn > 0 ? 'Money In' : 'Money Out'}
                          onChange={(event) => {
                            const amount = Number(item.amount || 0)
                            updateItem(
                              item.id,
                              event.target.value === 'Money In'
                                ? { moneyIn: amount, moneyOut: 0 }
                                : { moneyIn: 0, moneyOut: amount },
                            )
                          }}
                        >
                          <option>Money In</option>
                          <option>Money Out</option>
                        </select>
                      ) : (
                        <select
                          disabled={item.status === 'Imported' || !documentTypes.includes(item.detectedType as DocumentType)}
                          value={item.suggestedGlAccount}
                          onChange={(event) => updateItem(item.id, { suggestedGlAccount: event.target.value })}
                        >
                          <option value="">Select in WP1</option>
                          {documentTypes.includes(item.detectedType as DocumentType)
                            ? accountsForDocumentType(item.detectedType as DocumentType).map((account) => (
                                <option key={account.code} value={formatAccount(account)}>
                                  {formatAccount(account)}
                                </option>
                              ))
                            : null}
                        </select>
                      )}
                    </td>
                    <td>
                      <span className={`badge badge-${item.status.toLowerCase().replace(/\s+/g, '-')}`}>
                        {item.status}
                      </span>
                    </td>
                    <td>
                      <div className="action-group intake-actions">
                        {item.status === 'Imported' ? (
                          <span className="verified-text">Imported</span>
                        ) : (
                          <>
                            <button
                              className="text-button split-action"
                              disabled={!canAccept(item)}
                              onClick={() =>
                                updateItem(item.id, {
                                  status: item.target === 'Ignore' ? 'Ignored' : 'Accepted',
                                })
                              }
                              type="button"
                            >
                              {item.target === 'Ignore' ? 'Ignore' : 'Accept'}
                            </button>
                            <button
                              className="text-button"
                              onClick={() => updateItem(item.id, { status: 'Ignored', target: 'Ignore' })}
                              type="button"
                            >
                              Skip
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="intake-empty-state">
            <strong>No source documents uploaded yet.</strong>
            <p>Use Add Source Docs above. BKs can upload real test files, review what was detected, and import accepted rows into WP1 or WP2.</p>
          </div>
        )}
      </WorkpaperFrame>

      <section className="intake-next-panel">
        <div>
          <strong>After importing accepted rows</strong>
          <span>Open WP1 to resolve GL, split, and reclassify items. Open WP2 after bank statement rows are imported.</span>
        </div>
        <div className="intake-next-actions">
          <button className="secondary-button" onClick={() => onStepChange('wp1')} type="button">
            Open WP1
          </button>
          <button className="secondary-button" onClick={() => onStepChange('wp2')} type="button">
            Open WP2
          </button>
        </div>
      </section>
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
  tone?: 'neutral' | 'green' | 'orange' | 'purple' | 'red' | 'blue' | 'teal'
}) {
  return (
    <article className={`summary-card tone-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  )
}
