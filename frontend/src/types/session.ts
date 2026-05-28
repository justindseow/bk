export type WorkflowStepId =
  | 'collection'
  | 'wp1'
  | 'wp2'
  | 'adjusting'
  | 'review'
  | 'journal'
  | 'handover'
  | 'download'

export type FlowDirection = 'IN' | 'OUT'

export type DocumentType =
  | 'Sales Invoice'
  | 'Purchase Invoice'
  | 'Payment Voucher'
  | 'Receipt'
  | 'Payroll Summary'
  | 'Loan / HP Statement'
  | 'Merchant Statement'
  | 'Utility Bill'

export type DocumentStatus =
  | 'Posted'
  | 'Needs Split'
  | 'Split Done'
  | 'Reclassify'
  | 'Reclassified'
  | 'Pending Review'

export type SplitType = 'Prepayment' | 'Payroll' | 'Loan repayment' | 'Bulk payment'

export type ReclassifyType = 'Asset purchase' | 'Director transaction'

export type EntryDirection = 'DR' | 'CR'

export type BankStatus =
  | 'Matched'
  | 'Match Multiple'
  | 'New'
  | 'Outstanding / Timing Item'
  | 'Needs Review'

export type TimingItemType = 'Outstanding cheque' | 'Deposit in transit'

export type AdjustingEntryType = 'Reversal' | 'Accrual' | 'Depreciation'

export type AdjustingStatus = 'Pending Review' | 'Posted' | 'Reversed' | 'Depreciation Posted'

export interface SessionClient {
  entityName: string
  period: string
  bankAccount: string
  preparedBy: string
}

export interface SourceDocument {
  id: string
  date: string
  docRef: string
  party: string
  docType: DocumentType
  amount: number
  flow: FlowDirection
  glAccount: string
  status: DocumentStatus
  splitType?: SplitType
  reclassifyType?: ReclassifyType
  note?: string
}

export interface AccountOption {
  code: string
  name: string
  category: string
  normalBalance: EntryDirection
}

export interface SplitLine {
  id: string
  accountCode: string
  accountName: string
  direction: EntryDirection
  amount: number
  description: string
}

export interface SplitDecision {
  documentId: string
  splitType: SplitType
  lines: SplitLine[]
  confirmedAt: string
}

export type DirectorTransactionNature =
  | 'Loan to/from Director'
  | 'Capital Injection'
  | 'Drawing'

export interface ReclassifyDecision {
  documentId: string
  reclassifyType: ReclassifyType
  accountCode: string
  accountName: string
  usefulLifeMonths?: number
  directorNature?: DirectorTransactionNature
  note: string
  confirmedAt: string
}

export interface JournalLine {
  id: string
  documentId: string
  date: string
  description: string
  accountCode: string
  accountName: string
  debit: number
  credit: number
  source: 'Doc' | 'Split' | 'Reclassify' | 'Bank+' | 'Adjusting'
}

export interface BankRow {
  id: string
  date: string
  description: string
  reference: string
  amount: number
  direction: 'DR' | 'CR'
  status: BankStatus
  suggestedDocumentIds?: string[]
  matchedTo?: string
  remarks: string
}

export interface BankMatch {
  bankRowId: string
  documentIds: string[]
  matchType: 'Auto' | 'Manual' | 'Multiple'
  confirmedAt: string
}

export interface BankOnlyEntry {
  bankRowId: string
  accountCode: string
  accountName: string
  description: string
  confirmedAt: string
}

export interface TimingItem {
  bankRowId: string
  timingType: TimingItemType
  amount: number
  direction: 'DR' | 'CR'
  note: string
  confirmedAt: string
}

export interface AdjustingEntry {
  id: string
  date: string
  type: AdjustingEntryType
  description: string
  debitAccount: string
  creditAccount: string
  amount: number
  reverseNextMonth: boolean
  status: AdjustingStatus
  notes?: string
  sourceId?: string
}

export interface PriorAccrual {
  id: string
  originalPeriod: string
  description: string
  originalAmount: number
  debitAccount: string
  creditAccount: string
  reversalDate: string
  status: 'Pending' | 'Reversed'
}

export interface FutureReversalItem {
  id: string
  adjustingEntryId: string
  action: string
  entryReference: string
  amount: number
  duePeriod: string
  notes: string
}

export interface DepreciationScheduleItem {
  id: string
  documentId: string
  assetDescription: string
  assetAccount: string
  purchaseDate: string
  cost: number
  usefulLifeMonths: number
  monthlyDepreciation: number
  accumulatedDepreciationAccount: string
  depreciationExpenseAccount: string
  status: 'Ready to Post' | 'Depreciation Posted'
}

export interface ChecklistItem {
  id: string
  section: string
  action: string
  reference: string
  amount: number
  note: string
}

export interface SampleSession {
  client: SessionClient
  journalVoucherReady: boolean
  documents: SourceDocument[]
  splitDecisions: SplitDecision[]
  reclassifyDecisions: ReclassifyDecision[]
  bankRows: BankRow[]
  bankMatches: BankMatch[]
  bankOnlyEntries: BankOnlyEntry[]
  timingItems: TimingItem[]
  priorAccruals: PriorAccrual[]
  adjustingEntries: AdjustingEntry[]
  futureReversalItems: FutureReversalItem[]
  depreciationSchedule: DepreciationScheduleItem[]
  checklistItems: ChecklistItem[]
}
