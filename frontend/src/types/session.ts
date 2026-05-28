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

export type BankStatus = 'Matched' | 'Multi-Doc' | 'Added (Bank+)' | 'Outstanding' | 'Unmatched'

export type AdjustingReversal = 'Reverse Feb' | 'No reversal'

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
  source: 'Doc' | 'Split' | 'Reclassify'
}

export interface BankRow {
  id: string
  date: string
  description: string
  amount: number
  direction: 'DR' | 'CR'
  status: BankStatus
  matchedTo: string
  remarks: string
}

export interface AdjustingEntry {
  id: string
  date: string
  description: string
  debitAccount: string
  creditAccount: string
  amount: number
  reversal: AdjustingReversal
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
  documents: SourceDocument[]
  splitDecisions: SplitDecision[]
  reclassifyDecisions: ReclassifyDecision[]
  bankRows: BankRow[]
  adjustingEntries: AdjustingEntry[]
  checklistItems: ChecklistItem[]
}
