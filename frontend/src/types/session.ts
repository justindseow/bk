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

export type DocumentStatus = 'Posted' | 'Pending' | 'Split' | 'Reclassified'

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
  docType: string
  amount: number
  flow: FlowDirection
  glAccount: string
  status: DocumentStatus
  note?: string
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
  bankRows: BankRow[]
  adjustingEntries: AdjustingEntry[]
  checklistItems: ChecklistItem[]
}
