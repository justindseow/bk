import { calculateWp2Reconciliation, buildValidationResults } from './validation'
import type { HandoverItem, SampleSession, SplitDecision } from '../types/session'

const BANK_CLOSING_BALANCE = 48320

export const nextPeriodLabel = (period: string) => {
  const [month, year] = period.split(' ')
  const date = new Date(`${month} 1, ${year}`)
  date.setMonth(date.getMonth() + 1)
  return date.toLocaleDateString('en-MY', { month: 'long', year: 'numeric' })
}

export const voucherReference = (period: string) => `JV-${period.replace(/\s+/g, '').toUpperCase()}-001`

const item = (handoverItem: HandoverItem): HandoverItem => handoverItem

const preserveGeneratedStatus = (items: HandoverItem[], existingItems: HandoverItem[]) =>
  items.map((handoverItem) => {
    const existing = existingItems.find((existingItem) => existingItem.id === handoverItem.id)
    return existing ? { ...handoverItem, status: existing.status } : handoverItem
  })

const splitLineAmount = (decision: SplitDecision, matcher: (text: string) => boolean) =>
  decision.lines
    .filter((line) => matcher(`${line.accountCode} ${line.accountName} ${line.description}`.toLowerCase()))
    .reduce((sum, line) => sum + line.amount, 0)

export function buildGeneratedHandoverItems(session: SampleSession): HandoverItem[] {
  const reconciliation = calculateWp2Reconciliation(session)
  const validation = buildValidationResults(session)
  const nextPeriod = nextPeriodLabel(session.client.period)

  const futureReversals = session.futureReversalItems.map((reversal) =>
    item({
      id: `handover-reversal-${reversal.id}`,
      category: 'Must Do First Next Month',
      priority: 'High',
      description: `${reversal.action} for ${nextPeriod}. ${reversal.entryReference}`,
      sourceStep: 'Adjusting',
      amount: reversal.amount,
      dueTiming: 'Start of next month',
      status: 'Open',
      generated: true,
    }),
  )

  const prepaymentMustDo = session.splitDecisions
    .filter((decision) => decision.splitType === 'Prepayment')
    .map((decision) => {
      const document = session.documents.find((doc) => doc.id === decision.documentId)
      return item({
        id: `handover-prepay-next-${decision.documentId}`,
        category: 'Must Do First Next Month',
        priority: 'Medium',
        description: `Continue prepaid expense schedule for ${document?.party ?? 'prepayment item'}.`,
        sourceStep: 'WP1',
        amount: splitLineAmount(decision, (text) => text.includes('prepaid') || text.includes('1120')),
        dueTiming: 'Start of next month',
        status: 'Open',
        generated: true,
      })
    })

  const depreciationMustDo = session.depreciationSchedule.map((schedule) =>
    item({
      id: `handover-dep-next-${schedule.id}`,
      category: 'Must Do First Next Month',
      priority: 'Medium',
      description: `Post monthly depreciation for ${schedule.assetDescription}.`,
      sourceStep: 'Adjusting',
      amount: schedule.monthlyDepreciation,
      dueTiming: 'Month-end close',
      status: 'Open',
      generated: true,
    }),
  )

  const timingWatchItems = session.timingItems.map((timing) => {
    const bankRow = session.bankRows.find((row) => row.id === timing.bankRowId)
    return item({
      id: `handover-timing-${timing.bankRowId}`,
      category: 'Items to Watch in Next Bank Statement',
      priority: 'High',
      description: `${timing.timingType}: ${bankRow?.description ?? 'bank timing item'}. ${timing.note}`,
      sourceStep: 'WP2',
      amount: timing.amount,
      dueTiming: 'When bank statement is received',
      status: 'Open',
      generated: true,
    })
  })

  const unresolvedBankNotes = session.bankRows
    .filter((row) => row.status === 'Needs Review' || row.status === 'Match Multiple' || row.status === 'New')
    .filter((row) => !session.bankOnlyEntries.some((entry) => entry.bankRowId === row.id))
    .filter((row) => !session.timingItems.some((timing) => timing.bankRowId === row.id))
    .map((row) =>
      item({
        id: `handover-bank-watch-${row.id}`,
        category: 'Items to Watch in Next Bank Statement',
        priority: row.status === 'Needs Review' ? 'High' : 'Medium',
        description: `${row.description} remains to be cleared or explained.`,
        sourceStep: 'WP2',
        amount: row.amount,
        dueTiming: 'Before next month reconciliation',
        status: 'Open',
        generated: true,
      }),
    )

  const recurringDepreciation = session.depreciationSchedule.map((schedule) =>
    item({
      id: `handover-recurring-dep-${schedule.id}`,
      category: 'Recurring Monthly Entries',
      priority: 'Medium',
      description: `Monthly depreciation entry: Dr ${schedule.depreciationExpenseAccount}, Cr ${schedule.accumulatedDepreciationAccount}.`,
      sourceStep: 'Adjusting',
      amount: schedule.monthlyDepreciation,
      dueTiming: 'Every month-end close',
      status: 'Open',
      generated: true,
    }),
  )

  const payrollDocuments = session.documents
    .filter((document) => document.docType === 'Payroll Summary' || document.party.toLowerCase().includes('payroll'))
    .map((document) =>
      item({
        id: `handover-recurring-payroll-${document.id}`,
        category: 'Recurring Monthly Entries',
        priority: 'Medium',
        description: `Review payroll support and statutory split for ${document.party}.`,
        sourceStep: 'WP1',
        amount: document.amount,
        dueTiming: 'Payroll processing week',
        status: 'Open',
        generated: true,
      }),
    )

  const loanSplitItems = session.splitDecisions
    .filter((decision) => decision.splitType === 'Loan repayment')
    .map((decision) => {
      const document = session.documents.find((doc) => doc.id === decision.documentId)
      const interestAmount = splitLineAmount(decision, (text) => text.includes('interest'))
      return item({
        id: `handover-recurring-loan-${decision.documentId}`,
        category: 'Recurring Monthly Entries',
        priority: 'Medium',
        description: `Use the loan repayment split pattern for ${document?.party ?? 'loan repayment'}.`,
        sourceStep: 'WP1',
        amount: interestAmount || document?.amount,
        dueTiming: 'When bank repayment appears',
        status: 'Open',
        generated: true,
      })
    })

  const recurringBankEntries = session.bankOnlyEntries
    .map((entry) => {
      const bankRow = session.bankRows.find((row) => row.id === entry.bankRowId)
      if (!bankRow) return null
      const recurring =
        bankRow.remarks.toLowerCase().includes('standing') ||
        bankRow.description.toLowerCase().includes('standing') ||
        bankRow.description.toLowerCase().includes('rent') ||
        entry.description.toLowerCase().includes('standing')
      if (!recurring) return null
      return item({
        id: `handover-recurring-bank-${entry.bankRowId}`,
        category: 'Recurring Monthly Entries',
        priority: 'Medium',
        description: `Check recurring bank-only entry: ${entry.description}.`,
        sourceStep: 'WP2',
        amount: bankRow.amount,
        dueTiming: 'When bank statement is received',
        status: 'Open',
        generated: true,
      })
    })
    .filter((entry): entry is HandoverItem => Boolean(entry))

  const openingBalanceItems = [
    item({
      id: 'handover-opening-bank',
      category: 'Opening Balance Reference',
      priority: 'Medium',
      description: `Closing bank balance for ${session.client.period}.`,
      sourceStep: 'WP2',
      amount: BANK_CLOSING_BALANCE,
      dueTiming: 'Opening reference for next session',
      status: 'Open',
      generated: true,
    }),
    item({
      id: 'handover-opening-book',
      category: 'Opening Balance Reference',
      priority: 'Medium',
      description: `Adjusted book balance after bank verification: RM ${reconciliation.adjustedBook.toLocaleString('en-MY', {
        minimumFractionDigits: 2,
      })}.`,
      sourceStep: 'WP2',
      amount: reconciliation.adjustedBook,
      dueTiming: 'Opening reference for next session',
      status: 'Open',
      generated: true,
    }),
    item({
      id: 'handover-opening-jv',
      category: 'Opening Balance Reference',
      priority: session.journalVoucherFinalised ? 'Low' : 'High',
      description: session.journalVoucherFinalised
        ? `${voucherReference(session.client.period)} finalised on ${new Date(
            session.journalVoucherFinalisedAt ?? new Date().toISOString(),
          ).toLocaleDateString('en-MY')}.`
        : `${voucherReference(session.client.period)} has not been finalised yet.`,
      sourceStep: 'JV',
      dueTiming: 'Before relying on next opening balances',
      status: 'Open',
      generated: true,
    }),
    item({
      id: 'handover-opening-validation',
      category: 'Opening Balance Reference',
      priority: validation.ready ? 'Low' : 'High',
      description: validation.ready
        ? 'Review and Validation currently has no critical issues.'
        : `${validation.summary.criticalIssues} critical validation item(s) remain.`,
      sourceStep: 'JV',
      dueTiming: 'Before final handover sign-off',
      status: 'Open',
      generated: true,
    }),
  ]

  const depreciationSchedules = session.depreciationSchedule.map((schedule) =>
    item({
      id: `handover-schedule-dep-${schedule.id}`,
      category: 'Schedules to Carry Forward',
      priority: 'Medium',
      description: `Carry forward depreciation schedule for ${schedule.assetDescription}, useful life ${schedule.usefulLifeMonths} months.`,
      sourceStep: 'Adjusting',
      amount: schedule.cost,
      dueTiming: 'Excel export and next session opening file',
      status: 'Open',
      generated: true,
    }),
  )

  const prepaidSchedules = session.splitDecisions
    .filter((decision) => decision.splitType === 'Prepayment')
    .map((decision) => {
      const document = session.documents.find((doc) => doc.id === decision.documentId)
      return item({
        id: `handover-schedule-prepaid-${decision.documentId}`,
        category: 'Schedules to Carry Forward',
        priority: 'Medium',
        description: `Carry forward prepaid schedule for ${document?.docRef ?? 'prepayment document'}.`,
        sourceStep: 'WP1',
        amount: splitLineAmount(decision, (text) => text.includes('prepaid') || text.includes('1120')),
        dueTiming: 'Excel export and next session opening file',
        status: 'Open',
        generated: true,
      })
    })

  const timingSchedules = session.timingItems.map((timing) => {
    const bankRow = session.bankRows.find((row) => row.id === timing.bankRowId)
    return item({
      id: `handover-schedule-timing-${timing.bankRowId}`,
      category: 'Schedules to Carry Forward',
      priority: 'High',
      description: `Carry forward timing schedule for ${bankRow?.reference ?? timing.timingType}.`,
      sourceStep: 'WP2',
      amount: timing.amount,
      dueTiming: 'Excel export and next bank verification',
      status: 'Open',
      generated: true,
    })
  })

  return [
    ...futureReversals,
    ...prepaymentMustDo,
    ...depreciationMustDo,
    ...timingWatchItems,
    ...unresolvedBankNotes,
    ...recurringDepreciation,
    ...payrollDocuments,
    ...loanSplitItems,
    ...recurringBankEntries,
    ...openingBalanceItems,
    ...depreciationSchedules,
    ...prepaidSchedules,
    ...timingSchedules,
  ]
}

export function refreshGeneratedHandoverItems(session: SampleSession) {
  return preserveGeneratedStatus(buildGeneratedHandoverItems(session), session.handoverItems)
}
