import { sampleSession } from '../data/sampleSession'
import { buildGeneratedHandoverItems } from './handoverBuilder'
import { generateJournalLines } from './journalBuilder'
import type { SampleSession } from '../types/session'

const cloneSession = (session: SampleSession): SampleSession => JSON.parse(JSON.stringify(session))

const confirmedAt = '2025-01-31T00:00:00.000Z'

export function createCleanDemoSession(): SampleSession {
  return cloneSession(sampleSession)
}

export function createBlankBkTestSession(current: SampleSession = sampleSession): SampleSession {
  return {
    ...cloneSession(sampleSession),
    client: { ...current.client },
    journalVoucherReady: false,
    journalVoucherFinalised: false,
    journalVoucherFinalisedAt: undefined,
    finalisedJournalLinesSnapshot: [],
    documents: [],
    splitDecisions: [],
    reclassifyDecisions: [],
    bankRows: [],
    bankMatches: [],
    bankOnlyEntries: [],
    timingItems: [],
    priorAccruals: [],
    adjustingEntries: [],
    futureReversalItems: [],
    depreciationSchedule: [],
    checklistItems: [],
    handoverItems: [],
    manualHandoverItems: [],
  }
}

export function makeWp1Ready(session: SampleSession): SampleSession {
  const next = cloneSession(session)

  next.documents = next.documents.map((document) => {
    if (['03', '05', '06', '10'].includes(document.id)) {
      return { ...document, status: 'Split Done' }
    }
    if (document.id === '04') {
      return { ...document, status: 'Reclassified', glAccount: '1510 - Plant & Equipment' }
    }
    if (document.id === '07') {
      return { ...document, status: 'Reclassified', glAccount: '2300 - Loan from Director' }
    }
    if (document.id === '09') {
      return { ...document, status: 'Posted', glAccount: '6210 - Utilities Electricity' }
    }
    return document
  })

  next.splitDecisions = [
    {
      documentId: '03',
      splitType: 'Prepayment',
      confirmedAt,
      lines: [
        {
          id: 'sp-03-01',
          accountCode: '6380',
          accountName: 'Insurance Expense',
          direction: 'DR',
          amount: 500,
          description: 'Current month insurance expense',
        },
        {
          id: 'sp-03-02',
          accountCode: '1120',
          accountName: 'Prepayments',
          direction: 'DR',
          amount: 5500,
          description: 'Prepaid insurance balance',
        },
      ],
    },
    {
      documentId: '05',
      splitType: 'Payroll',
      confirmedAt,
      lines: [
        {
          id: 'sp-05-01',
          accountCode: '6100',
          accountName: 'Salaries & Wages',
          direction: 'DR',
          amount: 12000,
          description: 'Net payroll and gross salary allocation',
        },
        {
          id: 'sp-05-02',
          accountCode: '6120',
          accountName: 'Employer EPF / SOCSO',
          direction: 'DR',
          amount: 1450,
          description: 'Employer statutory contributions',
        },
      ],
    },
    {
      documentId: '06',
      splitType: 'Loan repayment',
      confirmedAt,
      lines: [
        {
          id: 'sp-06-01',
          accountCode: '2700',
          accountName: 'Term Loan Payable',
          direction: 'DR',
          amount: 1700,
          description: 'Loan principal repayment',
        },
        {
          id: 'sp-06-02',
          accountCode: '6900',
          accountName: 'Interest Expense',
          direction: 'DR',
          amount: 400,
          description: 'Loan interest expense',
        },
      ],
    },
    {
      documentId: '10',
      splitType: 'Bulk payment',
      confirmedAt,
      lines: [
        {
          id: 'sp-10-01',
          accountCode: '5020',
          accountName: 'Direct Materials',
          direction: 'DR',
          amount: 3200,
          description: 'Berjaya invoice INV-BF-881',
        },
        {
          id: 'sp-10-02',
          accountCode: '5020',
          accountName: 'Direct Materials',
          direction: 'DR',
          amount: 3300,
          description: 'Berjaya invoice INV-BF-894',
        },
        {
          id: 'sp-10-03',
          accountCode: '5020',
          accountName: 'Direct Materials',
          direction: 'DR',
          amount: 3300,
          description: 'Berjaya invoice INV-BF-901',
        },
      ],
    },
  ]

  next.reclassifyDecisions = [
    {
      documentId: '04',
      reclassifyType: 'Asset purchase',
      accountCode: '1510',
      accountName: 'Plant & Equipment',
      usefulLifeMonths: 60,
      note: 'Capitalise refrigerator and depreciate monthly.',
      confirmedAt,
    },
    {
      documentId: '07',
      reclassifyType: 'Director transaction',
      accountCode: '2300',
      accountName: 'Loan from Director',
      directorNature: 'Loan to/from Director',
      note: 'Classified as director loan funding.',
      confirmedAt,
    },
  ]

  next.journalVoucherReady = false
  next.journalVoucherFinalised = false
  next.journalVoucherFinalisedAt = undefined
  next.finalisedJournalLinesSnapshot = []
  next.handoverItems = []
  next.manualHandoverItems = []

  return next
}

export function makeWp2Ready(session: SampleSession): SampleSession {
  const next = makeWp1Ready(session)

  next.bankRows = next.bankRows.map((row) => {
    if (row.id === '02') {
      return { ...row, status: 'Matched', matchedTo: 'INV-BF-881, INV-BF-894, INV-BF-901', remarks: 'Multi-document match confirmed' }
    }
    if (row.id === '03') {
      return { ...row, status: 'Matched', matchedTo: 'Bank charges Bank+', remarks: 'Bank-only entry posted' }
    }
    if (row.id === '05') {
      return { ...row, status: 'Matched', matchedTo: 'Monthly rent Bank+', remarks: 'Standing instruction posted' }
    }
    if (row.id === '09') {
      return { ...row, status: 'Matched', matchedTo: 'TNB-JAN-25', remarks: 'Utility bill posted in WP1' }
    }
    if (row.id === '10') {
      return { ...row, status: 'Outstanding / Timing Item', matchedTo: 'Timing item', remarks: 'Carry forward to February bank statement' }
    }
    return row
  })

  next.bankMatches = [
    ...next.bankMatches.filter((match) => !['02', '09'].includes(match.bankRowId)),
    {
      bankRowId: '02',
      documentIds: ['02', '11', '12'],
      matchType: 'Multiple',
      confirmedAt,
    },
    {
      bankRowId: '09',
      documentIds: ['09'],
      matchType: 'Manual',
      confirmedAt,
    },
  ]

  next.bankOnlyEntries = [
    {
      bankRowId: '03',
      accountCode: '6320',
      accountName: 'Bank Charges',
      description: 'CIMB bank charges - January',
      confirmedAt,
    },
    {
      bankRowId: '05',
      accountCode: '6300',
      accountName: 'Rent Expense',
      description: 'Sunway Property monthly rent standing instruction',
      confirmedAt,
    },
  ]

  next.timingItems = [
    {
      bankRowId: '10',
      timingType: 'Outstanding cheque',
      amount: 1200,
      direction: 'DR',
      note: 'Cheque #001234 to Pak Ali should clear in February bank statement.',
      confirmedAt,
    },
  ]

  next.journalVoucherReady = false
  next.journalVoucherFinalised = false
  next.journalVoucherFinalisedAt = undefined
  next.finalisedJournalLinesSnapshot = []
  next.handoverItems = []

  return next
}

export function makeAdjustingReady(session: SampleSession): SampleSession {
  const next = cloneSession(session)

  next.priorAccruals = next.priorAccruals.map((accrual) => ({ ...accrual, status: 'Reversed' }))
  next.adjustingEntries = [
    {
      id: 'ADJ-01',
      date: '31 Jan',
      type: 'Accrual',
      description: 'Electricity accrual - January bill not received',
      debitAccount: '6210 - Utilities Electricity',
      creditAccount: '2110 - Accrued Liabilities',
      amount: 650,
      reverseNextMonth: true,
      status: 'Posted',
      notes: 'Reverse in February before posting the actual bill.',
    },
    {
      id: 'ADJ-02',
      date: '31 Jan',
      type: 'Depreciation',
      description: 'Depreciation - refrigerator Jan 2025',
      debitAccount: '6700 - Depreciation Expense',
      creditAccount: '1590 - Accumulated Depreciation',
      amount: 141.67,
      reverseNextMonth: false,
      status: 'Depreciation Posted',
      sourceId: '04',
    },
  ]
  next.futureReversalItems = [
    {
      id: 'FR-ADJ-01',
      adjustingEntryId: 'ADJ-01',
      action: 'Reverse January electricity accrual',
      entryReference: 'DR: 2110  CR: 6210',
      amount: 650,
      duePeriod: 'February 2025',
      notes: 'Reverse first before posting February utilities.',
    },
  ]
  next.depreciationSchedule = [
    {
      id: 'DEP-04',
      documentId: '04',
      assetDescription: 'Harvey Norman - Refrigerator',
      assetAccount: '1510 - Plant & Equipment',
      purchaseDate: '16 Jan',
      cost: 8500,
      usefulLifeMonths: 60,
      monthlyDepreciation: 141.67,
      accumulatedDepreciationAccount: '1590 - Accumulated Depreciation',
      depreciationExpenseAccount: '6700 - Depreciation Expense',
      status: 'Depreciation Posted',
    },
  ]
  next.handoverItems = []
  next.journalVoucherReady = false
  next.journalVoucherFinalised = false
  next.journalVoucherFinalisedAt = undefined
  next.finalisedJournalLinesSnapshot = []

  return next
}

export function makeFullSessionReadyForJv(session: SampleSession = sampleSession): SampleSession {
  const next = makeAdjustingReady(makeWp2Ready(session))
  next.journalVoucherReady = true
  next.journalVoucherFinalised = false
  next.journalVoucherFinalisedAt = undefined
  next.finalisedJournalLinesSnapshot = []
  next.handoverItems = buildGeneratedHandoverItems(next)
  next.manualHandoverItems = []
  return next
}

export function finaliseDemoJournalVoucher(session: SampleSession = sampleSession): SampleSession {
  const next = makeFullSessionReadyForJv(session)
  next.journalVoucherFinalised = true
  next.journalVoucherFinalisedAt = new Date().toISOString()
  next.finalisedJournalLinesSnapshot = generateJournalLines(next)
  next.handoverItems = buildGeneratedHandoverItems(next)
  return next
}

export function createSessionWithIssues(): SampleSession {
  const next = makeFullSessionReadyForJv(sampleSession)

  next.documents = next.documents.map((document) =>
    document.id === '03' ? { ...document, status: 'Needs Split' } : document,
  )
  next.splitDecisions = next.splitDecisions.filter((decision) => decision.documentId !== '03')

  next.bankRows = next.bankRows.map((row) =>
    row.id === '10' ? { ...row, status: 'Needs Review', remarks: 'Needs timing item decision' } : row,
  )

  next.adjustingEntries = next.adjustingEntries.map((entry) =>
    entry.id === 'ADJ-01' ? { ...entry, creditAccount: '', notes: 'Demo issue: liability account missing.' } : entry,
  )

  next.journalVoucherReady = false
  next.journalVoucherFinalised = false
  next.journalVoucherFinalisedAt = undefined
  next.finalisedJournalLinesSnapshot = []
  next.handoverItems = buildGeneratedHandoverItems(next)
  return next
}
