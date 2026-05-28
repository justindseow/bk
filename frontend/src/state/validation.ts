import { generateJournalLines } from './journalBuilder'
import type { JournalLine, SampleSession, WorkflowStepId } from '../types/session'

export type ValidationSeverity = 'Pass' | 'Warning' | 'Critical'

export interface ValidationIssue {
  id: string
  severity: Exclude<ValidationSeverity, 'Pass'>
  area: 'Debit / Credit' | 'WP1' | 'WP2' | 'Adjusting' | 'Handover'
  issue: string
  suggestedAction: string
  step: WorkflowStepId
}

export interface ValidationCheck {
  id: string
  label: string
  area: ValidationIssue['area']
  severity: ValidationSeverity
  detail: string
}

export interface ValidationResult {
  journalLines: JournalLine[]
  totalDebits: number
  totalCredits: number
  difference: number
  issues: ValidationIssue[]
  checks: ValidationCheck[]
  summary: {
    wp1Unresolved: number
    wp2Unresolved: number
    adjustingPending: number
    criticalIssues: number
    warningItems: number
  }
  ready: boolean
}

const BANK_CLOSING_BALANCE = 48320
const BOOK_BALANCE_BEFORE_BANK_ONLY = 42595

const moneyDiff = (left: number, right: number) => Number((left - right).toFixed(2))

const splitTotal = (session: SampleSession, documentId: string) =>
  session.splitDecisions
    .find((decision) => decision.documentId === documentId)
    ?.lines.reduce((sum, line) => sum + Number(line.amount || 0), 0) ?? 0

const addIssue = (
  issues: ValidationIssue[],
  checks: ValidationCheck[],
  issue: ValidationIssue,
  checkLabel: string,
) => {
  issues.push(issue)
  checks.push({
    id: `check-${issue.id}`,
    area: issue.area,
    label: checkLabel,
    severity: issue.severity,
    detail: issue.issue,
  })
}

export function validateDebitCredit(journalLines: JournalLine[]) {
  const totalDebits = journalLines.reduce((sum, line) => sum + line.debit, 0)
  const totalCredits = journalLines.reduce((sum, line) => sum + line.credit, 0)
  const difference = moneyDiff(totalDebits, totalCredits)
  return { totalDebits, totalCredits, difference }
}

export function calculateWp2Reconciliation(session: SampleSession) {
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
    difference: moneyDiff(adjustedBank, adjustedBook),
  }
}

export function buildValidationResults(session: SampleSession): ValidationResult {
  const journalLines = generateJournalLines(session)
  const debitCredit = validateDebitCredit(journalLines)
  const issues: ValidationIssue[] = []
  const checks: ValidationCheck[] = []

  if (Math.abs(debitCredit.difference) > 0.01) {
    addIssue(
      issues,
      checks,
      {
        id: 'dc-difference',
        severity: 'Critical',
        area: 'Debit / Credit',
        issue: 'Total debits and credits do not balance.',
        suggestedAction: 'Review posting, bank-only, and adjusting entries until the difference is RM 0.',
        step: 'review',
      },
      'Debit and credit balance',
    )
  } else {
    checks.push({
      id: 'check-dc-balance',
      area: 'Debit / Credit',
      label: 'Debit and credit balance',
      severity: 'Pass',
      detail: 'Total debits equal total credits.',
    })
  }

  session.documents.forEach((document) => {
    if (document.status === 'Needs Split') {
      addIssue(
        issues,
        checks,
        {
          id: `wp1-split-${document.id}`,
          severity: 'Critical',
          area: 'WP1',
          issue: `${document.docRef} still needs a split.`,
          suggestedAction: 'Open WP1 and confirm the split lines.',
          step: 'wp1',
        },
        'WP1 split rows resolved',
      )
    }

    if (document.status === 'Reclassify') {
      addIssue(
        issues,
        checks,
        {
          id: `wp1-reclass-${document.id}`,
          severity: 'Critical',
          area: 'WP1',
          issue: `${document.docRef} still needs reclassification.`,
          suggestedAction: 'Open WP1 and confirm the reclassification decision.',
          step: 'wp1',
        },
        'WP1 reclassifications completed',
      )
    }

    if (document.status === 'Pending Review' || !document.glAccount) {
      addIssue(
        issues,
        checks,
        {
          id: `wp1-gl-${document.id}`,
          severity: 'Critical',
          area: 'WP1',
          issue: `${document.docRef} is missing a confirmed GL account.`,
          suggestedAction: 'Open WP1 and update the GL account.',
          step: 'wp1',
        },
        'WP1 GL accounts completed',
      )
    }

    if (document.status === 'Split Done' && Math.abs(splitTotal(session, document.id) - document.amount) > 0.01) {
      addIssue(
        issues,
        checks,
        {
          id: `wp1-split-balance-${document.id}`,
          severity: 'Critical',
          area: 'WP1',
          issue: `${document.docRef} split total does not equal the document amount.`,
          suggestedAction: 'Open WP1 and correct the split lines.',
          step: 'wp1',
        },
        'WP1 split totals balanced',
      )
    }

    if (
      document.status === 'Reclassified' &&
      !session.reclassifyDecisions.some((decision) => decision.documentId === document.id)
    ) {
      addIssue(
        issues,
        checks,
        {
          id: `wp1-reclass-missing-${document.id}`,
          severity: 'Critical',
          area: 'WP1',
          issue: `${document.docRef} is marked reclassified but has no saved decision.`,
          suggestedAction: 'Open WP1 and save the reclassification again.',
          step: 'wp1',
        },
        'WP1 reclassification decisions saved',
      )
    }
  })

  if (!issues.some((issue) => issue.area === 'WP1')) {
    checks.push({
      id: 'check-wp1-clear',
      area: 'WP1',
      label: 'WP1 document posting complete',
      severity: 'Pass',
      detail: 'No unresolved split, reclassify, pending review, or missing GL rows.',
    })
  }

  session.bankRows.forEach((row) => {
    if (row.status === 'Needs Review') {
      addIssue(
        issues,
        checks,
        {
          id: `wp2-review-${row.id}`,
          severity: 'Critical',
          area: 'WP2',
          issue: `${row.description} still needs review.`,
          suggestedAction: 'Open WP2 and match the row or record it as a timing item.',
          step: 'wp2',
        },
        'WP2 bank rows resolved',
      )
    }

    if (row.status === 'New' && !session.bankOnlyEntries.some((entry) => entry.bankRowId === row.id)) {
      addIssue(
        issues,
        checks,
        {
          id: `wp2-new-${row.id}`,
          severity: 'Critical',
          area: 'WP2',
          issue: `${row.description} is a new bank row without a Bank+ entry.`,
          suggestedAction: 'Open WP2 and add the bank-only entry with a GL account.',
          step: 'wp2',
        },
        'WP2 new bank rows posted',
      )
    }

    if (row.status === 'Match Multiple') {
      addIssue(
        issues,
        checks,
        {
          id: `wp2-multi-${row.id}`,
          severity: 'Critical',
          area: 'WP2',
          issue: `${row.description} has not been confirmed as a multi-document match.`,
          suggestedAction: 'Open WP2 and confirm selected documents match the bank amount.',
          step: 'wp2',
        },
        'WP2 multi-document matches confirmed',
      )
    }
  })

  session.bankMatches
    .filter((match) => match.matchType === 'Multiple')
    .forEach((match) => {
      const row = session.bankRows.find((bankRow) => bankRow.id === match.bankRowId)
      const selectedTotal = match.documentIds.reduce((sum, documentId) => {
        const document = session.documents.find((item) => item.id === documentId)
        return document ? sum + document.amount : sum
      }, 0)

      if (row && Math.abs(selectedTotal - row.amount) > 0.01) {
        addIssue(
          issues,
          checks,
          {
            id: `wp2-multi-balance-${match.bankRowId}`,
            severity: 'Critical',
            area: 'WP2',
            issue: `${row.description} selected documents do not equal the bank amount.`,
            suggestedAction: 'Open WP2 and correct the multi-document selection.',
            step: 'wp2',
          },
          'WP2 multi-document totals balanced',
        )
      }
    })

  session.timingItems.forEach((item) => {
    if (!item.note.trim()) {
      addIssue(
        issues,
        checks,
        {
          id: `wp2-timing-note-${item.bankRowId}`,
          severity: 'Critical',
          area: 'WP2',
          issue: 'A timing item is missing its carry-forward note.',
          suggestedAction: 'Open WP2 and add a note for next month.',
          step: 'wp2',
        },
        'WP2 timing item notes completed',
      )
    } else {
      issues.push({
        id: `wp2-timing-warning-${item.bankRowId}`,
        severity: 'Warning',
        area: 'Handover',
        issue: `${item.timingType} will carry forward to next month.`,
        suggestedAction: 'Review this in the Handover Note later.',
        step: 'handover',
      })
    }
  })

  const reconciliation = calculateWp2Reconciliation(session)
  if (Math.abs(reconciliation.difference) > 0.01) {
    addIssue(
      issues,
      checks,
      {
        id: 'wp2-recon-difference',
        severity: 'Critical',
        area: 'WP2',
        issue: 'Bank reconciliation difference is not RM 0.',
        suggestedAction: 'Complete Bank+ entries and timing items until adjusted bank equals adjusted book.',
        step: 'wp2',
      },
      'WP2 reconciliation balanced',
    )
  } else if (!issues.some((issue) => issue.area === 'WP2' && issue.severity === 'Critical')) {
    checks.push({
      id: 'check-wp2-clear',
      area: 'WP2',
      label: 'WP2 bank verification complete',
      severity: 'Pass',
      detail: 'No unresolved bank rows and reconciliation difference is RM 0.',
    })
  }

  session.adjustingEntries.forEach((entry) => {
    if (!entry.debitAccount || !entry.creditAccount) {
      addIssue(
        issues,
        checks,
        {
          id: `adj-account-${entry.id}`,
          severity: 'Critical',
          area: 'Adjusting',
          issue: `${entry.description} is missing an account.`,
          suggestedAction: 'Open Adjusting Entries and complete the accounts.',
          step: 'adjusting',
        },
        'Adjusting entry accounts completed',
      )
    }

    if (entry.amount <= 0) {
      addIssue(
        issues,
        checks,
        {
          id: `adj-amount-${entry.id}`,
          severity: 'Critical',
          area: 'Adjusting',
          issue: `${entry.description} has a zero or negative amount.`,
          suggestedAction: 'Open Adjusting Entries and correct the amount.',
          step: 'adjusting',
        },
        'Adjusting entry amounts valid',
      )
    }

    if (entry.status === 'Pending Review') {
      addIssue(
        issues,
        checks,
        {
          id: `adj-pending-${entry.id}`,
          severity: 'Critical',
          area: 'Adjusting',
          issue: `${entry.description} is still pending review.`,
          suggestedAction: 'Open Adjusting Entries and complete or remove the entry.',
          step: 'adjusting',
        },
        'Adjusting entries reviewed',
      )
    }

    if (entry.reverseNextMonth) {
      issues.push({
        id: `handover-reversal-${entry.id}`,
        severity: 'Warning',
        area: 'Handover',
        issue: `${entry.description} is marked to reverse next month.`,
        suggestedAction: 'Review this in the Handover Note later.',
        step: 'handover',
      })
    }
  })

  session.priorAccruals
    .filter((accrual) => accrual.status === 'Pending')
    .forEach((accrual) => {
      addIssue(
        issues,
        checks,
        {
          id: `adj-reversal-due-${accrual.id}`,
          severity: 'Critical',
          area: 'Adjusting',
          issue: `${accrual.description} is due for reversal this month.`,
          suggestedAction: 'Open Adjusting Entries and confirm the reversal.',
          step: 'adjusting',
        },
        'Prior accrual reversals completed',
      )
    })

  session.depreciationSchedule.forEach((item) => {
    if (item.status === 'Ready to Post') {
      addIssue(
        issues,
        checks,
        {
          id: `adj-dep-ready-${item.id}`,
          severity: 'Critical',
          area: 'Adjusting',
          issue: `${item.assetDescription} depreciation has not been posted.`,
          suggestedAction: 'Open Adjusting Entries and post monthly depreciation.',
          step: 'adjusting',
        },
        'Depreciation entries posted',
      )
    }

    issues.push({
      id: `handover-dep-${item.id}`,
      severity: 'Warning',
      area: 'Handover',
      issue: `${item.assetDescription} is on the depreciation schedule.`,
      suggestedAction: 'Include it in the Excel depreciation schedule later.',
      step: 'download',
    })
  })

  if (!issues.some((issue) => issue.area === 'Adjusting' && issue.severity === 'Critical')) {
    checks.push({
      id: 'check-adjusting-clear',
      area: 'Adjusting',
      label: 'Adjusting entries complete',
      severity: 'Pass',
      detail: 'Adjusting entries are balanced and required period-end actions are complete.',
    })
  }

  if (session.futureReversalItems.length) {
    checks.push({
      id: 'check-handover-reversals',
      area: 'Handover',
      label: 'Future reversals prepared',
      severity: 'Warning',
      detail: 'Accrual reversals are ready for the later handover note.',
    })
  }

  if (session.timingItems.length) {
    checks.push({
      id: 'check-handover-timing',
      area: 'Handover',
      label: 'Timing items prepared',
      severity: 'Warning',
      detail: 'Timing items are ready for the later handover note.',
    })
  }

  if (session.depreciationSchedule.length) {
    checks.push({
      id: 'check-export-depreciation',
      area: 'Handover',
      label: 'Depreciation schedule prepared',
      severity: 'Warning',
      detail: 'Depreciation schedule data is ready for later Excel export.',
    })
  }

  const criticalIssues = issues.filter((issue) => issue.severity === 'Critical').length
  const warningItems = issues.filter((issue) => issue.severity === 'Warning').length

  return {
    journalLines,
    totalDebits: debitCredit.totalDebits,
    totalCredits: debitCredit.totalCredits,
    difference: debitCredit.difference,
    issues,
    checks,
    summary: {
      wp1Unresolved: issues.filter((issue) => issue.area === 'WP1' && issue.severity === 'Critical').length,
      wp2Unresolved: issues.filter((issue) => issue.area === 'WP2' && issue.severity === 'Critical').length,
      adjustingPending: issues.filter(
        (issue) => issue.area === 'Adjusting' && issue.severity === 'Critical',
      ).length,
      criticalIssues,
      warningItems,
    },
    ready: criticalIssues === 0,
  }
}
