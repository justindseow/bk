import { useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { accountsForDocumentType, findAccount, formatAccount } from '../../data/accounts'
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
import { apiBaseUrl } from '../../utils/api'
import { buildFileFingerprint } from '../../utils/fileFingerprint'
import { clearSourcePreviewStore, loadSourcePreviewFile, saveSourcePreviewFile } from '../../utils/sourcePreviewStore'
import { telemetryEvent, telemetryIssue } from '../../utils/telemetry'
import { classifyImportedBankRow } from '../../utils/wp2Heuristics'
import { WorkpaperFrame } from '../layout/WorkpaperFrame'
import { createBlankBkTestSession } from '../../state/demoSessions'

interface SourceDocumentIntakeProps {
  session: SampleSession
  onSessionChange: Dispatch<SetStateAction<SampleSession>>
  onStepChange: (step: WorkflowStepId) => void
}

type IntakePatch = Partial<Omit<SourceIntakeItem, 'id'>>

type DetectionResult = Pick<SourceIntakeItem, 'detectedType' | 'confidence' | 'target'> & {
  evidence: string[]
  warnings: string[]
  suggestedGlAccount: string
}

type ExtractResponse = {
  items?: SourceIntakeItem[]
}

type JsonExtractFilePayload = {
  file_name: string
  content_type: string
  data_base64: string
}

type IntakeFamily = 'all' | 'sales' | 'purchases' | 'payments' | 'bank' | 'payroll_loans' | 'needs_attention'
type IntakeWorkspace = 'unclassified' | 'mixed' | 'clean' | 'bank' | 'completed'
type UploadLane = 'auto' | 'purchases' | 'sales' | 'bank' | 'payments'

type IssueSummary = {
  label: string
  detail: string
  focusField: 'type' | 'date' | 'reference' | 'party' | 'amount' | 'gl'
}

type FileSummary = {
  name: string
  items: SourceIntakeItem[]
  amountTotal: number
  acceptedCount: number
  reviewCount: number
  importedCount: number
  ignoredCount: number
  firstReviewId?: string
  primaryType: string
  family: Exclude<IntakeFamily, 'all'>
}

type FamilySummary = {
  id: IntakeFamily
  label: string
  description: string
  rows: number
  files: number
  reviewCount: number
  acceptedCount: number
  importedCount: number
  firstReviewId?: string
  tone: 'neutral' | 'green' | 'orange' | 'purple' | 'red' | 'blue' | 'teal'
}

type QueueSummary = {
  id: IntakeWorkspace
  label: string
  uploads: number
  records: number
  acceptedRecords: number
  reviewRecords: number
  importedRecords: number
  description: string
  tone: 'neutral' | 'green' | 'orange' | 'purple' | 'red' | 'blue' | 'teal'
}

type PreparedUpload = {
  file: File
  fingerprint: string
}

type StagedFile = {
  id: string
  file: File
  lane: UploadLane
}

type UploadLaneOption = {
  id: UploadLane
  label: string
  hint: string
}

type ExtractBatchResult = {
  items: SourceIntakeItem[]
  usedFallback: boolean
  fileCount: number
  recoveredFiles: number
  recoveredFileNames: string[]
  fallbackFiles: number
  fallbackFileNames: string[]
}

type ExtractDiagnostics = {
  filesProcessed: number
  acceptedCount: number
  reviewCount: number
  recoveredFiles: number
  fallbackFiles: number
  fallbackAcceptedFiles: number
  fallbackReviewFiles: number
  cachedFiles: number
  replacementFiles: number
  duplicateFiles: number
}

const aiLimitWarningSignals = [
  'scan limit reached',
  'rate limit reached',
  'top up balance or retry later',
  'key limit exceeded',
  'monthly limit',
  'ai vision extraction failed: openrouter api request failed with http 403',
  'ai vision extraction failed after local ocr fallback: openrouter api request failed with http 402',
  'ai vision extraction failed after local ocr fallback: openrouter api request failed with http 403',
  'ai vision extraction failed after local ocr fallback: openrouter api request failed with http 429',
]

const documentTypes: DocumentType[] = [
  'Sales Invoice',
  'Sales Summary',
  'Purchase Invoice',
  'Payment Voucher',
  'Receipt',
  'Payroll Summary',
  'Loan / HP Statement',
  'Merchant Statement',
  'Merchant Discount Fee',
  'Utility Bill',
]

const intakeTypes: IntakeDocumentType[] = [...documentTypes, 'Bank Statement', 'Unknown']

const readableFileExtensions = ['csv', 'txt', 'tsv']
const uploadLaneOptions: UploadLaneOption[] = [
  { id: 'purchases', label: 'Add Purchase Docs', hint: 'Supplier invoices, bills, payment vouchers, utilities, and expense support.' },
  { id: 'sales', label: 'Add Sales Docs', hint: 'Sales invoices, receipts, merchant statements, and sales summaries.' },
  { id: 'bank', label: 'Add Bank Docs', hint: 'Bank statements and bank-side transaction files.' },
]

const smartRules: Array<{
  label: string
  type: IntakeDocumentType
  target: IntakeTarget
  accountCode?: string
  keywords: string[]
}> = [
  { label: 'Bank statement layout', type: 'Bank Statement', target: 'WP2', keywords: ['bank statement', 'account statement', 'opening balance', 'closing balance'] },
  { label: 'Bank transaction columns', type: 'Bank Statement', target: 'WP2', keywords: ['money in', 'money out', 'debit', 'credit', 'balance'] },
  { label: 'Sales summary export', type: 'Sales Summary', target: 'WP1', accountCode: '4100', keywords: ['sales by category', 'sales by', 'gross sales', 'net sales', 'daily sales', 'sales report', 'pos sales'] },
  { label: 'TNB utilities', type: 'Utility Bill', target: 'WP1', accountCode: '6210', keywords: ['tnb', 'tenaga', 'electricity', 'utility'] },
  { label: 'Water utility', type: 'Utility Bill', target: 'WP1', accountCode: '6210', keywords: ['air selangor', 'water bill', 'utility'] },
  { label: 'Merchant payout', type: 'Merchant Statement', target: 'WP1', accountCode: '4120', keywords: ['grab', 'foodpanda', 'merchant', 'payout', 'settlement'] },
  { label: 'Payroll support', type: 'Payroll Summary', target: 'WP1', accountCode: '6100', keywords: ['payroll', 'salary', 'epf', 'socso', 'eis', 'pcb'] },
  { label: 'Loan repayment support', type: 'Loan / HP Statement', target: 'WP1', accountCode: '2700', keywords: ['loan', 'hire purchase', 'principal', 'interest', 'instalment'] },
  { label: 'Insurance / takaful', type: 'Payment Voucher', target: 'WP1', accountCode: '6380', keywords: ['insurance', 'takaful', 'premium'] },
  { label: 'Rent payment', type: 'Payment Voucher', target: 'WP1', accountCode: '6200', keywords: ['rental', 'rent', 'landlord'] },
  { label: 'Bank charges', type: 'Bank Statement', target: 'WP2', accountCode: '6370', keywords: ['bank charge', 'bank fee', 'service charge', 'charges'] },
  { label: 'Sales invoice', type: 'Sales Invoice', target: 'WP1', accountCode: '4100', keywords: ['sales invoice', 'customer invoice', 'invoice to'] },
  { label: 'Supplier invoice layout', type: 'Purchase Invoice', target: 'WP1', accountCode: '5020', keywords: ['invoice', 'deliver to', 'qty', 'uom', 'terms'] },
  { label: 'Supplier invoice', type: 'Purchase Invoice', target: 'WP1', accountCode: '5020', keywords: ['supplier invoice', 'purchase invoice', 'vendor invoice', 'bill from'] },
  { label: 'Receipt', type: 'Receipt', target: 'WP1', accountCode: '4100', keywords: ['official receipt', 'receipt'] },
  { label: 'Payment voucher', type: 'Payment Voucher', target: 'WP1', accountCode: '5020', keywords: ['payment voucher', 'pv'] },
]

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

const parseSignedAmount = (value: string) => {
  const trimmed = value.trim()
  const amount = parseAmount(trimmed)
  if (!amount) return { amount: 0, direction: 'IN' as const }
  const isOut = trimmed.startsWith('-') || (trimmed.includes('(') && trimmed.includes(')'))
  return { amount, direction: isOut ? 'OUT' as const : 'IN' as const }
}

const cleanWords = (value: string) =>
  value
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const bankSignalTokens = [
  'bank statement',
  'account statement',
  'statement of account',
  'opening balance',
  'closing balance',
  'current account',
  'savings account',
  'money in',
  'money out',
  'debit',
  'credit',
  'balance',
  'cimb',
  'maybank',
  'public bank',
  'rhb',
  'hong leong',
  'uob',
  'ocbc',
  'ambank',
  'bsn',
]
const looksBankLike = (value: string) => {
  const content = normalize(value)
  return bankSignalTokens.some((token) => content.includes(token))
}

const isPdfFile = (file: File) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')

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

const readPdfText = async (file: File) => {
  if (!isPdfFile(file)) return ''

  try {
    const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist')
    GlobalWorkerOptions.workerSrc = pdfWorkerUrl
    const buffer = await file.arrayBuffer()
    const pdf = await getDocument({
      data: new Uint8Array(buffer),
      useWorkerFetch: false,
      isEvalSupported: false,
    } as never).promise

    const pageLimit = Math.min(pdf.numPages, 8)
    const pageTexts: string[] = []

    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const textContent = await page.getTextContent()
      const pageLines: string[] = []
      let currentLine: string[] = []
      let lastY: number | null = null

      for (const item of textContent.items) {
        if (!('str' in item)) continue
        const value = item.str.replace(/\s+/g, ' ').trim()
        if (!value) continue

        const y: number = Array.isArray(item.transform) ? Number(item.transform[5]) : (lastY ?? 0)
        if (lastY !== null && Math.abs(y - lastY) > 2) {
          const builtLine = currentLine.join(' ').replace(/\s+/g, ' ').trim()
          if (builtLine) pageLines.push(builtLine)
          currentLine = []
        }

        currentLine.push(value)
        lastY = y
      }

      const finalLine = currentLine.join(' ').replace(/\s+/g, ' ').trim()
      if (finalLine) pageLines.push(finalLine)

      const pageText = pageLines.join('\n').trim()
      if (pageText) pageTexts.push(pageText)
    }

    return pageTexts.join('\n')
  } catch {
    return ''
  }
}

const accountLabel = (code?: string) => {
  const account = code ? findAccount(code) : undefined
  return account ? formatAccount(account) : ''
}

const applyUploadLaneToDetection = (
  detection: DetectionResult,
  uploadLane: UploadLane,
  source: string,
): DetectionResult => {
  if (uploadLane === 'auto') return detection

  const startingType = detection.detectedType
  const normalizedSource = normalize(source)
  const nextDetection = {
    ...detection,
    evidence: [...detection.evidence],
    warnings: [...detection.warnings],
  }

  if (uploadLane === 'purchases') {
    if ((nextDetection.detectedType === 'Unknown' || nextDetection.detectedType === 'Sales Invoice') && normalizedSource.includes('invoice')) {
      nextDetection.detectedType = 'Purchase Invoice'
      nextDetection.target = 'WP1'
      nextDetection.suggestedGlAccount = suggestedAccountForType('Purchase Invoice')
      nextDetection.confidence = startingType === 'Unknown' ? 'Medium' : nextDetection.confidence
      nextDetection.evidence.push('Upload lane was Purchases, so invoice-style content was treated as purchase-side support.')
      if (!nextDetection.warnings.some((warning) => warning.includes('Purchase upload lane'))) {
        nextDetection.warnings.push('Purchase upload lane overrode a generic sales-side guess.')
      }
    }
    return nextDetection
  }

  if (uploadLane === 'sales') {
    if ((nextDetection.detectedType === 'Unknown' || nextDetection.detectedType === 'Purchase Invoice') && /invoice|receipt|sales|customer/.test(normalizedSource)) {
      nextDetection.detectedType = 'Sales Invoice'
      nextDetection.target = 'WP1'
      nextDetection.suggestedGlAccount = suggestedAccountForType('Sales Invoice')
      nextDetection.confidence = startingType === 'Unknown' ? 'Medium' : nextDetection.confidence
      nextDetection.evidence.push('Upload lane was Sales, so invoice-style content was treated as sales-side support.')
      if (!nextDetection.warnings.some((warning) => warning.includes('Sales upload lane'))) {
        nextDetection.warnings.push('Sales upload lane overrode a generic purchase-side guess.')
      }
    }
    return nextDetection
  }

  if (uploadLane === 'bank') {
    if (nextDetection.detectedType !== 'Bank Statement' && looksBankLike(source)) {
      nextDetection.detectedType = 'Bank Statement'
      nextDetection.target = 'WP2'
      nextDetection.suggestedGlAccount = ''
      nextDetection.confidence = nextDetection.confidence === 'Low' ? 'Medium' : nextDetection.confidence
      nextDetection.evidence.push('Upload lane was Bank, so the document was treated as bank-side support.')
    }
    return nextDetection
  }

  if (uploadLane === 'payments') {
    if (nextDetection.detectedType === 'Unknown' || nextDetection.detectedType === 'Sales Invoice') {
      nextDetection.detectedType = 'Payment Voucher'
      nextDetection.target = 'WP1'
      nextDetection.suggestedGlAccount = suggestedAccountForType('Payment Voucher')
      nextDetection.confidence = nextDetection.confidence === 'Low' ? 'Medium' : nextDetection.confidence
      nextDetection.evidence.push('Upload lane was Payments, so the document was treated as payment-side support.')
    }
    return nextDetection
  }

  return nextDetection
}

const detectType = (fileName: string, text: string, uploadLane: UploadLane = 'auto'): DetectionResult => {
  const content = normalize(`${fileName} ${text.slice(0, 2000)}`)
  const ranked = smartRules
    .map((rule) => {
      const hits = rule.keywords.filter((keyword) => content.includes(keyword))
      return { rule, hits, score: hits.length }
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)

  const best = ranked[0]

  if (best) {
    const confidence = best.score >= 2 ? 'High' : 'Medium'
    const evidence = [`Matched ${best.rule.label}: ${best.hits.join(', ')}`]
    const warnings = confidence === 'Medium' ? ['Only one strong clue found. Review before posting.'] : []

    if (
      ranked[1] &&
      ranked[1].score === best.score &&
      ranked[1].rule.type !== best.rule.type
    ) {
      warnings.push(`Also looked like ${ranked[1].rule.type}.`)
    }

    return applyUploadLaneToDetection({
      detectedType: best.rule.type,
      confidence,
      target: best.rule.target,
      evidence,
      warnings,
      suggestedGlAccount: accountLabel(best.rule.accountCode) || suggestedAccountForType(best.rule.type),
    }, uploadLane, `${fileName} ${text}`)
  }

  return applyUploadLaneToDetection({
    detectedType: 'Unknown',
    confidence: 'Low',
    target: 'WP1',
    evidence: ['No reliable keyword pattern matched.'],
    warnings: ['Imported as a WP1 review item. Choose document type and GL in WP1.'],
    suggestedGlAccount: '',
  }, uploadLane, `${fileName} ${text}`)
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
  const reference = source.match(/\b(?:INV|PV|OR|REC|BILL|PAY|LOAN|CHQ|CN|DN|PG|PL|PF)[-\s]?[A-Z0-9-]{2,}\b/i)
  if (reference) return reference[0].replace(/\s+/g, '-').toUpperCase()
  const compactReference = source.match(/\b[A-Z]{2,4}\d{5,12}\b/)
  if (compactReference) return compactReference[0].toUpperCase()
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

const sourceFileName = (fileName: string) => fileName.replace(/\srow\s\d+$/i, '').trim()
const sourceRowNumber = (fileName: string) => fileName.match(/\srow\s(\d+)$/i)?.[1] ?? ''
const extractBatchSize = 3
const intakeCacheStorageKey = 'bk-intake-cache-v4'

type CachedIntakeItem = Omit<SourceIntakeItem, 'id' | 'uploadedAt' | 'sourcePreview'>

const newIntakeId = () => `INT-${Date.now()}-${Math.random().toString(16).slice(2)}`

const loadIntakeCache = (): Record<string, CachedIntakeItem[]> => {
  try {
    const raw = window.localStorage.getItem(intakeCacheStorageKey)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, CachedIntakeItem[]>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const saveIntakeCache = (cache: Record<string, CachedIntakeItem[]>) => {
  try {
    window.localStorage.setItem(intakeCacheStorageKey, JSON.stringify(cache))
  } catch {
    // ignore cache write failures
  }
}

const clearIntakeCache = () => {
  try {
    window.localStorage.removeItem(intakeCacheStorageKey)
  } catch {
    // ignore cache clear failures
  }
}

const intakeCacheKey = (fingerprint: string, uploadLane: UploadLane, clientEntityName: string) =>
  `${fingerprint}|${uploadLane}|${normalize(clientEntityName)}`

const intakeCacheKeyForUpload = (
  upload: PreparedUpload,
  uploadLane: UploadLane,
  clientEntityName: string,
) => intakeCacheKey(upload.fingerprint, uploadLane, clientEntityName)

const cloneCachedItems = (
  cachedItems: CachedIntakeItem[],
  uploadLane: UploadLane,
  fingerprint: string,
): SourceIntakeItem[] =>
  cachedItems.map((item) => ({
    ...item,
    id: newIntakeId(),
    uploadedAt: new Date().toISOString(),
    uploadLaneHint: uploadLane,
    sourceFingerprint: fingerprint,
  }))

const previewKindForFile = (file: File): NonNullable<SourceIntakeItem['sourcePreview']>['previewKind'] => {
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) return 'pdf'
  if (file.type.startsWith('image/')) return 'image'
  if (isReadableFile(file)) return 'text'
  return 'other'
}

const buildSourcePreview = (file: File): NonNullable<SourceIntakeItem['sourcePreview']> => ({
  fileName: file.name,
  fileType: file.type || 'unknown',
  objectUrl: URL.createObjectURL(file),
  previewKind: previewKindForFile(file),
})

const chunkFiles = <T,>(values: T[], size: number) => {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return window.btoa(binary)
}

const buildJsonExtractPayload = async (files: File[]): Promise<JsonExtractFilePayload[]> =>
  Promise.all(
    files.map(async (file) => ({
      file_name: file.name,
      content_type: file.type || 'application/octet-stream',
      data_base64: arrayBufferToBase64(await file.arrayBuffer()),
    })),
  )

const spreadsheetColumnLabel = (index: number) => {
  let current = index + 1
  let label = ''
  while (current > 0) {
    const remainder = (current - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    current = Math.floor((current - 1) / 26)
  }
  return label
}

const issueSummaryForItem = (item: SourceIntakeItem, clientEntityName = ''): IssueSummary => {
  const warnings = (item.warnings ?? []).map((line) => line.toLowerCase())
  const suspiciousParty = suspiciousPartyIssues(item, clientEntityName)

  if (warnings.some((line) => aiLimitWarningSignals.some((signal) => line.includes(signal)))) {
    return {
      label: 'AI Limit Reached',
      detail: 'The AI provider hit a balance or rate limit, so this file may need manual review or a retry later.',
      focusField: 'type',
    }
  }

  if (item.detectedType === 'Unknown') {
    return {
      label: 'Unknown Type',
      detail: 'The extractor could not confidently classify this row.',
      focusField: 'type',
    }
  }
  if (warnings.some((line) => line.includes('date was not detected'))) {
    return {
      label: 'Missing Date',
      detail: 'Check the extracted posting date against the source row.',
      focusField: 'date',
    }
  }
  if (warnings.some((line) => line.includes('amount was not detected'))) {
    return {
      label: 'Missing Amount',
      detail: 'Confirm the posting amount from the source total column.',
      focusField: 'amount',
    }
  }
  if (warnings.some((line) => line.includes('weak row label') || line.includes('fell back to the file channel'))) {
    return {
      label: 'Weak Description',
      detail: 'The row description was weak or generic. Check the category or outlet.',
      focusField: 'party',
    }
  }
  if (suspiciousParty.length) {
    return {
      label: 'Suspicious Party',
      detail: 'The vendor / customer looks like a placeholder or the client name. Check the source and key the real party before import.',
      focusField: 'party',
    }
  }
  if (!item.suggestedGlAccount.trim()) {
    return {
      label: 'Choose GL',
      detail: 'Select the GL account before importing this row.',
      focusField: 'gl',
    }
  }
  if ((item.fieldConfidence?.party ?? 0) < 0.75) {
    return {
      label: 'Low Description Confidence',
      detail: 'The description may not match the real sales category or channel.',
      focusField: 'party',
    }
  }

  return {
    label: 'Review Row',
    detail: 'Double-check the extracted fields before marking this row ready.',
    focusField: 'party',
  }
}

const itemHasAiLimitWarning = (item: SourceIntakeItem) =>
  (item.warnings ?? []).some((line) => {
    const lowered = line.toLowerCase()
    return aiLimitWarningSignals.some((signal) => lowered.includes(signal))
  })

const focusColumnIndexes = (item: SourceIntakeItem) => {
  const summary = issueSummaryForItem(item)
  const headers = item.rawSource?.headers ?? []
  const candidates =
    summary.focusField === 'amount'
      ? ['net sales', 'total sales', 'amount', 'total', 'gross sales', 'sales']
      : summary.focusField === 'party'
        ? ['category', 'item', 'product', 'description', 'outlet', 'menu']
        : summary.focusField === 'date'
          ? ['date', 'transaction date']
          : summary.focusField === 'reference'
            ? ['reference', 'doc ref', 'document ref', 'invoice', 'ref']
            : summary.focusField === 'type'
              ? ['document type', 'doc type', 'type']
              : ['gl account', 'account']

  return headers
    .map((header, index) => ({ header: normalize(header), index }))
    .filter((entry) => candidates.some((candidate) => entry.header.includes(candidate)))
    .map((entry) => entry.index)
}

const periodMonthLabel = (period: string) => period.split(/\s+/)[0]?.slice(0, 3) || 'Jan'

const fallbackDate = (session: SampleSession) => `01 ${periodMonthLabel(session.client.period)}`

const fallbackReference = (item: SourceIntakeItem, prefix: string) => {
  const cleaned = item.reference.trim() || cleanWords(item.fileName).split(' ').slice(0, 3).join('-').toUpperCase()
  return cleaned || `${prefix}-${item.id.slice(-4).toUpperCase()}`
}

const fallbackParty = (item: SourceIntakeItem) => item.party.trim() || cleanWords(item.fileName) || 'Review source document'

const suspiciousPartyIssues = (item: SourceIntakeItem, clientEntityName = '') => {
  const issues: string[] = []
  const normalizedParty = normalize(item.party)
  const normalizedClient = normalize(clientEntityName)

  if (!normalizedParty) {
    issues.push('vendor / customer')
    return issues
  }

  if (normalizedParty === 'review source document') {
    issues.push('vendor / customer')
  }

  if (normalizedParty === 'xyz co sdn bhd') {
    issues.push('vendor / customer placeholder')
  }

  if (normalizedClient && normalizedParty === normalizedClient && item.target === 'WP1') {
    issues.push('vendor / customer matches client name')
  }

  return Array.from(new Set(issues))
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

const bankVerticalDatePattern = /^\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?$/
const bankAmountOnlyPattern = /^\(?(?:(?:\d{1,3}(?:,\d{3})+)|\d+)\.\d{2}\)?$/

const isBankBalanceMarker = (value: string) => {
  const lowered = normalize(value)
  return (
    lowered.startsWith('balance from last statement') ||
    lowered.startsWith('balance b f') ||
    lowered.startsWith('balance c f') ||
    lowered.startsWith('closing balance in this statement')
  )
}

const isBankLayoutNoise = (value: string) => {
  const lowered = normalize(value)
  if (!lowered) return true
  if (['tarikh', 'urus niaga', 'debit', 'kredit', 'baki', 'date', 'transaction', 'credit', 'balance'].includes(lowered)) {
    return true
  }

  return [
    'page ',
    'muka surat',
    'account number',
    'statement date',
    'account type',
    'penyata ini dicetak',
    'this is a computer generated statement',
    'protected by pidm',
    'dilindungi oleh pidm',
  ].some((token) => lowered.includes(token))
}

const bankDirectionForDescription = (description: string) => {
  const lowered = ` ${normalize(description)} `
  if ([
    ' credit ',
    ' cr ',
    ' deposit ',
    ' money in ',
    ' received ',
    ' transfer in ',
    ' dep merchant ',
    ' dep merchant pymt ',
    ' duitnow qr cr ',
    ' rpp cr ',
  ].some((token) => lowered.includes(token))) {
    return { moneyInFactor: 1, moneyOutFactor: 0 }
  }

  if ([
    ' debit ',
    ' dr ',
    ' withdrawal ',
    ' payment ',
    ' charges ',
    ' bank charge ',
    ' cash out ',
    ' trsf dr ',
  ].some((token) => lowered.includes(token))) {
    return { moneyInFactor: 0, moneyOutFactor: 1 }
  }

  return { moneyInFactor: 0, moneyOutFactor: 1 }
}

const parseBrowserBankStatementRows = (
  text: string,
  file: File,
  uploadedAt: string,
  uploadLane: UploadLane = 'auto',
): SourceIntakeItem[] => {
  if (!looksBankLike(`${file.name} ${text.slice(0, 5000)}`)) return []

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length < 4) return []

  const items: SourceIntakeItem[] = []
  let currentDate = ''
  let pendingDescription: string[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (bankVerticalDatePattern.test(line)) {
      currentDate = extractDate(line)
      pendingDescription = []
      index += 1
      continue
    }

    if (!currentDate) {
      index += 1
      continue
    }

    if (isBankBalanceMarker(line)) {
      if (normalize(line).startsWith('balance c f')) {
        currentDate = ''
        pendingDescription = []
      }
      index += 1
      if (index < lines.length && bankAmountOnlyPattern.test(lines[index])) index += 1
      continue
    }

    if (isBankLayoutNoise(line)) {
      index += 1
      continue
    }

    if (
      bankAmountOnlyPattern.test(line) &&
      index + 1 < lines.length &&
      bankAmountOnlyPattern.test(lines[index + 1])
    ) {
      const transactionAmount = parseAmount(line)
      index += 2
      const descriptionParts = [...pendingDescription]
      pendingDescription = []

      while (index < lines.length) {
        const candidate = lines[index].trim()
        if (!candidate) {
          index += 1
          continue
        }
        if (bankVerticalDatePattern.test(candidate) || isBankBalanceMarker(candidate)) break
        if (
          bankAmountOnlyPattern.test(candidate) &&
          index + 1 < lines.length &&
          bankAmountOnlyPattern.test(lines[index + 1])
        ) break
        if (isBankLayoutNoise(candidate)) {
          index += 1
          continue
        }
        descriptionParts.push(candidate)
        index += 1
      }

      const description = descriptionParts.join(' ').replace(/\s+/g, ' ').trim()
      if (!description || transactionAmount <= 0) continue

      const { moneyInFactor, moneyOutFactor } = bankDirectionForDescription(description)
      const moneyIn = transactionAmount * moneyInFactor
      const moneyOut = transactionAmount * moneyOutFactor

      items.push({
        id: `INT-${Date.now()}-${items.length + 1}`,
        fileName: `${file.name} row ${items.length + 1}`,
        fileType: file.type || 'application/pdf',
        fileSize: file.size,
        uploadedAt,
        detectedType: 'Bank Statement',
        confidence: 'Medium',
        status: 'Accepted',
        target: 'WP2',
        date: currentDate,
        reference: extractReference(description, file.name),
        party: description.slice(0, 120),
        amount: transactionAmount,
        moneyIn,
        moneyOut,
        suggestedGlAccount: '',
        notes: 'Detected from embedded PDF bank statement text recovered in-browser after the server upload failed.',
        evidence: ['Detected bank statement row pattern from embedded PDF text recovered in-browser.'],
        warnings: [],
        rawPreview: `${currentDate} ${description}`.slice(0, 240),
        extractionMethod: 'browser-bank-text-fallback',
        uploadLaneHint: uploadLane,
      })

      if (items.length >= 600) break
      continue
    }

    pendingDescription.push(line)
    if (pendingDescription.length > 4) pendingDescription = pendingDescription.slice(-4)
    index += 1
  }

  return items
}

const parseTabularRows = (text: string, file: File, uploadedAt: string, uploadLane: UploadLane = 'auto'): SourceIntakeItem[] => {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length < 2) return []

  const delimiter = lines[0].includes('\t') ? '\t' : ','
  const rawHeaders = splitDelimitedLine(lines[0], delimiter)
  const headers = rawHeaders.map((header) => normalize(header))
  const headerText = headers.join(' ')
  const looksLikeBank = /money in|deposit|credit|money out|withdrawal|debit|bank description|balance/.test(headerText)
  const looksLikeSalesSummary =
    /sales/.test(headerText) &&
    (/category|gross|net|discount|qty|quantity|receipt|transaction/.test(headerText) ||
      /sales by category|daily sales|sales report|pos sales/i.test(file.name))
  const looksLikeDoc = /document|doc ref|vendor|customer|party|invoice|amount/.test(headerText)

  if (!looksLikeBank && !looksLikeDoc && !looksLikeSalesSummary) return []

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
    const actualRowNumber = index + 2
    const contextStart = Math.max(1, index - 1)
    const contextRows = lines
      .slice(contextStart, Math.min(lines.length, index + 4))
      .map((contextLine, contextIndex) => ({
        rowNumber: contextStart + contextIndex + 1,
        cells: splitDelimitedLine(contextLine, delimiter),
      }))
    const detection: DetectionResult = looksLikeBank
      ? {
          detectedType: 'Bank Statement',
          confidence: 'High',
          target: 'WP2',
          evidence: ['Detected bank-style columns in uploaded file.'],
          warnings: [],
          suggestedGlAccount: '',
        }
      : looksLikeSalesSummary
        ? {
            detectedType: 'Sales Summary',
            confidence: 'High',
            target: 'WP1',
            evidence: ['Detected sales-summary style columns in uploaded file.'],
            warnings: [],
            suggestedGlAccount: suggestedAccountForType('Sales Summary'),
          }
      : detectType(`${file.name} ${cells[typeIndex] ?? ''}`, rowText, uploadLane)
    const typeFromRow = cells[typeIndex] as IntakeDocumentType | undefined
    const detectedType = typeFromRow && intakeTypes.includes(typeFromRow) ? typeFromRow : detection.detectedType
    const signedAmount = amountIndex >= 0 ? parseSignedAmount(cells[amountIndex] ?? '') : { amount: extractLargestAmount(rowText), direction: 'IN' as const }
    const explicitMoneyIn = moneyInIndex >= 0 ? parseAmount(cells[moneyInIndex] ?? '') : 0
    const explicitMoneyOut = moneyOutIndex >= 0 ? parseAmount(cells[moneyOutIndex] ?? '') : 0
    const amount = Math.max(signedAmount.amount, explicitMoneyIn, explicitMoneyOut)
    const moneyIn =
      explicitMoneyIn ||
      (detection.target === 'WP2' && explicitMoneyOut === 0 && signedAmount.direction === 'IN' ? amount : 0)
    const moneyOut =
      explicitMoneyOut ||
      (detection.target === 'WP2' && signedAmount.direction === 'OUT' ? amount : 0)
    const warnings = [
      ...detection.warnings,
      !cells[dateIndex] && !extractDate(rowText) ? 'Date was not detected.' : '',
      amount <= 0 ? 'Amount was not detected.' : '',
      typeFromRow && !intakeTypes.includes(typeFromRow) ? `Unknown document type from file: ${typeFromRow}` : '',
    ].filter(Boolean)

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
      suggestedGlAccount: cells[glIndex] || detection.suggestedGlAccount || suggestedAccountForType(detectedType),
      notes: cells[notesIndex] || 'Imported from uploaded spreadsheet/CSV.',
      evidence: detection.evidence,
      warnings,
      rawPreview: rowText.slice(0, 240),
      extractionMethod: 'browser-tabular-fallback',
      uploadLaneHint: uploadLane,
      rawSource: {
        fileName: file.name,
        headerRowNumber: 1,
        rowNumber: actualRowNumber,
        headers: rawHeaders,
        cells,
        contextRows,
      },
    }
  })
}

const buildIntakeItemsForFile = async (
  file: File,
  uploadLane: UploadLane = 'auto',
  clientEntityName = '',
): Promise<SourceIntakeItem[]> => {
  const uploadedAt = new Date().toISOString()
  const pdfText = await readPdfText(file)
  const text = pdfText || await readFileText(file)
  if (pdfText && looksBankLike(`${file.name} ${text.slice(0, 5000)}`)) {
    const browserBankRows = parseBrowserBankStatementRows(text, file, uploadedAt, uploadLane)
    if (browserBankRows.length) return browserBankRows
  }
  const tabularRows = parseTabularRows(text, file, uploadedAt, uploadLane)
  if (tabularRows.length) return tabularRows

  const detection = detectType(`${file.name} ${clientEntityName}`, text, uploadLane)
  const source = `${file.name} ${text.slice(0, 2000)}`
  const amount = extractLargestAmount(source)
  const reference = extractReference(source, file.name)
  const detectedType = detection.detectedType
  const detectedDate = extractDate(source)
  const browserPdfRecovered = Boolean(pdfText)
  const genericBankStatementFallback = detectedType === 'Bank Statement'
  const hasStructuredFallbackFields =
    browserPdfRecovered &&
    detectedType !== 'Unknown' &&
    Boolean(detectedDate) &&
    amount > 0 &&
    Boolean(reference) &&
    !genericBankStatementFallback
  const warnings = [
    ...detection.warnings,
    !detectedDate ? 'Date was not detected.' : '',
    amount <= 0 ? 'Amount was not detected.' : '',
    genericBankStatementFallback
      ? 'Bank statement fallback could not split this PDF into transaction rows, so it stayed in review instead of auto-importing a fake summary row.'
      : '',
    !text && !isReadableFile(file) && !isPdfFile(file) ? 'File content was not readable in-browser. Review downstream fields.' : '',
    pdfText ? 'Backend upload failed, but embedded PDF text was recovered in-browser.' : '',
    isPdfFile(file) && !pdfText ? 'Embedded PDF text could not be recovered in-browser, so this file stayed in manual review mode.' : '',
  ].filter(Boolean)

  return [
    {
      id: newIntakeId(),
      fileName: file.name,
      fileType: file.type || 'unknown',
      fileSize: file.size,
      uploadedAt,
      detectedType,
      confidence: detection.confidence,
      status: hasStructuredFallbackFields ? 'Accepted' : 'Needs Review',
      target: detection.target,
      date: detectedDate,
      reference,
      party: cleanWords(file.name),
      amount: genericBankStatementFallback ? 0 : amount,
      moneyIn: detection.target === 'WP2' && !genericBankStatementFallback ? amount : 0,
      moneyOut: 0,
      suggestedGlAccount: detection.suggestedGlAccount || suggestedAccountForType(detectedType),
      notes: pdfText
        ? 'Detected from embedded PDF text recovered in-browser after the server upload failed.'
        : text
          ? 'Detected from readable file content.'
          : 'Detected from file name. Review fields before importing.',
      evidence: detection.evidence,
      warnings,
      rawPreview: text.slice(0, 240),
      extractionMethod: pdfText
        ? 'browser-pdf-text-fallback'
        : text
          ? 'browser-text-fallback'
          : 'browser-filename-fallback',
      uploadLaneHint: uploadLane,
    },
  ]
}

const extractFilesWithBackend = async (
  files: File[],
  uploadLane: UploadLane = 'auto',
  clientEntityName = '',
): Promise<SourceIntakeItem[]> => {
  const requestPayload = {
    files: await buildJsonExtractPayload(files),
    upload_lane: uploadLane,
    client_entity_name: clientEntityName,
  }

  const response = await fetch(`${apiBaseUrl()}/intake/extract-json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestPayload),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`extract-failed:${response.status}:${detail}`)
  }

  const responsePayload = (await response.json()) as ExtractResponse
  if (!Array.isArray(responsePayload.items)) throw new Error('extract-invalid')
  return responsePayload.items
}

const attachSourcePreviews = (
  nextItems: SourceIntakeItem[],
  previewByKey: Map<string, SourceIntakeItem['sourcePreview']>,
  previewByFingerprint?: Map<string, SourceIntakeItem['sourcePreview']>,
) =>
  nextItems.map((item) => ({
    ...item,
    sourcePreview:
      previewByKey.get(sourceFingerprintKey(sourceFileName(item.fileName), item.fileSize))
      || (previewByFingerprint && item.sourceFingerprint ? previewByFingerprint.get(item.sourceFingerprint) : undefined)
      || item.sourcePreview,
  }))

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
  ['Sales Invoice', 'Sales Summary', 'Receipt', 'Merchant Statement'].includes(docType) ? 'IN' : 'OUT'

const sourceDocumentFromIntake = (item: SourceIntakeItem, id: string, session: SampleSession): SourceDocument => {
  const docType = documentTypes.includes(item.detectedType as DocumentType)
    ? (item.detectedType as DocumentType)
    : 'Purchase Invoice'
  const amount = Number(item.amount || 0)
  const glAccount = item.suggestedGlAccount.trim()
  const hasRequiredFields = amount > 0 && glAccount.trim() && item.date.trim() && item.reference.trim()
  const needsReview = item.status !== 'Accepted' || !hasRequiredFields
  const note = [
    item.notes.trim(),
    item.extractionMethod ? `Extractor: ${item.extractionMethod}.` : '',
    ...(item.evidence ?? []),
    ...(item.warnings ?? []),
  ]
    .filter(Boolean)
    .join(' ')

  return {
    id,
    date: item.date.trim() || fallbackDate(session),
    docRef: fallbackReference(item, 'DOC'),
    party: fallbackParty(item),
    docType,
    amount,
    flow: flowForDocumentType(docType),
    glAccount,
    status: needsReview ? 'Pending Review' : 'Posted',
    note: needsReview
      ? `Imported from source intake. Review before posting. ${note}`.trim()
      : note || undefined,
  }
}

const bankRowFromIntake = (item: SourceIntakeItem, id: string, session: SampleSession): BankRow => {
  const moneyIn = Number(item.moneyIn || 0)
  const moneyOut = Number(item.moneyOut || 0)
  const direction = moneyIn > 0 ? 'CR' : 'DR'
  const amount = moneyIn > 0 ? moneyIn : moneyOut || Number(item.amount || 0)
  const hasWeakFields = item.status !== 'Accepted' || amount <= 0 || !item.date.trim()
  const rowDecision = classifyImportedBankRow(
    session.documents,
    {
      date: item.date.trim() || fallbackDate(session),
      description: fallbackParty(item),
      reference: fallbackReference(item, 'BANK'),
      amount,
      direction,
    },
    hasWeakFields,
  )
  const details = [
    item.notes.trim(),
    item.extractionMethod ? `Extractor: ${item.extractionMethod}.` : '',
    ...(item.evidence ?? []),
    ...(item.warnings ?? []),
  ]
    .filter(Boolean)
    .join(' ')

  return {
    id,
    date: item.date.trim() || fallbackDate(session),
    description: fallbackParty(item),
    reference: fallbackReference(item, 'BANK'),
    amount,
    direction,
    status: rowDecision.status,
    suggestedDocumentIds: rowDecision.suggestedDocumentIds,
    matchedTo: rowDecision.matchedTo,
    remarks: [rowDecision.remarks, details].filter(Boolean).join(' ').trim(),
  }
}

const importReadinessIssues = (item: SourceIntakeItem, clientEntityName = '') => {
  if (item.status !== 'Accepted') return ['Row is not marked ready yet.']
  if (item.target === 'Ignore') return ['Ignored rows are excluded from import.']

  if (item.target === 'WP2') {
    const amount = Number(item.moneyIn || 0) || Number(item.moneyOut || 0) || Number(item.amount || 0)
    const issues: string[] = []
    if (!item.date.trim()) issues.push('date')
    if (amount <= 0) issues.push('money in / money out')
    return issues
  }

  const issues: string[] = []
  if (!item.date.trim()) issues.push('date')
  if (!item.reference.trim()) issues.push('reference')
  issues.push(...suspiciousPartyIssues(item, clientEntityName))
  if (!item.suggestedGlAccount.trim()) issues.push('GL account')
  if (Number(item.amount || 0) <= 0) issues.push('amount')
  return Array.from(new Set(issues))
}

const canImportReady = (item: SourceIntakeItem, clientEntityName = '') =>
  importReadinessIssues(item, clientEntityName).length === 0

const sourceFingerprintKey = (fileName: string, fileSize: number) => `${fileName.toLowerCase()}|${fileSize}`
const sourceIdentityKey = (item: SourceIntakeItem) =>
  sourceFingerprintKey(item.rawSource?.fileName || sourceFileName(item.fileName), item.fileSize)
const sourceIdentityKeyForUpload = (upload: PreparedUpload) =>
  sourceFingerprintKey(upload.file.name, upload.file.size)
const itemMatchesUpload = (item: SourceIntakeItem, upload: PreparedUpload) =>
  item.sourceFingerprint === upload.fingerprint || sourceIdentityKey(item) === sourceIdentityKeyForUpload(upload)

const FAMILY_METADATA: Record<
  Exclude<IntakeFamily, 'all'>,
  Pick<FamilySummary, 'label' | 'description' | 'tone'>
> = {
  sales: {
    label: 'Sales',
    description: 'Sales summaries, sales invoices, receipts, and merchant settlements.',
    tone: 'green',
  },
  purchases: {
    label: 'Purchases',
    description: 'Supplier invoices and purchase-side support docs.',
    tone: 'blue',
  },
  payments: {
    label: 'Payments',
    description: 'Payment vouchers, utilities, and expense support.',
    tone: 'purple',
  },
  bank: {
    label: 'Bank',
    description: 'Bank statements and bank-style transaction imports.',
    tone: 'teal',
  },
  payroll_loans: {
    label: 'Payroll & Loans',
    description: 'Payroll summaries, loan statements, and HP support.',
    tone: 'neutral',
  },
  needs_attention: {
    label: 'Needs Attention',
    description: 'Unknown or mixed documents that still need classification.',
    tone: 'orange',
  },
}

const intakeFamilyForType = (type: IntakeDocumentType): Exclude<IntakeFamily, 'all'> => {
  switch (type) {
    case 'Sales Invoice':
    case 'Sales Summary':
    case 'Receipt':
    case 'Merchant Statement':
      return 'sales'
    case 'Purchase Invoice':
      return 'purchases'
    case 'Payment Voucher':
    case 'Utility Bill':
      return 'payments'
    case 'Bank Statement':
      return 'bank'
    case 'Payroll Summary':
    case 'Loan / HP Statement':
      return 'payroll_loans'
    case 'Unknown':
    default:
      return 'needs_attention'
  }
}

const intakeFamilyForItem = (item: SourceIntakeItem): Exclude<IntakeFamily, 'all'> => intakeFamilyForType(item.detectedType)
const intakeFamilyMeta = (family: IntakeFamily) =>
  family === 'all'
    ? { label: 'All Documents', description: 'Every uploaded file together.', tone: 'neutral' as const }
    : FAMILY_METADATA[family]

const uploadQueueForFile = (file: FileSummary): IntakeWorkspace => {
  const completedCount = file.importedCount + file.ignoredCount
  const allCompleted = completedCount > 0 && completedCount === file.items.length
  if (allCompleted) return 'completed'
  if (file.family === 'bank') return 'bank'
  if (file.family === 'needs_attention') return 'unclassified'
  if (file.reviewCount > 0 && file.acceptedCount > 0) return 'mixed'
  if (file.reviewCount > 0) return 'unclassified'
  if (file.acceptedCount > 0) return 'clean'
  return 'unclassified'
}

export function SourceDocumentIntake({ session, onSessionChange, onStepChange }: SourceDocumentIntakeProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [pendingUploadLane, setPendingUploadLane] = useState<UploadLane>('purchases')
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([])
  const [extracting, setExtracting] = useState(false)
  const [extractMessage, setExtractMessage] = useState<string | null>(null)
  const [extractMessageType, setExtractMessageType] = useState<'ok' | 'warning' | 'alert'>('ok')
  const [extractDiagnostics, setExtractDiagnostics] = useState<ExtractDiagnostics | null>(null)
  const [activeWorkspace, setActiveWorkspace] = useState<IntakeWorkspace>('unclassified')
  const [activeFamilyFilter, setActiveFamilyFilter] = useState<IntakeFamily>('all')
  const [activeFileFilter, setActiveFileFilter] = useState<string>('all')
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null)
  const [showFileRows, setShowFileRows] = useState(false)
  const [rawViewerItemId, setRawViewerItemId] = useState<string | null>(null)
  const reviewPanelRef = useRef<HTMLElement | null>(null)
  const acceptedPanelRef = useRef<HTMLElement | null>(null)
  const fileRowRefs = useRef<Record<string, HTMLTableRowElement | null>>({})
  const previewObjectUrlsRef = useRef<Set<string>>(new Set())
  const ownerDiagnosticsEnabled = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    return params.has('owner-debug') || params.has('debug-intake')
  }, [])
  const items = session.sourceIntakeItems
  const aiLimitItems = useMemo(() => items.filter(itemHasAiLimitWarning), [items])
  const aiLimitFileCount = useMemo(
    () => new Set(aiLimitItems.map((item) => sourceFileName(item.fileName))).size,
    [aiLimitItems],
  )
  const currentClientEntityName = session.client.entityName
  const trackPreviewObjectUrl = (objectUrl: string) => {
    if (objectUrl.startsWith('blob:')) {
      previewObjectUrlsRef.current.add(objectUrl)
    }
    return objectUrl
  }
  const buildTrackedSourcePreview = (file: File): NonNullable<SourceIntakeItem['sourcePreview']> => {
    const preview = buildSourcePreview(file)
    return {
      ...preview,
      objectUrl: trackPreviewObjectUrl(preview.objectUrl),
    }
  }
  const acceptedWp1 = items.filter((item) => item.status === 'Accepted' && item.target === 'WP1')
  const acceptedWp2 = items.filter((item) => item.status === 'Accepted' && item.target === 'WP2')
  const importableWp1 = items.filter((item) => canImportReady(item, currentClientEntityName) && item.target === 'WP1')
  const importableWp2 = items.filter((item) => canImportReady(item, currentClientEntityName) && item.target === 'WP2')
  const importableItems = [...importableWp1, ...importableWp2]
  const hasCompletedImports = items.some((item) => item.status === 'Imported')
  const acceptedButBlockedCount = items.filter(
    (item) => item.status === 'Accepted' && item.target !== 'Ignore' && !canImportReady(item, currentClientEntityName),
  ).length

  const fileSummaries = useMemo<FileSummary[]>(() => {
    const grouped = new Map<string, FileSummary>()
    for (const item of items) {
      const key = sourceFileName(item.fileName)
      const family = intakeFamilyForItem(item)
      const current = grouped.get(key)
      if (current) {
        current.items.push(item)
        current.amountTotal += Number(item.amount || 0)
        current.acceptedCount += item.status === 'Accepted' ? 1 : 0
        current.reviewCount += item.status === 'Needs Review' ? 1 : 0
        current.importedCount += item.status === 'Imported' ? 1 : 0
        current.ignoredCount += item.status === 'Ignored' ? 1 : 0
        current.primaryType = current.primaryType === 'Unknown' && item.detectedType !== 'Unknown' ? item.detectedType : current.primaryType
        if (!current.firstReviewId && item.status === 'Needs Review') current.firstReviewId = item.id
      } else {
        grouped.set(key, {
          name: key,
          items: [item],
          amountTotal: Number(item.amount || 0),
          acceptedCount: item.status === 'Accepted' ? 1 : 0,
          reviewCount: item.status === 'Needs Review' ? 1 : 0,
          importedCount: item.status === 'Imported' ? 1 : 0,
          ignoredCount: item.status === 'Ignored' ? 1 : 0,
          firstReviewId: item.status === 'Needs Review' ? item.id : undefined,
          primaryType: item.detectedType,
          family,
        })
      }
    }
    return Array.from(grouped.values()).sort((a, b) => {
      if (b.reviewCount !== a.reviewCount) return b.reviewCount - a.reviewCount
      return a.name.localeCompare(b.name)
    })
  }, [items])

  const queueSummaries = useMemo<QueueSummary[]>(() => {
    const buckets: Record<IntakeWorkspace, QueueSummary> = {
      unclassified: {
        id: 'unclassified',
        label: 'Unclassified Uploads',
        uploads: 0,
        records: 0,
        acceptedRecords: 0,
        reviewRecords: 0,
        importedRecords: 0,
        description: 'Unknown documents, fallback PDFs, or uploads that still need manual classification.',
        tone: 'orange',
      },
      mixed: {
        id: 'mixed',
        label: 'Mixed Uploads',
        uploads: 0,
        records: 0,
        acceptedRecords: 0,
        reviewRecords: 0,
        importedRecords: 0,
        description: 'Uploads with both accepted records and a smaller set of exceptions to review.',
        tone: 'purple',
      },
      clean: {
        id: 'clean',
        label: 'Clean Uploads',
        uploads: 0,
        records: 0,
        acceptedRecords: 0,
        reviewRecords: 0,
        importedRecords: 0,
        description: 'Uploads that look clean enough for a light spot-check before import.',
        tone: 'green',
      },
      bank: {
        id: 'bank',
        label: 'Bank Uploads',
        uploads: 0,
        records: 0,
        acceptedRecords: 0,
        reviewRecords: 0,
        importedRecords: 0,
        description: 'Bank statements and bank-style files that should feed into WP2 handling.',
        tone: 'blue',
      },
      completed: {
        id: 'completed',
        label: 'Completed',
        uploads: 0,
        records: 0,
        acceptedRecords: 0,
        reviewRecords: 0,
        importedRecords: 0,
        description: 'Uploads whose extracted records were already imported or intentionally skipped.',
        tone: 'teal',
      },
    }

    for (const file of fileSummaries) {
      const queue = uploadQueueForFile(file)
      const bucket = buckets[queue]
      bucket.uploads += 1
      bucket.records += file.items.length
      bucket.acceptedRecords += file.acceptedCount
      bucket.reviewRecords += file.reviewCount
      bucket.importedRecords += file.importedCount + file.ignoredCount
    }

    return [
      buckets.unclassified,
      buckets.mixed,
      buckets.clean,
      buckets.bank,
      buckets.completed,
    ]
  }, [fileSummaries])

  const queueSummaryMap = useMemo(
    () =>
      Object.fromEntries(queueSummaries.map((summary) => [summary.id, summary])) as Record<IntakeWorkspace, QueueSummary>,
    [queueSummaries],
  )

  const workspaceFamilySummaries = useMemo(() => {
    const filesInQueue = fileSummaries.filter((file) => uploadQueueForFile(file) === activeWorkspace)
    const grouped = new Map<Exclude<IntakeFamily, 'all'>, FamilySummary>()

    for (const file of filesInQueue) {
      const current = grouped.get(file.family)
      if (current) {
        current.rows += file.items.length
        current.files += 1
        current.reviewCount += file.reviewCount
        current.acceptedCount += file.acceptedCount
        current.importedCount += file.importedCount
        if (!current.firstReviewId && file.firstReviewId) current.firstReviewId = file.firstReviewId
      } else {
        const metadata = FAMILY_METADATA[file.family]
        grouped.set(file.family, {
          id: file.family,
          label: metadata.label,
          description: metadata.description,
          rows: file.items.length,
          files: 1,
          reviewCount: file.reviewCount,
          acceptedCount: file.acceptedCount,
          importedCount: file.importedCount,
          firstReviewId: file.firstReviewId,
          tone: metadata.tone,
        })
      }
    }

    return Array.from(grouped.values()).sort((left, right) => {
      if (right.reviewCount !== left.reviewCount) return right.reviewCount - left.reviewCount
      return left.label.localeCompare(right.label)
    })
  }, [activeWorkspace, fileSummaries])

  const visibleFileSummaries = useMemo(
    () =>
      fileSummaries.filter((file) => {
        const matchesFamily = activeFamilyFilter === 'all' || file.family === activeFamilyFilter
        return matchesFamily && uploadQueueForFile(file) === activeWorkspace
      }),
    [activeFamilyFilter, activeWorkspace, fileSummaries],
  )

  const reviewItems = useMemo(
    () =>
      items.filter((item) => {
        const matchesFamily = activeFamilyFilter === 'all' || intakeFamilyForItem(item) === activeFamilyFilter
        const matchesFile = activeFileFilter === 'all' || sourceFileName(item.fileName) === activeFileFilter
        return matchesFamily && matchesFile && item.status === 'Needs Review'
      }),
    [activeFamilyFilter, items, activeFileFilter],
  )

  const selectedReviewIssueId = useMemo(
    () => reviewItems.find((item) => item.id === selectedIssueId)?.id ?? reviewItems[0]?.id ?? null,
    [reviewItems, selectedIssueId],
  )
  const selectedIssue = useMemo(
    () => reviewItems.find((item) => item.id === selectedReviewIssueId) ?? null,
    [reviewItems, selectedReviewIssueId],
  )
  const rawViewerItem = useMemo(
    () => items.find((item) => item.id === rawViewerItemId) ?? null,
    [items, rawViewerItemId],
  )

  const selectedIssueIndex = selectedIssue ? reviewItems.findIndex((item) => item.id === selectedIssue.id) : -1
  const selectedIssueSummary = selectedIssue ? issueSummaryForItem(selectedIssue, currentClientEntityName) : null
  const selectedIssueImportIssues = selectedIssue ? importReadinessIssues(selectedIssue, currentClientEntityName) : []
  const focusedFileName =
    selectedIssue
      ? sourceFileName(selectedIssue.fileName)
      : activeFileFilter !== 'all'
        ? activeFileFilter
        : visibleFileSummaries[0]?.name ?? 'all'
  const focusedFileSummary = visibleFileSummaries.find((file) => file.name === focusedFileName) ?? null
  const focusedFileRows = useMemo(
    () =>
      items.filter((item) => {
        const matchesFamily = activeFamilyFilter === 'all' || intakeFamilyForItem(item) === activeFamilyFilter
        return matchesFamily && sourceFileName(item.fileName) === focusedFileName
      }),
    [activeFamilyFilter, items, focusedFileName],
  )
  const focusedFileMissingAmounts = focusedFileRows.filter((item) => Number(item.amount || 0) <= 0).length
  const focusedFileDetectedTotal = focusedFileRows.reduce((sum, item) => sum + Number(item.amount || 0), 0)
  const previewableItemForSource = (item: SourceIntakeItem) =>
    items.find(
      (candidate) =>
        sourceFileName(candidate.fileName) === sourceFileName(item.fileName) && Boolean(candidate.rawSource || candidate.sourcePreview),
    ) ?? item

  const canOpenItemSource = (item: SourceIntakeItem) => {
    const candidate = previewableItemForSource(item)
    return Boolean(candidate.rawSource || candidate.sourcePreview || candidate.sourceFingerprint || item.sourceFingerprint)
  }

  const ensureItemSourcePreview = async (item: SourceIntakeItem) => {
    if (item.rawSource || item.sourcePreview) return item

    const fingerprint = item.sourceFingerprint
    if (!fingerprint) return item

    const restoredFile = await loadSourcePreviewFile(fingerprint)
    if (!restoredFile) return item

    const restoredPreview = buildTrackedSourcePreview(restoredFile)
    onSessionChange((current) => ({
      ...current,
      sourceIntakeItems: current.sourceIntakeItems.map((candidate) =>
        candidate.sourceFingerprint === fingerprint
          || sourceFileName(candidate.fileName) === sourceFileName(item.fileName)
          ? {
              ...candidate,
              sourcePreview: restoredPreview,
            }
          : candidate,
      ),
    }))

    return {
      ...item,
      sourcePreview: restoredPreview,
    }
  }

  const openItemSourcePreview = async (item: SourceIntakeItem, issueLabel?: string) => {
    const previewableItem = previewableItemForSource(item)
    const hydratedItem = await ensureItemSourcePreview(previewableItem)
    if (!hydratedItem.rawSource && !hydratedItem.sourcePreview) return
    telemetryEvent('intake_raw_source_opened', {
      doc_type: hydratedItem.detectedType,
      target: hydratedItem.target,
      issue_label: issueLabel ?? issueSummaryForItem(hydratedItem, currentClientEntityName).label,
    })
    setRawViewerItemId(hydratedItem.id)
  }

  const openExtractedRowsForFile = (fileName: string, family: IntakeFamily) => {
    setActiveFamilyFilter(family)
    setActiveFileFilter(fileName)
    setShowFileRows(true)
    window.setTimeout(() => {
      acceptedPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 0)
  }

  useEffect(() => {
    if (selectedReviewIssueId && reviewPanelRef.current) {
      reviewPanelRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [selectedReviewIssueId])

  useEffect(() => {
    if (showFileRows && selectedReviewIssueId) {
      const target = fileRowRefs.current[selectedReviewIssueId]
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }
  }, [showFileRows, selectedReviewIssueId])

  useEffect(() => {
    if (!selectedIssue) return
    const timer = window.setTimeout(() => {
      telemetryIssue('intake_issue_possible_stuck', {
        issue_label: issueSummaryForItem(selectedIssue, currentClientEntityName).label,
        doc_type: selectedIssue.detectedType,
        row_status: selectedIssue.status,
        target: selectedIssue.target,
      })
    }, 2 * 60 * 1000)

    return () => window.clearTimeout(timer)
  }, [currentClientEntityName, selectedIssue])

  useEffect(() => () => {
    for (const objectUrl of previewObjectUrlsRef.current) {
      URL.revokeObjectURL(objectUrl)
    }
    previewObjectUrlsRef.current.clear()
  }, [])

  const updateItem = (itemId: string, patch: IntakePatch) => {
    onSessionChange((current) => ({
      ...current,
      sourceIntakeItems: current.sourceIntakeItems.map((item) =>
        item.id === itemId ? { ...item, ...patch, status: item.status === 'Imported' ? item.status : patch.status ?? item.status } : item,
      ),
      journalVoucherReady: false,
    }))
  }

  const resetSavedIntakeCache = () => {
    clearIntakeCache()
    void clearSourcePreviewStore()
    for (const objectUrl of previewObjectUrlsRef.current) {
      URL.revokeObjectURL(objectUrl)
    }
    previewObjectUrlsRef.current.clear()
    setExtractMessageType('warning')
    setExtractMessage('Saved intake cache cleared. Re-upload the files to force a fresh extraction pass.')
    setExtractDiagnostics(null)
    telemetryEvent('intake_cache_cleared')
  }

  const resetSessionData = () => {
    const confirmed = window.confirm('Start a fresh BK test session? This clears the current Intake, WP1, and WP2 data in this browser session.')
    if (!confirmed) return

    clearIntakeCache()
    void clearSourcePreviewStore()
    for (const objectUrl of previewObjectUrlsRef.current) {
      URL.revokeObjectURL(objectUrl)
    }
    previewObjectUrlsRef.current.clear()
    onSessionChange((current) => createBlankBkTestSession(current))
    setExtractMessageType('warning')
    setExtractMessage('Fresh session started. Upload the files again to test the latest parser end-to-end.')
    setExtractDiagnostics(null)
    setActiveWorkspace('unclassified')
    setActiveFamilyFilter('all')
    setActiveFileFilter('all')
    setSelectedIssueId(null)
    setShowFileRows(false)
    setRawViewerItemId(null)
    telemetryEvent('intake_session_reset')
  }

  const handleFiles = async (fileList: File[] | FileList | null, uploadLane: UploadLane = 'auto') => {
    const files = Array.from(fileList ?? [])
    if (!files.length) return
    setExtracting(true)
    setExtractMessage(null)
    setExtractDiagnostics(null)

    telemetryEvent('intake_upload_started', {
      file_count: files.length,
      upload_lane: uploadLane,
    })

    const existingFingerprints = new Set(items.map((item) => item.sourceFingerprint).filter(Boolean))
    const existingIdentityKeys = new Set(items.map(sourceIdentityKey))
    const preparedUploads = await Promise.all(
      files.map(async (file) => ({
        file,
        fingerprint: await buildFileFingerprint(file),
      })),
    )

    const seenBatchFingerprints = new Set<string>()
    const seenBatchIdentityKeys = new Set<string>()
    const freshUploads: PreparedUpload[] = []
    const replacementUploads: PreparedUpload[] = []
    const duplicateUploads: PreparedUpload[] = []

    for (const prepared of preparedUploads) {
      const identityKey = sourceIdentityKeyForUpload(prepared)
      if (seenBatchFingerprints.has(prepared.fingerprint) || seenBatchIdentityKeys.has(identityKey)) {
        duplicateUploads.push(prepared)
        continue
      }
      seenBatchFingerprints.add(prepared.fingerprint)
      seenBatchIdentityKeys.add(identityKey)
      if (existingFingerprints.has(prepared.fingerprint) || existingIdentityKeys.has(identityKey)) {
        replacementUploads.push(prepared)
      } else {
        freshUploads.push(prepared)
      }
    }

    const uniqueUploads = [...freshUploads, ...replacementUploads]

    if (duplicateUploads.length || replacementUploads.length) {
      telemetryEvent('intake_duplicates_skipped', {
        duplicate_files: duplicateUploads.length,
        new_files: uniqueUploads.length,
        replacement_files: replacementUploads.length,
      })
    }

    if (!uniqueUploads.length) {
      setExtractMessageType('warning')
      setExtractMessage(`Skipped ${duplicateUploads.length} duplicate file(s). No new files were added to this session.`)
      setExtracting(false)
      return
    }

    await Promise.all(uniqueUploads.map((upload) => saveSourcePreviewFile(upload.fingerprint, upload.file)))

    const extractionCache = loadIntakeCache()
    const nextExtractionCache = { ...extractionCache }
    for (const upload of replacementUploads) {
      delete nextExtractionCache[intakeCacheKeyForUpload(upload, uploadLane, session.client.entityName)]
    }
    if (replacementUploads.length) {
      saveIntakeCache(nextExtractionCache)
    }
    const cachedUploads: Array<{ upload: PreparedUpload; items: SourceIntakeItem[] }> = []
    const uncachedUploads: PreparedUpload[] = []

    for (const upload of uniqueUploads) {
      const cacheKey = intakeCacheKeyForUpload(upload, uploadLane, session.client.entityName)
      const cachedItems = nextExtractionCache[cacheKey]
      if (cachedItems?.length) {
        cachedUploads.push({
          upload,
          items: cloneCachedItems(cachedItems, uploadLane, upload.fingerprint),
        })
      } else {
        uncachedUploads.push(upload)
      }
    }

    const filesToProcess = uncachedUploads.map((upload) => upload.file)
    const fingerprintByKey = new Map(
      uniqueUploads.map((upload) => [sourceFingerprintKey(upload.file.name, upload.file.size), upload.fingerprint]),
    )
    const uploadPreviewEntries = uniqueUploads.map((upload) => ({
      upload,
      preview: buildTrackedSourcePreview(upload.file),
    }))
    const previewByKey = new Map(
      uploadPreviewEntries.map(({ upload, preview }) => [
        sourceFingerprintKey(upload.file.name, upload.file.size),
        preview,
      ]),
    )
    const previewByFingerprint = new Map(
      uploadPreviewEntries.map(({ upload, preview }) => [upload.fingerprint, preview]),
    )
    const attachFingerprints = (nextItems: SourceIntakeItem[]) =>
      nextItems.map((item) => ({
        ...item,
        sourceFingerprint: fingerprintByKey.get(sourceFingerprintKey(sourceFileName(item.fileName), item.fileSize)) || item.sourceFingerprint,
        uploadLaneHint: uploadLane,
      }))

    const chunks = chunkFiles(filesToProcess, extractBatchSize)
    const batchResults: ExtractBatchResult[] = []

    try {
      if (cachedUploads.length) {
        batchResults.push({
          items: cachedUploads.flatMap((entry) => entry.items),
          usedFallback: false,
          fileCount: cachedUploads.length,
          recoveredFiles: 0,
          recoveredFileNames: [],
          fallbackFiles: 0,
          fallbackFileNames: [],
        })
      }

      for (const chunk of chunks) {
        try {
          const extracted = await extractFilesWithBackend(chunk, uploadLane, session.client.entityName)
          batchResults.push({
            items: extracted,
            usedFallback: false,
            fileCount: chunk.length,
            recoveredFiles: 0,
            recoveredFileNames: [],
            fallbackFiles: 0,
            fallbackFileNames: [],
          })
        } catch {
          const recoveredItems: SourceIntakeItem[] = []
          let recoveredFiles = 0
          const recoveredFileNames: string[] = []
          let fallbackFiles = 0
          const fallbackFileNames: string[] = []

          for (const file of chunk) {
            try {
              const extracted = await extractFilesWithBackend([file], uploadLane, session.client.entityName)
              recoveredItems.push(...extracted)
              recoveredFiles += 1
              recoveredFileNames.push(file.name)
            } catch {
              const fallbackItems = await buildIntakeItemsForFile(file, uploadLane, session.client.entityName)
              recoveredItems.push(...fallbackItems)
              fallbackFiles += 1
              fallbackFileNames.push(file.name)
            }
          }

          batchResults.push({
            items: recoveredItems,
            usedFallback: fallbackFiles > 0,
            fileCount: chunk.length,
            recoveredFiles,
            recoveredFileNames,
            fallbackFiles,
            fallbackFileNames,
          })
        }
      }

      const fallbackFiles = batchResults.reduce((sum, result) => sum + result.fallbackFiles, 0)
      const recoveredFiles = batchResults.reduce((sum, result) => sum + result.recoveredFiles, 0)
      const nextItems = attachSourcePreviews(attachFingerprints(batchResults.flatMap((result) => result.items)), previewByKey, previewByFingerprint)
      const aiLimitHits = nextItems.filter(itemHasAiLimitWarning)
      const aiLimitFiles = new Set(aiLimitHits.map((item) => sourceFileName(item.fileName))).size
      const fallbackFileNames = Array.from(new Set(batchResults.flatMap((result) => result.fallbackFileNames)))
      const fallbackReviewFiles = new Set(
        nextItems
          .filter((item) => item.status === 'Needs Review' && fallbackFileNames.includes(sourceFileName(item.fileName)))
          .map((item) => sourceFileName(item.fileName)),
      ).size
      const fallbackAcceptedFiles = Math.max(0, fallbackFileNames.length - fallbackReviewFiles)

      if (uncachedUploads.length) {
        const nextCache = { ...nextExtractionCache }
        for (const upload of uncachedUploads) {
          const cacheKey = intakeCacheKeyForUpload(upload, uploadLane, session.client.entityName)
          const matchingItems = nextItems.filter((item) => {
            const baseName = sourceFileName(item.fileName)
            return baseName === upload.file.name || baseName.startsWith(`${upload.file.name} `)
          })
          const cacheableItems = matchingItems
            .filter((item) => item.extractionMethod && item.extractionMethod !== 'unreadable-fallback')
            .map((item) => {
              const {
                id,
                uploadedAt,
                sourcePreview,
                ...cacheable
              } = item
              void id
              void uploadedAt
              void sourcePreview
              return cacheable
            })
          if (cacheableItems.length) {
            nextCache[cacheKey] = cacheableItems
          }
        }
        saveIntakeCache(nextCache)
      }

      onSessionChange((current) => {
        const retainedItems = replacementUploads.length
          ? current.sourceIntakeItems.filter((item) => !replacementUploads.some((upload) => itemMatchesUpload(item, upload)))
          : current.sourceIntakeItems

        return {
          ...current,
          sourceIntakeItems: [...retainedItems, ...nextItems],
          journalVoucherReady: false,
        }
      })

      const acceptedCount = nextItems.filter((item) => item.status === 'Accepted').length
      const reviewCount = nextItems.filter((item) => item.status === 'Needs Review').length
      const cachedFiles = cachedUploads.length
      const replacementFiles = replacementUploads.length
      setExtractDiagnostics({
        filesProcessed: filesToProcess.length,
        acceptedCount,
        reviewCount,
        recoveredFiles,
        fallbackFiles,
        fallbackAcceptedFiles,
        fallbackReviewFiles,
        cachedFiles,
        replacementFiles,
        duplicateFiles: duplicateUploads.length,
      })
      if (aiLimitFiles) {
        setExtractMessageType('alert')
        setExtractMessage(
          `AI scan limit reached for ${aiLimitFiles} file(s). OpenRouter could not complete some vision reads, so BK should expect extra manual checks on those uploads.${replacementFiles ? ` Re-scanned ${replacementFiles} existing file(s).` : ''}${cachedFiles ? ` Reused cached extraction for ${cachedFiles} file(s).` : ''}${duplicateUploads.length ? ` Skipped ${duplicateUploads.length} duplicate file(s) from the same upload batch.` : ''}`,
        )
      } else {
        const sharedSuffix = `${replacementFiles ? ` Re-scanned ${replacementFiles} existing file(s).` : ''}${cachedFiles ? ` Reused cached extraction for ${cachedFiles} file(s).` : ''}${duplicateUploads.length ? ` Skipped ${duplicateUploads.length} duplicate file(s) from the same upload batch.` : ''}`
        if (fallbackReviewFiles > 0) {
          setExtractMessageType('warning')
          setExtractMessage(
            `Backup extraction was used for ${fallbackFiles} file(s). ${fallbackAcceptedFiles ? `${fallbackAcceptedFiles} file(s) still finished cleanly, ` : ''}${fallbackReviewFiles} file(s) still need BK review.${recoveredFiles ? ` ${recoveredFiles} file(s) were recovered with single-file retry.` : ''}${sharedSuffix}`,
          )
        } else if (fallbackFiles > 0) {
          setExtractMessageType('ok')
          setExtractMessage(
            `Backup extraction was used for ${fallbackFiles} file(s), and all final rows are ready.${recoveredFiles ? ` ${recoveredFiles} file(s) were recovered with single-file retry.` : ''}${sharedSuffix}`,
          )
        } else if (recoveredFiles) {
          setExtractMessageType('ok')
          setExtractMessage(
            `Server extractor recovered ${recoveredFiles} file(s) with single-file retry and read ${nextItems.length} row(s) from ${uncachedUploads.length} file(s): ${acceptedCount} accepted, ${reviewCount} need review.${sharedSuffix}`,
          )
        } else {
          setExtractMessageType('ok')
          setExtractMessage(
            `Server extractor read ${nextItems.length} row(s) from ${uncachedUploads.length} file(s): ${acceptedCount} accepted, ${reviewCount} need review.${sharedSuffix}`,
          )
        }
      }

      if (aiLimitFiles) {
        telemetryIssue('intake_ai_limit_reached', {
          files_processed: filesToProcess.length,
          ai_limit_files: aiLimitFiles,
          rows_parsed: nextItems.length,
          duplicate_files: duplicateUploads.length,
          cached_files: cachedUploads.length,
          replacement_files: replacementFiles,
          fallback_review_files: fallbackReviewFiles,
          fallback_accepted_files: fallbackAcceptedFiles,
        })
      } else if (fallbackFiles) {
        telemetryIssue('intake_extract_partial_fallback', {
          files_processed: filesToProcess.length,
          fallback_files: fallbackFiles,
          recovered_files: recoveredFiles,
          rows_parsed: nextItems.length,
          duplicate_files: duplicateUploads.length,
          cached_files: cachedUploads.length,
          replacement_files: replacementFiles,
          fallback_review_files: fallbackReviewFiles,
          fallback_accepted_files: fallbackAcceptedFiles,
        })
      } else {
        telemetryEvent('intake_extract_completed', {
          files_processed: filesToProcess.length,
          recovered_files: recoveredFiles,
          rows_parsed: nextItems.length,
          accepted_count: acceptedCount,
          review_count: reviewCount,
          duplicate_files: duplicateUploads.length,
          cached_files: cachedUploads.length,
          replacement_files: replacementFiles,
        })
      }

      const firstReview = nextItems.find((item) => item.status === 'Needs Review')
      if (firstReview) {
        const firstReviewFile = nextItems.find((item) => item.id === firstReview.id)
        const firstQueue = firstReviewFile
          ? uploadQueueForFile({
              name: sourceFileName(firstReview.fileName),
              items: nextItems.filter((item) => sourceFileName(item.fileName) === sourceFileName(firstReview.fileName)),
              amountTotal: nextItems
                .filter((item) => sourceFileName(item.fileName) === sourceFileName(firstReview.fileName))
                .reduce((sum, item) => sum + Number(item.amount || 0), 0),
              acceptedCount: nextItems.filter((item) => sourceFileName(item.fileName) === sourceFileName(firstReview.fileName) && item.status === 'Accepted').length,
              reviewCount: nextItems.filter((item) => sourceFileName(item.fileName) === sourceFileName(firstReview.fileName) && item.status === 'Needs Review').length,
              importedCount: 0,
              ignoredCount: 0,
              firstReviewId: firstReview.id,
              primaryType: firstReview.detectedType,
              family: intakeFamilyForItem(firstReview),
            })
          : 'unclassified'
        setActiveWorkspace(firstQueue)
        setActiveFamilyFilter(intakeFamilyForItem(firstReview))
        setActiveFileFilter(sourceFileName(firstReview.fileName))
        setSelectedIssueId(firstReview.id)
        setRawViewerItemId(null)
      } else {
        setActiveWorkspace('clean')
        setActiveFamilyFilter('all')
        setActiveFileFilter('all')
      }
    } finally {
      setExtracting(false)
    }
  }

  const processStagedFiles = async () => {
    if (!stagedFiles.length) return
    const toProcess = [...stagedFiles]
    setStagedFiles([])
    const laneGroups = new Map<UploadLane, File[]>()
    for (const entry of toProcess) {
      const group = laneGroups.get(entry.lane) ?? []
      group.push(entry.file)
      laneGroups.set(entry.lane, group)
    }
    for (const [lane, files] of laneGroups) {
      await handleFiles(files, lane)
    }
  }

  const importReadyRows = () => {
    telemetryEvent('intake_import_started', {
      wp1_rows: importableWp1.length,
      wp2_rows: importableWp2.length,
    })
    onSessionChange((current) => {
      const wp1Items = current.sourceIntakeItems.filter((item) => canImportReady(item, current.client.entityName) && item.target === 'WP1')
      const wp2Items = current.sourceIntakeItems.filter((item) => canImportReady(item, current.client.entityName) && item.target === 'WP2')
      const documents = wp1Items.map((item, index) => sourceDocumentFromIntake(item, nextDocumentId(current.documents, index), current))
      const sessionAfterWp1 = {
        ...current,
        documents: [...current.documents, ...documents],
      }
      const bankRows = wp2Items.map((item, index) =>
        bankRowFromIntake(item, nextBankRowId(current.bankRows, index), sessionAfterWp1),
      )

      return {
        ...current,
        documents: [...current.documents, ...documents],
        bankRows: [...current.bankRows, ...bankRows],
        wp2VerifiedAt: undefined,
        sourceIntakeItems: current.sourceIntakeItems.map((item) =>
          canImportReady(item, current.client.entityName) ? { ...item, status: 'Imported' } : item,
        ),
        journalVoucherReady: false,
      }
    })
    setExtractMessageType('ok')
    setExtractMessage(
      `Imported ${importableWp1.length} ready row(s) into WP1 and ${importableWp2.length} row(s) into WP2. Open the next step to continue bookkeeping.`,
    )
  }

  const clearImported = () => {
    telemetryEvent('intake_clear_completed', {
      imported_rows: items.filter((item) => item.status === 'Imported').length,
      ignored_rows: items.filter((item) => item.status === 'Ignored').length,
    })
    onSessionChange((current) => ({
      ...current,
      sourceIntakeItems: current.sourceIntakeItems.filter((item) => item.status !== 'Imported' && item.status !== 'Ignored'),
    }))
  }

  const jumpToReview = (issueId?: string, fileName: string = 'all') => {
    if (issueId) {
      const issue = items.find((item) => item.id === issueId)
      telemetryEvent('intake_issue_opened', {
        file_scope: fileName === 'all' ? 'all' : 'single_file',
        doc_type: issue?.detectedType,
        target: issue?.target,
      })
      if (issue) {
        const file = fileSummaries.find((summary) => summary.name === sourceFileName(issue.fileName))
        setActiveWorkspace(file ? uploadQueueForFile(file) : 'unclassified')
        setActiveFamilyFilter(intakeFamilyForItem(issue))
      }
    }
    setActiveFileFilter(fileName)
    if (issueId) {
      if (selectedReviewIssueId === issueId && reviewPanelRef.current) {
        reviewPanelRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
      setSelectedIssueId(issueId)
    }
  }

  const showAllIssues = () => {
    setActiveFamilyFilter('all')
    setActiveFileFilter('all')
    const nextIssue = items.find((item) => {
      if (item.status !== 'Needs Review') return false
      const file = fileSummaries.find((summary) => summary.name === sourceFileName(item.fileName))
      return file ? uploadQueueForFile(file) === activeWorkspace : false
    })
    setSelectedIssueId(nextIssue?.id ?? null)
  }

  const goToIssueOffset = (offset: number) => {
    if (!reviewItems.length || !selectedIssue) return
    const nextIndex = (selectedIssueIndex + offset + reviewItems.length) % reviewItems.length
    setSelectedIssueId(reviewItems[nextIndex].id)
  }

  const openWorkspace = (workspace: IntakeWorkspace, family: IntakeFamily = 'all') => {
    setActiveWorkspace(workspace)
    setActiveFamilyFilter(family)
    setActiveFileFilter('all')

    if (workspace === 'unclassified' || workspace === 'mixed') {
      const nextIssue = items.find((item) => {
        if (item.status !== 'Needs Review') return false
        if (family !== 'all' && intakeFamilyForItem(item) !== family) return false
        const file = fileSummaries.find((summary) => summary.name === sourceFileName(item.fileName))
        return file ? uploadQueueForFile(file) === workspace : false
      })
      setSelectedIssueId(nextIssue?.id ?? null)
      return
    }
  }

  const currentWorkspaceSummary = useMemo(() => {
    const activeQueueSummary = queueSummaryMap[activeWorkspace]
    const visibleRecordCount = visibleFileSummaries.reduce((sum, file) => sum + file.items.length, 0)

    switch (activeWorkspace) {
      case 'unclassified':
        return {
          frameTitle: 'Unclassified Uploads Queue',
          frameSubtitle: `${session.client.entityName} - validate the weak or fallback rows before importing anything downstream.`,
          queueLabel: 'Unclassified Uploads',
          queueHeadline: reviewItems.length ? `${reviewItems.length} issue${reviewItems.length === 1 ? '' : 's'} to validate` : 'No active issues',
          queueCopy:
            activeFileFilter === 'all'
              ? activeFamilyFilter === 'all'
                ? `These uploads need manual help. ${activeQueueSummary.uploads} upload${activeQueueSummary.uploads === 1 ? '' : 's'} produced ${activeQueueSummary.reviewRecords} review record${activeQueueSummary.reviewRecords === 1 ? '' : 's'}.`
                : `Showing ${intakeFamilyMeta(activeFamilyFilter).label.toLowerCase()} issues first.`
              : `Showing issues from ${activeFileFilter}.`,
          fileLabel: 'Unclassified Uploads',
          fileHeadline: `${visibleFileSummaries.length} upload${visibleFileSummaries.length === 1 ? '' : 's'} / ${visibleRecordCount} extracted record${visibleRecordCount === 1 ? '' : 's'}`,
          fileCopy: 'These uploads still need classification, extraction confirmation, or stronger manual review.',
        }
      case 'mixed':
        return {
          frameTitle: 'Mixed Uploads Queue',
          frameSubtitle: `${session.client.entityName} - most records are usable, but each upload still has a smaller exception set to clear.`,
          queueLabel: 'Mixed Uploads',
          queueHeadline: `${activeQueueSummary.uploads} upload${activeQueueSummary.uploads === 1 ? '' : 's'} with both accepted and review records`,
          queueCopy:
            activeFileFilter === 'all'
              ? `${activeQueueSummary.acceptedRecords} accepted record${activeQueueSummary.acceptedRecords === 1 ? '' : 's'} are already usable, while ${activeQueueSummary.reviewRecords} still need attention.`
              : `Showing mixed results from ${activeFileFilter}.`,
          fileLabel: 'Mixed Uploads',
          fileHeadline: `${visibleFileSummaries.length} upload${visibleFileSummaries.length === 1 ? '' : 's'} / ${visibleRecordCount} extracted record${visibleRecordCount === 1 ? '' : 's'}`,
          fileCopy: 'These are the uploads where BK should clear a few exceptions instead of rechecking every extracted record.',
        }
      case 'clean':
        return {
          frameTitle: 'Clean Uploads Queue',
          frameSubtitle: `${session.client.entityName} - spot-check the clean records, then import them into WP1 or WP2.`,
          queueLabel: 'Clean Uploads',
          queueHeadline: `${activeQueueSummary.acceptedRecords} accepted record${activeQueueSummary.acceptedRecords === 1 ? '' : 's'} ready`,
          queueCopy: 'These uploads look clean enough for a fast pass before import.',
          fileLabel: 'Clean Uploads',
          fileHeadline: `${visibleFileSummaries.length} upload${visibleFileSummaries.length === 1 ? '' : 's'} / ${visibleRecordCount} extracted record${visibleRecordCount === 1 ? '' : 's'}`,
          fileCopy: 'Use this queue for quick spot checks only; the goal here is speed, not deep review.',
        }
      case 'bank':
        return {
          frameTitle: 'Bank Uploads Queue',
          frameSubtitle: `${session.client.entityName} - isolate bank statements and bank-style files for WP2 handling.`,
          queueLabel: 'Bank Uploads',
          queueHeadline: `${activeQueueSummary.uploads} upload${activeQueueSummary.uploads === 1 ? '' : 's'} / ${activeQueueSummary.records} bank record${activeQueueSummary.records === 1 ? '' : 's'}`,
          queueCopy: 'This queue keeps bank materials separate so BK can move them into WP2 with less noise.',
          fileLabel: 'Bank Uploads',
          fileHeadline: `${visibleFileSummaries.length} upload${visibleFileSummaries.length === 1 ? '' : 's'} / ${visibleRecordCount} extracted record${visibleRecordCount === 1 ? '' : 's'}`,
          fileCopy: 'Open the bank uploads here, then continue the actual verification in WP2.',
        }
      case 'completed':
        return {
          frameTitle: 'Completed Queue',
          frameSubtitle: `${session.client.entityName} - review what was already imported or skipped, then clear it when you are done.`,
          queueLabel: 'Completed Queue',
          queueHeadline: `${activeQueueSummary.importedRecords} completed record${activeQueueSummary.importedRecords === 1 ? '' : 's'}`,
          queueCopy: 'This queue is mainly for audit and cleanup, not for active ingestion work.',
          fileLabel: 'Completed Uploads',
          fileHeadline: `${visibleFileSummaries.length} upload${visibleFileSummaries.length === 1 ? '' : 's'} / ${visibleRecordCount} completed record${visibleRecordCount === 1 ? '' : 's'}`,
          fileCopy: 'Keep this list for traceability, then clear completed items when BK is finished.',
        }
      default:
        return {
          frameTitle: 'Source Document Intake',
          frameSubtitle: `${session.client.entityName} - review only the weak rows first, then import the accepted output.`,
          queueLabel: 'Queue',
          queueHeadline: '',
          queueCopy: '',
          fileLabel: 'Files',
          fileHeadline: '',
          fileCopy: '',
        }
    }
  }, [
    activeFamilyFilter,
    activeFileFilter,
    activeWorkspace,
    queueSummaryMap,
    reviewItems.length,
    session.client.entityName,
    visibleFileSummaries,
  ])

  return (
    <>
      <section className="intake-upload-panel">
        <div className="intake-upload-copy">
          <span>Source Document Intake</span>
          <strong>Upload BK test documents before WP1 and WP2.</strong>
          <p>Pick a lane when BK already knows the document family. That context helps the extractor avoid tagging purchase invoices as sales, or bank docs as generic unknowns.</p>
        </div>
        <input
          ref={fileInputRef}
          disabled={extracting}
          multiple
          onChange={(event) => {
            const picked = Array.from(event.target.files ?? [])
            if (picked.length) {
              const lane = pendingUploadLane
              setStagedFiles((prev) => [
                ...prev,
                ...picked.map((file) => ({
                  id: `stage-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                  file,
                  lane,
                })),
              ])
            }
            setPendingUploadLane('purchases')
            event.target.value = ''
          }}
          type="file"
          hidden
        />
        <div className="intake-upload-actions">
          {uploadLaneOptions.map((option) => (
            <button
              key={option.id}
              className={`file-upload-button ${option.id === 'auto' ? '' : 'secondary'}`}
              disabled={extracting}
              onClick={() => {
                setPendingUploadLane(option.id)
                fileInputRef.current?.click()
              }}
              type="button"
              title={option.hint}
            >
              {extracting && pendingUploadLane === option.id ? 'Extracting...' : option.label}
            </button>
          ))}
        </div>
        <div className="intake-upload-utilities">
          <button
            className="secondary-button"
            disabled={extracting}
            onClick={resetSessionData}
            type="button"
          >
            Start Fresh Session
          </button>
          <button
            className="secondary-button"
            disabled={extracting}
            onClick={resetSavedIntakeCache}
            type="button"
          >
            Reset Saved Cache
          </button>
          <small>Use Start Fresh Session to clear current WP1 and WP2 test data. Use Reset Saved Cache when you only want the same files to re-scan again.</small>
        </div>
      </section>

      {stagedFiles.length ? (
        <section className="intake-staging-panel">
          <div className="intake-staging-head">
            <div>
              <span>Staged for Processing</span>
              <strong>{stagedFiles.length} file{stagedFiles.length === 1 ? '' : 's'} queued</strong>
              <p>Add more files across any lane, then click Process when ready.</p>
            </div>
            <button
              className="file-upload-button"
              disabled={extracting}
              onClick={() => void processStagedFiles()}
              type="button"
            >
              {extracting ? 'Extracting...' : `Process ${stagedFiles.length} File${stagedFiles.length === 1 ? '' : 's'}`}
            </button>
          </div>
          <ul className="intake-staging-list">
            {stagedFiles.map((entry) => (
              <li key={entry.id} className="intake-staging-item">
                <span className={`intake-staging-lane lane-${entry.lane}`}>
                  {uploadLaneOptions.find((o) => o.id === entry.lane)?.label ?? entry.lane}
                </span>
                <span className="intake-staging-name">{entry.file.name}</span>
                <button
                  aria-label={`Remove ${entry.file.name}`}
                  className="intake-staging-remove"
                  disabled={extracting}
                  onClick={() => setStagedFiles((prev) => prev.filter((f) => f.id !== entry.id))}
                  type="button"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {extractMessage ? (
        <section className={`intake-parser-message ${extractMessageType}`}>{extractMessage}</section>
      ) : null}
      {acceptedButBlockedCount ? (
        <section className="intake-queue-callout warning">
          <strong>Some accepted rows still cannot import yet.</strong>
          <p>
            {acceptedButBlockedCount} accepted row{acceptedButBlockedCount === 1 ? '' : 's'} still need the required
            downstream fields before they can move into WP1 or WP2.
          </p>
        </section>
      ) : null}
      {hasCompletedImports ? (
        <section className="intake-next-panel">
          <div>
            <strong>Ready rows already moved downstream.</strong>
            <span>Next: open WP1 for document posting, or WP2 for bank verification. Intake can stay open for any remaining exceptions.</span>
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
      ) : null}
      {ownerDiagnosticsEnabled && extractDiagnostics ? (
        <details className="intake-diagnostics">
          <summary>Owner Diagnostics</summary>
          <div className="intake-diagnostics-grid">
            <span>Files processed: {extractDiagnostics.filesProcessed}</span>
            <span>Accepted rows: {extractDiagnostics.acceptedCount}</span>
            <span>Review rows: {extractDiagnostics.reviewCount}</span>
            <span>Single-file retries: {extractDiagnostics.recoveredFiles}</span>
            <span>Backup extracted files: {extractDiagnostics.fallbackFiles}</span>
            <span>Backup resolved cleanly: {extractDiagnostics.fallbackAcceptedFiles}</span>
            <span>Backup still need review: {extractDiagnostics.fallbackReviewFiles}</span>
            <span>Reused cache: {extractDiagnostics.cachedFiles}</span>
            <span>Re-scanned files: {extractDiagnostics.replacementFiles}</span>
            <span>Skipped duplicates: {extractDiagnostics.duplicateFiles}</span>
          </div>
        </details>
      ) : null}

      <section className="intake-inbox-section">
        <div className="intake-inbox-head">
          <div>
            <span>Intake Inbox</span>
            <strong>Start with the next action, not the raw file list.</strong>
            <p>Open the queue BK should handle first, then narrow into document families and files within that queue.</p>
          </div>
        </div>
        <div className="intake-inbox-grid">
          <InboxCard
            active={activeWorkspace === 'unclassified'}
            countLabel={`${queueSummaryMap.unclassified.records} extracted record${queueSummaryMap.unclassified.records === 1 ? '' : 's'}`}
            description={`${queueSummaryMap.unclassified.reviewRecords} review record${queueSummaryMap.unclassified.reviewRecords === 1 ? '' : 's'} still need classification or confirmation.`}
            headline={`${queueSummaryMap.unclassified.uploads} upload${queueSummaryMap.unclassified.uploads === 1 ? '' : 's'}`}
            label="Unclassified Uploads"
            onClick={() => openWorkspace('unclassified')}
            tone="orange"
          />
          <InboxCard
            active={activeWorkspace === 'mixed'}
            countLabel={`${queueSummaryMap.mixed.records} extracted record${queueSummaryMap.mixed.records === 1 ? '' : 's'}`}
            description={`${queueSummaryMap.mixed.acceptedRecords} accepted and ${queueSummaryMap.mixed.reviewRecords} review record${queueSummaryMap.mixed.reviewRecords === 1 ? '' : 's'} across the same upload set.`}
            headline={`${queueSummaryMap.mixed.uploads} upload${queueSummaryMap.mixed.uploads === 1 ? '' : 's'}`}
            label="Mixed Uploads"
            onClick={() => openWorkspace('mixed')}
            tone="purple"
          />
          <InboxCard
            active={activeWorkspace === 'clean'}
            countLabel={`${queueSummaryMap.clean.records} extracted record${queueSummaryMap.clean.records === 1 ? '' : 's'}`}
            description={`${queueSummaryMap.clean.acceptedRecords} accepted record${queueSummaryMap.clean.acceptedRecords === 1 ? '' : 's'} ready for a light spot-check.`}
            headline={`${queueSummaryMap.clean.uploads} upload${queueSummaryMap.clean.uploads === 1 ? '' : 's'}`}
            label="Clean Uploads"
            onClick={() => openWorkspace('clean')}
            tone="green"
          />
          <InboxCard
            active={activeWorkspace === 'bank'}
            countLabel={`${queueSummaryMap.bank.records} extracted record${queueSummaryMap.bank.records === 1 ? '' : 's'}`}
            description={`${queueSummaryMap.bank.reviewRecords} review record${queueSummaryMap.bank.reviewRecords === 1 ? '' : 's'} currently need checking before WP2.`}
            headline={`${queueSummaryMap.bank.uploads} upload${queueSummaryMap.bank.uploads === 1 ? '' : 's'}`}
            label="Bank Uploads"
            onClick={() => openWorkspace('bank')}
            tone="blue"
          />
          <InboxCard
            active={activeWorkspace === 'completed'}
            countLabel={`${queueSummaryMap.completed.records} extracted record${queueSummaryMap.completed.records === 1 ? '' : 's'}`}
            description={`${queueSummaryMap.completed.importedRecords} imported or ignored record${queueSummaryMap.completed.importedRecords === 1 ? '' : 's'} kept for audit and cleanup.`}
            headline={`${queueSummaryMap.completed.uploads} upload${queueSummaryMap.completed.uploads === 1 ? '' : 's'}`}
            label="Completed"
            onClick={() => openWorkspace('completed')}
            tone="teal"
          />
        </div>

        {workspaceFamilySummaries.length > 1 ? (
          <div className="intake-family-toolbar">
            <span>Document Families In This Queue</span>
            <div className="intake-family-pills">
              <button
                className={`intake-family-pill ${activeFamilyFilter === 'all' ? 'active' : ''}`}
                onClick={() => setActiveFamilyFilter('all')}
                type="button"
              >
                All in Queue
              </button>
              {workspaceFamilySummaries.map((family) => (
                <button
                  className={`intake-family-pill ${activeFamilyFilter === family.id ? 'active' : ''}`}
                  key={family.id}
                  onClick={() => {
                    setActiveFamilyFilter(family.id)
                    setActiveFileFilter('all')
                    if ((activeWorkspace === 'unclassified' || activeWorkspace === 'mixed') && family.firstReviewId) {
                      jumpToReview(family.firstReviewId)
                    }
                  }}
                  type="button"
                >
                  {family.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      {visibleFileSummaries.length ? (
        <section className="intake-file-browser">
          <div className="intake-file-browser-head">
            <div>
              <span>Files In This Queue</span>
              <strong>{visibleFileSummaries.length} file{visibleFileSummaries.length === 1 ? '' : 's'} visible</strong>
              <p>Use the file cards only when BK needs to drill into a specific uploaded document.</p>
            </div>
          </div>
          <div className="intake-file-grid">
            {visibleFileSummaries.map((file) => (
            <article className={`intake-file-card ${file.reviewCount ? 'has-review' : 'is-clean'}`} key={file.name}>
              <div>
                <span>{intakeFamilyMeta(file.family).label} · {file.primaryType}</span>
                <strong>{file.name}</strong>
                <p>
                  {file.items.length} row(s) • RM {formatMoney(file.amountTotal)}
                </p>
              </div>
              <div className="intake-file-metrics">
                <span>{file.acceptedCount} accepted</span>
                <span>{file.reviewCount} review</span>
              </div>
              <div className="intake-file-actions">
                <button
                  className="secondary-button"
                  disabled={!canOpenItemSource(file.items[0])}
                  onClick={() => openItemSourcePreview(file.items[0])}
                  type="button"
                >
                  Open Original
                </button>
                {file.reviewCount ? (
                  <button
                    className="secondary-button"
                    onClick={() => jumpToReview(file.firstReviewId, file.name)}
                    type="button"
                  >
                    Review {file.reviewCount} issue{file.reviewCount === 1 ? '' : 's'}
                  </button>
                ) : (
                  <button
                    className="secondary-button"
                    onClick={() => openExtractedRowsForFile(file.name, file.family)}
                    type="button"
                  >
                    View Extracted Rows
                  </button>
                )}
              </div>
            </article>
            ))}
          </div>
        </section>
      ) : null}

      <WorkpaperFrame
        period={session.client.period}
        subtitle={currentWorkspaceSummary.frameSubtitle}
        title={currentWorkspaceSummary.frameTitle}
        footer={
          <>
            <div className="metric">
              <span>Auto Accepted WP1</span>
              <strong>{acceptedWp1.length}</strong>
            </div>
            <div className="metric">
              <span>Auto Accepted WP2</span>
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
              className={`primary-button ${!importableItems.length && hasCompletedImports ? 'is-complete' : ''}`}
              disabled={!importableItems.length}
              onClick={importReadyRows}
              type="button"
            >
              {!importableItems.length && hasCompletedImports ? 'Ready Rows Imported' : 'Import Ready Rows'}
            </button>
          </>
        }
      >
        {items.length ? (
          <div className="intake-review-layout">
            {aiLimitFileCount ? (
              <div className="intake-queue-callout alert">
                <strong>AI scan limit reached.</strong>
                <p>
                  OpenRouter hit a balance or rate limit on {aiLimitFileCount} file{aiLimitFileCount === 1 ? '' : 's'}.
                  BK can continue reviewing the extracted rows, but low-quality scans may need manual handling until the AI limit is restored.
                </p>
              </div>
            ) : null}
            {activeWorkspace === 'unclassified' && extractMessageType === 'warning' ? (
              <div className="intake-queue-callout warning">
                <strong>Fallback intake mode is active.</strong>
                <p>Many PDFs and images likely came through browser fallback, so this queue should be treated as a manual validation inbox.</p>
              </div>
            ) : null}
            {activeWorkspace === 'clean' ? (
              <div className="intake-queue-callout ready">
                <strong>Fast lane for cleaner files.</strong>
                <p>BK should only spot-check these files lightly before importing them into WP1 or WP2.</p>
              </div>
            ) : null}
            {activeWorkspace === 'bank' ? (
              <div className="intake-queue-callout info">
                <strong>Bank files are isolated here.</strong>
                <p>Use this queue to keep statement-style documents together before moving into WP2 verification.</p>
              </div>
            ) : null}
            <section className="intake-queue-panel" ref={reviewPanelRef}>
              <div className="intake-queue-head">
                <div>
                  <span>{currentWorkspaceSummary.queueLabel}</span>
                  <strong>{currentWorkspaceSummary.queueHeadline}</strong>
                  <p>{currentWorkspaceSummary.queueCopy}</p>
                </div>
                <div className="intake-queue-actions">
                  {(activeWorkspace === 'unclassified' || activeWorkspace === 'mixed') && reviewItems.length ? (
                    <>
                      <button className="secondary-button" onClick={() => goToIssueOffset(-1)} type="button">
                        Previous Issue
                      </button>
                      <button className="secondary-button" onClick={() => goToIssueOffset(1)} type="button">
                        Next Issue
                      </button>
                    </>
                  ) : null}
                  {(activeWorkspace === 'unclassified' || activeWorkspace === 'mixed') ? (
                    <button className="secondary-button" onClick={showAllIssues} type="button">
                      Show All In Queue
                    </button>
                  ) : null}
                </div>
              </div>

              {(activeWorkspace === 'unclassified' || activeWorkspace === 'mixed') && reviewItems.length && selectedIssue && selectedIssueSummary ? (
                <>
                  <div className="intake-review-list">
                    {reviewItems.map((item, index) => {
                      const issue = issueSummaryForItem(item, currentClientEntityName)
                      const active = item.id === selectedIssue.id
                      return (
                        <button
                          className={`intake-review-chip ${active ? 'active' : ''}`}
                          key={item.id}
                          onClick={() => setSelectedIssueId(item.id)}
                          type="button"
                        >
                          <span>{index + 1}</span>
                          <strong>{issue.label}</strong>
                          <small>Row {sourceRowNumber(item.fileName) || '-'}</small>
                          <small>{item.party || 'Review description'} • RM {formatMoney(Number(item.amount || 0))}</small>
                        </button>
                      )
                    })}
                  </div>

                  <article className="intake-review-card">
                    <div className="intake-review-card-head">
                      <div>
                        <span>Issue {selectedIssueIndex + 1} of {reviewItems.length}</span>
                        <h3>{selectedIssueSummary.label}</h3>
                        <p>{selectedIssueSummary.detail}</p>
                      </div>
                      <div className="intake-review-meta">
                        <strong>{sourceFileName(selectedIssue.fileName)}</strong>
                        <small>Row {sourceRowNumber(selectedIssue.fileName) || '-'}</small>
                        <span className={`badge badge-${selectedIssue.status.toLowerCase().replace(/\s+/g, '-')}`}>
                          {selectedIssue.status}
                        </span>
                      </div>
                    </div>

                    {focusedFileSummary ? (
                      <div className="intake-file-checks">
                        <div>
                          <span>Parsed Rows</span>
                          <strong>{focusedFileSummary.items.length}</strong>
                        </div>
                        <div>
                          <span>Review Rows</span>
                          <strong>{focusedFileSummary.reviewCount}</strong>
                        </div>
                        <div>
                          <span>Rows Missing Amount</span>
                          <strong>{focusedFileMissingAmounts}</strong>
                        </div>
                        <div>
                          <span>Detected Total</span>
                          <strong>RM {formatMoney(focusedFileDetectedTotal)}</strong>
                        </div>
                      </div>
                    ) : null}
                    <div className="intake-source-launcher">
                      <div>
                        <span>Source Check</span>
                        <strong>
                          {selectedIssue.rawSource?.fileName || sourceFileName(selectedIssue.fileName)}
                          {selectedIssue.rawSource?.rowNumber ? ` • row ${selectedIssue.rawSource.rowNumber}` : ''}
                        </strong>
                        <p>
                          {selectedIssue.sourcePreview?.previewKind === 'pdf' || selectedIssue.sourcePreview?.previewKind === 'image'
                            ? 'Open the original uploaded file preview to inspect the source document directly.'
                            : 'Open the raw-source viewer to inspect the actual uploaded row and nearby context.'}
                        </p>
                      </div>
                      <button
                        className="secondary-button"
                        disabled={!selectedIssue.rawSource && !selectedIssue.sourcePreview}
                        onClick={() => openItemSourcePreview(selectedIssue, selectedIssueSummary.label)}
                        type="button"
                      >
                        {selectedIssue.sourcePreview?.previewKind === 'pdf' || selectedIssue.sourcePreview?.previewKind === 'image'
                          ? 'Open Original'
                          : 'Open Original'}
                      </button>
                    </div>

                    <div className="intake-review-fields" data-openreplay-obscured="">
                      <label className={selectedIssueSummary.focusField === 'type' ? 'field-alert' : ''}>
                        <span>Type</span>
                        <select
                          value={selectedIssue.detectedType}
                          onChange={(event) => {
                            const detectedType = event.target.value as IntakeDocumentType
                            updateItem(selectedIssue.id, {
                              detectedType,
                              target: detectedType === 'Bank Statement' ? 'WP2' : detectedType === 'Unknown' ? selectedIssue.target : 'WP1',
                              suggestedGlAccount: suggestedAccountForType(detectedType) || selectedIssue.suggestedGlAccount,
                            })
                          }}
                        >
                          {intakeTypes.map((type) => (
                            <option key={type}>{type}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>Target</span>
                        <select
                          value={selectedIssue.target}
                          onChange={(event) => updateItem(selectedIssue.id, { target: event.target.value as IntakeTarget })}
                        >
                          <option>WP1</option>
                          <option>WP2</option>
                          <option>Ignore</option>
                        </select>
                      </label>
                      <label className={selectedIssueSummary.focusField === 'date' ? 'field-alert' : ''}>
                        <span>Date</span>
                        <input
                          value={selectedIssue.date}
                          onChange={(event) => updateItem(selectedIssue.id, { date: event.target.value })}
                        />
                      </label>
                      <label className={selectedIssueSummary.focusField === 'reference' ? 'field-alert' : ''}>
                        <span>Reference</span>
                        <input
                          value={selectedIssue.reference}
                          onChange={(event) => updateItem(selectedIssue.id, { reference: event.target.value })}
                        />
                      </label>
                      <label className={`wide-field ${selectedIssueSummary.focusField === 'party' ? 'field-alert' : ''}`}>
                        <span>Party / Description</span>
                        <input
                          value={selectedIssue.party}
                          onChange={(event) => updateItem(selectedIssue.id, { party: event.target.value })}
                        />
                        {selectedIssue.rawPreview ? <small>{selectedIssue.rawPreview}</small> : null}
                      </label>
                      <label className={selectedIssueSummary.focusField === 'amount' ? 'field-alert' : ''}>
                        <span>Amount</span>
                        <input
                          min="0"
                          step="0.01"
                          type="number"
                          value={selectedIssue.amount}
                          onChange={(event) => {
                            const amount = Number(event.target.value)
                            updateItem(selectedIssue.id, {
                              amount,
                              moneyIn: selectedIssue.target === 'WP2' && selectedIssue.moneyOut === 0 ? amount : selectedIssue.moneyIn,
                            })
                          }}
                        />
                        <small>RM {formatMoney(Number(selectedIssue.amount || 0))}</small>
                      </label>
                      <label className={selectedIssueSummary.focusField === 'gl' ? 'field-alert' : ''}>
                        <span>GL / Bank Dir</span>
                        {selectedIssue.target === 'WP2' ? (
                          <select
                            value={selectedIssue.moneyIn > 0 ? 'Money In' : 'Money Out'}
                            onChange={(event) => {
                              const amount = Number(selectedIssue.amount || 0)
                              updateItem(
                                selectedIssue.id,
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
                            value={selectedIssue.suggestedGlAccount}
                            onChange={(event) => updateItem(selectedIssue.id, { suggestedGlAccount: event.target.value })}
                          >
                            <option value="">Select in WP1</option>
                            {documentTypes.includes(selectedIssue.detectedType as DocumentType)
                              ? accountsForDocumentType(selectedIssue.detectedType as DocumentType).map((account) => (
                                  <option key={account.code} value={formatAccount(account)}>
                                    {formatAccount(account)}
                                  </option>
                                ))
                              : null}
                          </select>
                        )}
                      </label>
                    </div>

                    <div className="intake-review-checks">
                      <div className="intake-suggestion">
                        {(selectedIssue.glSuggestions ?? []).slice(0, 1).map((suggestion) => (
                          <span key={`${suggestion.account}-${suggestion.reason}`}>
                            Suggested GL: {suggestion.account} ({Math.round(suggestion.confidence * 100)}%)
                          </span>
                        ))}
                        {selectedIssue.glSuggestions?.[1] ? (
                          <span>
                            Alternative: {selectedIssue.glSuggestions[1].account} ({Math.round(selectedIssue.glSuggestions[1].confidence * 100)}%)
                          </span>
                        ) : null}
                        {(selectedIssue.evidence ?? []).slice(0, 2).map((line) => (
                          <span key={line}>{line}</span>
                        ))}
                        {(selectedIssue.warnings ?? []).slice(0, 2).map((line) => (
                          <strong key={line}>{line}</strong>
                        ))}
                        {selectedIssue.target !== 'Ignore' && selectedIssueImportIssues.length ? (
                          <strong>
                            Fill before import: {selectedIssueImportIssues.join(', ')}.
                          </strong>
                        ) : null}
                      </div>
                      <div className="action-group intake-actions">
                        <button className="text-button" onClick={() => setShowFileRows((current) => !current)} type="button">
                          {showFileRows ? 'Hide Processed Rows' : 'Show Processed Rows'}
                        </button>
                        <button
                          className="text-button split-action"
                          disabled={selectedIssue.target !== 'Ignore' && selectedIssueImportIssues.length > 0}
                          onClick={() => {
                            telemetryEvent('intake_issue_resolved', {
                              action: selectedIssue.target === 'Ignore' ? 'ignore' : 'mark_ready',
                              doc_type: selectedIssue.detectedType,
                              target: selectedIssue.target,
                            })
                            updateItem(selectedIssue.id, {
                              status: selectedIssue.target === 'Ignore' ? 'Ignored' : 'Accepted',
                            })
                          }}
                          title={
                            selectedIssue.target === 'Ignore'
                              ? 'Exclude this row from import.'
                              : selectedIssueImportIssues.length
                                ? `Complete: ${selectedIssueImportIssues.join(', ')}`
                                : 'Mark this row ready for import.'
                          }
                          type="button"
                        >
                          {selectedIssue.target === 'Ignore' ? 'Ignore' : 'Mark Ready'}
                        </button>
                        <button
                          className="text-button"
                          onClick={() => {
                            telemetryEvent('intake_issue_skipped', {
                              doc_type: selectedIssue.detectedType,
                              target: selectedIssue.target,
                            })
                            updateItem(selectedIssue.id, { status: 'Ignored', target: 'Ignore' })
                          }}
                          type="button"
                        >
                          Ignore This Row
                        </button>
                        <button className="text-button" onClick={() => goToIssueOffset(1)} type="button">
                          Next Issue
                        </button>
                      </div>
                    </div>
                  </article>
                </>
              ) : (
                <div className="intake-empty-state intake-clean-state">
                  <strong>
                    {activeWorkspace === 'clean'
                      ? 'No issue-by-issue review needed in this queue.'
                      : activeWorkspace === 'bank'
                        ? 'This queue is file-first rather than issue-first.'
                        : activeWorkspace === 'completed'
                          ? 'Completed items do not need active review.'
                          : 'No review blockers right now.'}
                  </strong>
                  <p>
                    {activeWorkspace === 'clean'
                      ? 'Use the file list below for a light spot check, then import the accepted rows.'
                      : activeWorkspace === 'bank'
                        ? 'Use the file list below to inspect the bank materials before moving into WP2.'
                        : activeWorkspace === 'completed'
                          ? 'Use the file list below to audit or clear completed items.'
                          : 'Accepted rows are ready to import. Open the accepted section below for a quick spot check.'}
                  </p>
                </div>
              )}
            </section>

            <section className="intake-accepted-panel" ref={acceptedPanelRef}>
              <div className="intake-accepted-head">
                <div>
                  <span>{currentWorkspaceSummary.fileLabel}</span>
                  <strong>{currentWorkspaceSummary.fileHeadline}</strong>
                  <p>{currentWorkspaceSummary.fileCopy}</p>
                </div>
                <div className="intake-queue-actions">
                  <button className="secondary-button" onClick={() => setShowFileRows((current) => !current)} type="button">
                    {showFileRows ? 'Hide File Rows' : 'Show File Rows'}
                  </button>
                </div>
              </div>
              {showFileRows ? (
              <div className="table-scroll intake-compact-table" data-openreplay-obscured="">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>File / Row</th>
                      <th>Issue</th>
                      <th>Type</th>
                      <th>Target</th>
                      <th>Date</th>
                      <th>Desc</th>
                      <th className="right">Amount</th>
                      <th>GL</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {focusedFileRows.map((item) => {
                      const issue = issueSummaryForItem(item, currentClientEntityName)
                      return (
                        <tr
                          className={`intake-row status-row-${item.status.toLowerCase().replace(/\s+/g, '-')} ${selectedIssue?.id === item.id ? 'intake-row-selected' : ''}`}
                          key={item.id}
                          ref={(element) => {
                            fileRowRefs.current[item.id] = element
                          }}
                        >
                          <td>
                            <strong>{item.fileName}</strong>
                            <small>{item.confidence} confidence{typeof item.overallConfidenceScore === 'number' ? ` (${Math.round(item.overallConfidenceScore * 100)}%)` : ''}</small>
                          </td>
                          <td>
                            <span className={`badge badge-${item.status === 'Needs Review' ? 'pending-review' : 'accepted'}`}>
                              {item.status === 'Needs Review' ? issue.label : 'Looks Good'}
                            </span>
                          </td>
                          <td>{item.detectedType}</td>
                          <td>{item.target}</td>
                          <td>{item.date || 'Review'}</td>
                          <td>
                            <strong>{item.party || 'Review'}</strong>
                            {item.rawPreview ? <small>{item.rawPreview}</small> : null}
                          </td>
                          <td className="right">RM {formatMoney(Number(item.amount || 0))}</td>
                          <td>{item.target === 'WP2' ? (item.moneyIn > 0 ? 'Money In' : 'Money Out') : item.suggestedGlAccount || 'Select in WP1'}</td>
                          <td>
                            <span className={`badge badge-${item.status.toLowerCase().replace(/\s+/g, '-')}`}>
                              {item.status}
                            </span>
                          </td>
                          <td>
                            {item.status === 'Needs Review' ? (
                              <div className="action-group">
                                <button
                                  className="text-button"
                                  disabled={!canOpenItemSource(item)}
                                  onClick={() => openItemSourcePreview(item)}
                                  type="button"
                                >
                                  Open Original
                                </button>
                                <button
                                  className="text-button"
                                  onClick={() => jumpToReview(item.id, sourceFileName(item.fileName))}
                                  type="button"
                                >
                                  Focus Issue
                                </button>
                              </div>
                            ) : (
                              <div className="action-group">
                                <button
                                  className="text-button"
                                  disabled={!canOpenItemSource(item)}
                                  onClick={() => openItemSourcePreview(item)}
                                  type="button"
                                >
                                  Open Original
                                </button>
                                <button
                                  className="text-button"
                                  onClick={() => openExtractedRowsForFile(sourceFileName(item.fileName), intakeFamilyForItem(item))}
                                  type="button"
                                >
                                  View Extracted Rows
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              ) : (
                <div className="intake-empty-state intake-collapsed-state">
                  <strong>File rows are collapsed.</strong>
                  <p>BK can stay in the issue card for focused review, or expand this section to compare the row against the full file.</p>
                </div>
              )}
            </section>
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
          <strong>After importing ready rows</strong>
          <span>Open WP1 to work through source documents. Open WP2 to review bank rows and matches. Remaining intake exceptions can stay here until BK is ready to clear them.</span>
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
      {rawViewerItem ? (
        <RawSourceModal
          clientEntityName={currentClientEntityName}
          fileItems={items.filter((candidate) => sourceFileName(candidate.fileName) === sourceFileName(rawViewerItem.fileName))}
          item={rawViewerItem}
          onClose={() => setRawViewerItemId(null)}
          onCommitItem={(itemId, patch, mode) => {
            onSessionChange((current) => ({
              ...current,
              sourceIntakeItems: current.sourceIntakeItems.map((candidate) => {
                if (candidate.id !== itemId) return candidate

                const merged = { ...candidate, ...patch }
                if (candidate.status === 'Imported') return merged

                const readyIssues =
                  merged.target === 'Ignore'
                    ? []
                    : importReadinessIssues({
                        ...merged,
                        status: 'Accepted',
                      }, current.client.entityName)

                let nextStatus = merged.status
                if (mode === 'ready') {
                  nextStatus = merged.target === 'Ignore' ? 'Ignored' : readyIssues.length ? 'Needs Review' : 'Accepted'
                } else if (mode === 'review') {
                  nextStatus = 'Needs Review'
                } else if (candidate.status === 'Accepted') {
                  nextStatus = readyIssues.length ? 'Needs Review' : 'Accepted'
                } else {
                  nextStatus = patch.status ?? candidate.status
                }

                return { ...merged, status: nextStatus }
              }),
              journalVoucherReady: false,
            }))
          }}
        />
      ) : null}
    </>
  )
}

function InboxCard({
  label,
  headline,
  countLabel,
  description,
  tone,
  active = false,
  onClick,
}: {
  label: string
  headline: string
  countLabel: string
  description: string
  tone: 'neutral' | 'green' | 'orange' | 'purple' | 'red' | 'blue' | 'teal'
  active?: boolean
  onClick?: () => void
}) {
  return (
    <button className={`intake-inbox-card tone-${tone} ${active ? 'active' : ''}`} onClick={onClick} type="button">
      <span>{label}</span>
      <strong>{headline}</strong>
      <small>{countLabel}</small>
      <p>{description}</p>
    </button>
  )
}

function RawSourceModal({
  clientEntityName,
  fileItems,
  item,
  onClose,
  onCommitItem,
}: {
  clientEntityName: string
  fileItems: SourceIntakeItem[]
  item: SourceIntakeItem
  onClose: () => void
  onCommitItem: (itemId: string, patch: IntakePatch, mode: 'save' | 'ready' | 'review') => void
}) {
  const rawSource = item.rawSource
  const preview = item.sourcePreview
  const importedRow = item.status === 'Imported'
  const [draft, setDraft] = useState<Pick<
    SourceIntakeItem,
    'detectedType' | 'target' | 'date' | 'reference' | 'party' | 'amount' | 'moneyIn' | 'moneyOut' | 'suggestedGlAccount'
  >>({
    detectedType: item.detectedType,
    target: item.target,
    date: item.date,
    reference: item.reference,
    party: item.party,
    amount: item.amount,
    moneyIn: item.moneyIn,
    moneyOut: item.moneyOut,
    suggestedGlAccount: item.suggestedGlAccount,
  })

  const [sizeMode, setSizeMode] = useState<'fit' | 'wide' | 'full'>('wide')
  const [showInspector, setShowInspector] = useState(true)
  const activeRowRef = useRef<HTMLTableRowElement | null>(null)
  const isDocumentPreview = preview?.previewKind === 'pdf' || preview?.previewKind === 'image'
  const draftItem = useMemo(
    () =>
      ({
        ...item,
        ...draft,
      }) as SourceIntakeItem,
    [draft, item],
  )
  const draftImportIssues = useMemo(
    () =>
      draftItem.target === 'Ignore'
        ? []
        : importReadinessIssues({
            ...draftItem,
            status: 'Accepted',
          }, clientEntityName),
    [clientEntityName, draftItem],
  )
  const previewRows = useMemo(() => {
    if (!rawSource) return []
    const dataRows = fileItems
      .filter((candidate) => candidate.rawSource?.rowNumber)
      .sort((left, right) => (left.rawSource?.rowNumber ?? 0) - (right.rawSource?.rowNumber ?? 0))
      .map((candidate) => ({
        rowNumber: candidate.rawSource?.rowNumber ?? 0,
        cells: candidate.rawSource?.cells ?? [],
        kind: 'data' as const,
      }))

    const fallbackRows =
      rawSource.contextRows?.map((row) => ({
        rowNumber: row.rowNumber,
        cells: row.cells,
        kind: 'data' as const,
      })) ?? []

    return [
      {
        rowNumber: rawSource.headerRowNumber ?? 1,
        cells: rawSource.headers,
        kind: 'header' as const,
      },
      ...(dataRows.length ? dataRows : fallbackRows),
    ]
  }, [fileItems, rawSource])
  const columnCount = rawSource ? Math.max(rawSource.headers.length, ...previewRows.map((row) => row.cells.length)) : 0
  const highlightedColumns = new Set(focusColumnIndexes(item))
  const highlightedColumnNames = Array.from(highlightedColumns)
    .map((index) => rawSource?.headers[index] ?? '')
    .filter(Boolean)
  const issue = issueSummaryForItem(item, clientEntityName)
  const totalDataRows = Math.max(previewRows.length - 1, 0)

  useEffect(() => {
    if (!isDocumentPreview) {
      activeRowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [isDocumentPreview, item.id])

  useEffect(() => {
    setDraft({
      detectedType: item.detectedType,
      target: item.target,
      date: item.date,
      reference: item.reference,
      party: item.party,
      amount: item.amount,
      moneyIn: item.moneyIn,
      moneyOut: item.moneyOut,
      suggestedGlAccount: item.suggestedGlAccount,
    })
  }, [item])

  if (!rawSource && !preview) return null

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <section
        aria-modal="true"
        className={[
          'modal-panel raw-source-modal',
          `raw-source-modal-${sizeMode}`,
          showInspector ? '' : 'raw-source-modal-sheet-only',
        ]
          .join(' ')
          .trim()}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="modal-head">
          <div>
            <h3>File Preview</h3>
            <p>
              {preview?.fileName || rawSource?.fileName || sourceFileName(item.fileName)}
              {rawSource?.rowNumber ? ` • row ${rawSource.rowNumber}` : ''}
            </p>
          </div>
          <div className="raw-modal-actions">
            <button className="secondary-button raw-back-button" onClick={onClose} type="button">
              Back to Review
            </button>
            <button aria-label="Close preview" className="raw-close-button" onClick={onClose} type="button">
              x
            </button>
          </div>
        </header>
        <div className="modal-body">
          <div className="raw-file-toolbar">
            <div className="raw-file-toolbar-group">
              <button
                className={sizeMode === 'fit' ? 'raw-toolbar-button active' : 'raw-toolbar-button'}
                onClick={() => setSizeMode('fit')}
                type="button"
              >
                Fit
              </button>
              <button
                className={sizeMode === 'wide' ? 'raw-toolbar-button active' : 'raw-toolbar-button'}
                onClick={() => setSizeMode('wide')}
                type="button"
              >
                Large
              </button>
              <button
                className={sizeMode === 'full' ? 'raw-toolbar-button active' : 'raw-toolbar-button'}
                onClick={() => setSizeMode('full')}
                type="button"
              >
                Full Screen
              </button>
            </div>
            <div className="raw-file-toolbar-title">
              <strong>{preview?.fileName || rawSource?.fileName || sourceFileName(item.fileName)}</strong>
              <span>
                {isDocumentPreview ? 'Original uploaded document preview' : `Row ${rawSource?.rowNumber ?? '-'} selected`}
                {!isDocumentPreview && highlightedColumns.size ? ` • ${issue.label}` : ''}
              </span>
            </div>
            <div className="raw-file-toolbar-group">
              <button className="raw-toolbar-button" onClick={() => setShowInspector((current) => !current)} type="button">
                {showInspector ? 'Hide Details' : 'Show Details'}
              </button>
            </div>
          </div>

          <div className="modal-source-bar">
              <div>
                <span>Selected Row</span>
                <strong>{isDocumentPreview ? 'Document' : rawSource?.rowNumber ?? '-'}</strong>
              </div>
              <div>
                <span>{isDocumentPreview ? 'Preview Type' : 'Visible Sheet'}</span>
                <strong>{isDocumentPreview ? preview?.previewKind?.toUpperCase() : `${totalDataRows} row(s)`}</strong>
              </div>
              <div>
                <span>{isDocumentPreview ? 'File' : 'Focus Columns'}</span>
                <strong>{isDocumentPreview ? preview?.fileName : highlightedColumnNames.join(', ') || 'Full row'}</strong>
              </div>
            </div>

          <div className="raw-source-layout">
            <section className="raw-source-table-panel raw-source-sheet-panel">
              <div className="intake-panel-head">
                <div>
                  <span>{isDocumentPreview ? 'Document Preview' : 'Spreadsheet Preview'}</span>
                  <strong>
                    {isDocumentPreview ? 'Open the original uploaded document directly in the review modal.' : 'Full file preview with the exact issue row highlighted.'}
                  </strong>
                </div>
              </div>
              {isDocumentPreview && preview ? (
                <div className="raw-sheet-window raw-document-window" data-openreplay-obscured="">
                  {preview.previewKind === 'pdf' ? (
                    <iframe className="raw-document-frame" src={preview.objectUrl} title={preview.fileName} />
                  ) : preview.previewKind === 'image' ? (
                    <div className="raw-image-frame">
                      <img alt={preview.fileName} src={preview.objectUrl} />
                    </div>
                  ) : null}
                </div>
              ) : (
              <div className="raw-sheet-window" data-openreplay-obscured="">
                <div className="raw-sheet-namebar">
                  <div className="raw-sheet-namebox">Row {rawSource?.rowNumber ?? '-'}</div>
                  <div className="raw-sheet-formulabar">
                    {rawSource?.cells.filter(Boolean).join(' | ') || 'No source values detected for this row.'}
                  </div>
                </div>
                <div className="table-scroll raw-source-table-scroll">
                  <table className="raw-sheet-grid">
                    <thead>
                      <tr>
                        <th className="raw-sheet-corner" />
                        {Array.from({ length: columnCount }, (_, index) => (
                          <th className="raw-sheet-column" key={`col-${index}`}>
                            {spreadsheetColumnLabel(index)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {previewRows.map((row) => (
                        <tr
                          className={[
                            row.kind === 'header' ? 'raw-sheet-header-row' : '',
                            row.rowNumber === rawSource?.rowNumber ? 'raw-source-active-row' : '',
                          ].join(' ').trim()}
                          key={`${row.kind}-${row.rowNumber}`}
                          ref={row.rowNumber === rawSource?.rowNumber ? activeRowRef : undefined}
                        >
                          <td className="raw-sheet-row-number">{row.rowNumber}</td>
                          {Array.from({ length: columnCount }, (_, index) => (
                            <td
                              className={[
                                highlightedColumns.has(index) && row.rowNumber === rawSource?.rowNumber ? 'raw-sheet-focus-cell' : '',
                              ].join(' ').trim()}
                              key={`${row.rowNumber}-${index}`}
                            >
                              {row.cells[index] || <span className="muted"> </span>}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="raw-sheet-statusbar">
                  <span>{rawSource?.fileName}</span>
                  <strong>
                    Row {rawSource?.rowNumber ?? '-'}
                    {highlightedColumnNames.length ? ` • ${highlightedColumnNames.join(', ')}` : ''}
                  </strong>
                </div>
              </div>
              )}
            </section>

            <section className="raw-source-table-panel raw-source-inspector-panel">
              <div className="intake-panel-head">
                <div>
                  <span>Quick Entry</span>
                  <strong>Review the original file and key the important fields here.</strong>
                </div>
              </div>
              <div className="raw-edit-status">
                <span className={`badge badge-${item.status.toLowerCase().replace(/\s+/g, '-')}`}>{item.status}</span>
                <small>
                  {importedRow
                    ? 'This row is already imported into WP1 or WP2, so this modal is read-only.'
                    : 'Changes save back into Intake. Use Mark Ready when the row looks correct.'}
                </small>
              </div>
              <div className="manual-form-grid raw-edit-grid">
                <label>
                  <span>Type</span>
                  <select
                    disabled={importedRow}
                    value={draft.detectedType}
                    onChange={(event) => {
                      const detectedType = event.target.value as IntakeDocumentType
                      setDraft((current) => ({
                        ...current,
                        detectedType,
                        target: detectedType === 'Bank Statement' ? 'WP2' : detectedType === 'Unknown' ? current.target : 'WP1',
                        suggestedGlAccount: suggestedAccountForType(detectedType) || current.suggestedGlAccount,
                      }))
                    }}
                  >
                    {intakeTypes.map((type) => (
                      <option key={type}>{type}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Target</span>
                  <select
                    disabled={importedRow}
                    value={draft.target}
                    onChange={(event) => setDraft((current) => ({ ...current, target: event.target.value as IntakeTarget }))}
                  >
                    <option>WP1</option>
                    <option>WP2</option>
                    <option>Ignore</option>
                  </select>
                </label>
                <label className={!draft.date.trim() && draft.target !== 'Ignore' ? 'field-alert' : ''}>
                  <span>Date</span>
                  <input
                    disabled={importedRow}
                    placeholder="03 Feb"
                    value={draft.date}
                    onChange={(event) => setDraft((current) => ({ ...current, date: event.target.value }))}
                  />
                </label>
                <label className={!draft.reference.trim() && draft.target === 'WP1' ? 'field-alert' : ''}>
                  <span>Reference</span>
                  <input
                    disabled={importedRow}
                    placeholder="Document reference"
                    value={draft.reference}
                    onChange={(event) => setDraft((current) => ({ ...current, reference: event.target.value }))}
                  />
                </label>
                <label className="wide-field">
                  <span>Description</span>
                  <input
                    disabled={importedRow}
                    placeholder="Supplier, customer, or row description"
                    value={draft.party}
                    onChange={(event) => setDraft((current) => ({ ...current, party: event.target.value }))}
                  />
                </label>
                <label className={Number(draft.amount || 0) <= 0 && draft.target !== 'Ignore' ? 'field-alert' : ''}>
                  <span>Amount</span>
                  <input
                    disabled={importedRow}
                    inputMode="decimal"
                    placeholder="0.00"
                    value={draft.amount}
                    onChange={(event) => {
                      const amount = parseAmount(event.target.value)
                      setDraft((current) => ({
                        ...current,
                        amount,
                        moneyIn: current.target === 'WP2' && current.moneyOut === 0 ? amount : current.moneyIn,
                        moneyOut: current.target === 'WP2' && current.moneyIn === 0 ? amount : current.moneyOut,
                      }))
                    }}
                  />
                  <small>RM {formatMoney(Number(draft.amount || 0))}</small>
                </label>
                <label>
                  <span>{draft.target === 'WP2' ? 'Bank Direction' : 'GL / Account'}</span>
                  {draft.target === 'WP2' ? (
                    <select
                      disabled={importedRow}
                      value={draft.moneyIn > 0 ? 'Money In' : 'Money Out'}
                      onChange={(event) => {
                        const amount = Number(draft.amount || 0)
                        setDraft((current) => ({
                          ...current,
                          moneyIn: event.target.value === 'Money In' ? amount : 0,
                          moneyOut: event.target.value === 'Money Out' ? amount : 0,
                        }))
                      }}
                    >
                      <option>Money In</option>
                      <option>Money Out</option>
                    </select>
                  ) : (
                    <select
                      disabled={importedRow}
                      value={draft.suggestedGlAccount}
                      onChange={(event) => setDraft((current) => ({ ...current, suggestedGlAccount: event.target.value }))}
                    >
                      <option value="">Select in WP1</option>
                      {documentTypes.includes(draft.detectedType as DocumentType)
                        ? accountsForDocumentType(draft.detectedType as DocumentType).map((account) => (
                            <option key={account.code} value={formatAccount(account)}>
                              {formatAccount(account)}
                            </option>
                          ))
                        : null}
                    </select>
                  )}
                </label>
              </div>
              <div className="raw-edit-notes">
                {draft.target !== 'Ignore' && draftImportIssues.length ? (
                  <div className="intake-status-copy warning">Fill before import: {draftImportIssues.join(', ')}.</div>
                ) : (
                  <div className="intake-status-copy success">This row is ready for Intake import once you mark it ready.</div>
                )}
              </div>
              <div className="raw-edit-actions">
                <button
                  className="secondary-button"
                  disabled={importedRow}
                  onClick={() => onCommitItem(item.id, draft, 'save')}
                  type="button"
                >
                  Save Changes
                </button>
                <button
                  className="secondary-button"
                  disabled={importedRow}
                  onClick={() => onCommitItem(item.id, draft, 'review')}
                  type="button"
                >
                  Send to Review
                </button>
                <button
                  className="primary-button"
                  disabled={importedRow || (draft.target !== 'Ignore' && draftImportIssues.length > 0)}
                  onClick={() => onCommitItem(item.id, draft, 'ready')}
                  type="button"
                >
                  {draft.target === 'Ignore' ? 'Ignore Row' : 'Mark Ready'}
                </button>
              </div>
              <div className="intake-source-grid extracted">
                <div className="intake-source-cell">
                  <span>Current Saved Type</span>
                  <strong>{item.detectedType}</strong>
                </div>
                <div className="intake-source-cell">
                  <span>Current Saved Target</span>
                  <strong>{item.target}</strong>
                </div>
                <div className="intake-source-cell">
                  <span>Current Saved Date</span>
                  <strong>{item.date || 'Blank'}</strong>
                </div>
                <div className="intake-source-cell">
                  <span>Current Saved Reference</span>
                  <strong>{item.reference || 'Blank'}</strong>
                </div>
                <div className="intake-source-cell">
                  <span>Current Saved Description</span>
                  <strong>{item.party || 'Blank'}</strong>
                </div>
                <div className="intake-source-cell">
                  <span>Current Saved Amount</span>
                  <strong>RM {formatMoney(Number(item.amount || 0))}</strong>
                </div>
                <div className="intake-source-cell wide">
                  <span>Warnings</span>
                  <strong>{item.warnings?.join(' ') || 'None'}</strong>
                </div>
              </div>
            </section>
          </div>
        </div>
      </section>
    </div>
  )
}
