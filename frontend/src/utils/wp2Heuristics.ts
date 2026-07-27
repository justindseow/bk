import { findAccount, formatAccount } from '../data/accounts'
import type { BankRow, BankStatus, SourceDocument } from '../types/session'

type BankRowSeed = Pick<BankRow, 'date' | 'description' | 'reference' | 'amount' | 'direction'>

type BankOnlySuggestion = {
  accountCode: string
  accountLabel: string
  reason: string
}

type ImportedBankRowDecision = {
  status: BankStatus
  matchedTo: string
  remarks: string
  suggestedDocumentIds?: string[]
}

type BankOnlyRule = {
  accountCode: string
  reason: string
  keywords: string[]
  direction?: BankRow['direction']
}

const bankOnlyRules: BankOnlyRule[] = [
  {
    accountCode: '6370',
    direction: 'DR',
    reason: 'Likely bank charges or fees.',
    keywords: [
      'bank charge',
      'bank charges',
      'bank fee',
      'service charge',
      'monthly service fee',
      'cash management fee',
      'processing fee',
      'annual fee',
    ],
  },
  {
    accountCode: '6200',
    direction: 'DR',
    reason: 'Likely rent or standing-instruction rental payment.',
    keywords: [
      'monthly rent',
      'standing rent',
      'standing instruction',
      'standing instr',
      'rental',
      'rent',
      'landlord',
      'property',
      'tenancy',
    ],
  },
  {
    accountCode: '6210',
    direction: 'DR',
    reason: 'Likely utilities, telco, or recurring service bill.',
    keywords: [
      'tnb',
      'tenaga',
      'electricity',
      'air selangor',
      'water bill',
      'utilities',
      'indah water',
      'telekom',
      'unifi',
      'maxis',
      'celcom',
      'digi',
      'utility',
    ],
  },
  {
    accountCode: '6600',
    direction: 'DR',
    reason: 'Likely finance charge or interest expense.',
    keywords: ['interest charged', 'loan interest', 'od interest', 'finance charge', 'interest payment'],
  },
  {
    accountCode: '6390',
    direction: 'DR',
    reason: 'Likely tax-related bank payment.',
    keywords: ['lhdn', 'sst', 'tax payment', 'cp204', 'e pcb', 'pcb'],
  },
  {
    accountCode: '7100',
    direction: 'CR',
    reason: 'Likely interest income credited by the bank.',
    keywords: ['interest credit', 'interest paid', 'interest income', 'credit interest'],
  },
]

const settlementKeywords = [
  'dep merchant',
  'dep-merchant',
  'merchant pymt',
  'merchant payment',
  'merchant payout',
  'mastercard pymt',
  'visa card pymt',
  'duitnow qr cr',
  'duitnow qr',
  'qr payment',
  'qr pymt',
  'rpp cr',
  'settlement',
  'payout',
  'card pymt',
]

const tokenize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)

const normalize = (value: string) => tokenize(value).join(' ')

const dateDay = (date: string) => Number(date.slice(0, 2))

const flowMatchesDirection = (document: SourceDocument, bankRow: BankRowSeed) =>
  (document.flow === 'IN' && bankRow.direction === 'CR') ||
  (document.flow === 'OUT' && bankRow.direction === 'DR')

export const scoreDocumentMatch = (document: SourceDocument, bankRow: BankRowSeed) => {
  let score = 0
  if (!flowMatchesDirection(document, bankRow)) return score

  const amountDifference = Math.abs(document.amount - bankRow.amount)
  if (amountDifference < 0.01) {
    score += 5
  } else if (amountDifference <= 1) {
    score += 2
  }

  const normalizedDocRef = normalize(document.docRef)
  const normalizedBankRef = normalize(bankRow.reference)
  if (normalizedBankRef && normalizedDocRef === normalizedBankRef) {
    score += 6
  } else if (
    normalizedBankRef &&
    normalizedDocRef &&
    (normalizedDocRef.includes(normalizedBankRef) || normalizedBankRef.includes(normalizedDocRef))
  ) {
    score += 4
  }

  if (normalizedDocRef && /^\d{3,}$/.test(normalizedDocRef)) {
    const descriptionTokens = new Set(tokenize(bankRow.description))
    if (descriptionTokens.has(normalizedDocRef)) {
      score += 4
    }
  }

  if (bankRow.date && document.date && Math.abs(dateDay(document.date) - dateDay(bankRow.date)) <= 3) {
    score += 2
  }

  const docWords = new Set(tokenize(`${document.party} ${document.docRef}`))
  const bankWords = tokenize(`${bankRow.description} ${bankRow.reference}`)
  score += bankWords.filter((word) => docWords.has(word)).length

  const normalizedParty = normalize(document.party)
  const normalizedDescription = normalize(bankRow.description)
  if (
    normalizedParty &&
    normalizedDescription &&
    (normalizedDescription.includes(normalizedParty) || normalizedParty.includes(normalizedDescription))
  ) {
    score += 3
  }

  return score
}

export const suggestedDocumentsForBankRow = (documents: SourceDocument[], bankRow: BankRowSeed) =>
  documents
    .map((document) => ({ document, score: scoreDocumentMatch(document, bankRow) }))
    .filter((item) => item.score >= 5)
    .sort((left, right) => right.score - left.score)
    .map((item) => item.document)

export const bankOnlySuggestionForRow = (bankRow: BankRowSeed): BankOnlySuggestion | null => {
  const haystack = ` ${normalize(`${bankRow.description} ${bankRow.reference}`)} `
  const matchedRule = bankOnlyRules.find((rule) => {
    if (rule.direction && rule.direction !== bankRow.direction) return false
    return rule.keywords.some((keyword) => haystack.includes(` ${normalize(keyword)} `))
  })

  if (!matchedRule) return null
  const account = findAccount(matchedRule.accountCode)
  if (!account) return null

  return {
    accountCode: matchedRule.accountCode,
    accountLabel: formatAccount(account),
    reason: matchedRule.reason,
  }
}

export const isLikelySettlementRow = (bankRow: BankRowSeed) => {
  if (bankRow.direction !== 'CR') return false
  const haystack = ` ${normalize(`${bankRow.description} ${bankRow.reference}`)} `
  return settlementKeywords.some((keyword) => haystack.includes(` ${normalize(keyword)} `))
}

const bestSingleMatch = (documents: SourceDocument[], bankRow: BankRowSeed) => {
  const suggested = suggestedDocumentsForBankRow(documents, bankRow)
  return suggested[0] ?? null
}

const combinationSearch = (
  documents: SourceDocument[],
  targetAmount: number,
  maxDepth: number,
): SourceDocument[] => {
  const eligible = documents
    .filter((document) => document.amount > 0 && document.amount <= targetAmount + 0.01)
    .slice(0, 10)

  const walk = (startIndex: number, chosen: SourceDocument[], total: number): SourceDocument[] | null => {
    if (Math.abs(total - targetAmount) < 0.01) return chosen
    if (chosen.length >= maxDepth || total > targetAmount + 0.01) return null

    for (let index = startIndex; index < eligible.length; index += 1) {
      const next = eligible[index]
      const result = walk(index + 1, [...chosen, next], total + next.amount)
      if (result) return result
    }
    return null
  }

  return walk(0, [], 0) ?? []
}

export const classifyImportedBankRow = (
  documents: SourceDocument[],
  bankRow: BankRowSeed,
  hasWeakFields: boolean,
): ImportedBankRowDecision => {
  const bankOnlySuggestion = bankOnlySuggestionForRow(bankRow)
  const suggested = suggestedDocumentsForBankRow(documents, bankRow)
  const topSuggestedIds = suggested.slice(0, 4).map((document) => document.id)
  const singleMatch = bestSingleMatch(documents, bankRow)

  if (hasWeakFields) {
    return {
      status: 'Needs Review',
      matchedTo: topSuggestedIds.length ? suggested.slice(0, 2).map((document) => document.docRef).join(' + ') : 'Review against WP1',
      suggestedDocumentIds: topSuggestedIds,
      remarks: 'Imported from source intake. Review missing bank amount, reference, or date.',
    }
  }

  if (isLikelySettlementRow(bankRow)) {
    const groupedMatch = combinationSearch(suggested, bankRow.amount, 4)
    if (groupedMatch.length >= 2) {
      return {
        status: 'Match Multiple',
        matchedTo: groupedMatch.map((document) => document.docRef).join(' + '),
        suggestedDocumentIds: groupedMatch.map((document) => document.id),
        remarks: 'Imported from source intake. Likely grouped merchant or settlement receipt.',
      }
    }

    if (suggested[0] && Math.abs(suggested[0].amount - bankRow.amount) < 0.01) {
      return {
        status: 'Proposed Match',
        matchedTo: suggested[0].docRef,
        suggestedDocumentIds: [suggested[0].id],
        remarks: 'Imported from source intake. Settlement amount matches a WP1 document. Confirm to mark as matched.',
      }
    }

    return {
      status: 'Needs Review',
      matchedTo:
        topSuggestedIds.length > 0
          ? suggested.slice(0, 2).map((document) => document.docRef).join(' + ')
          : 'Likely sales settlement. Review against merchant or grouped WP1 sales.',
      suggestedDocumentIds: topSuggestedIds,
      remarks: 'Imported from source intake. Incoming settlement row should be checked against WP1 receipts or summaries.',
    }
  }

  if (singleMatch) {
    const exactAmount = Math.abs(singleMatch.amount - bankRow.amount) < 0.01
    return {
      status: exactAmount ? 'Proposed Match' : 'Needs Review',
      matchedTo: singleMatch.docRef,
      suggestedDocumentIds: [singleMatch.id],
      remarks: exactAmount
        ? 'Imported from source intake. Amount matches a WP1 document. Confirm to mark as matched.'
        : 'Imported from source intake. A likely WP1 match was found for confirmation.',
    }
  }

  if (bankOnlySuggestion) {
    return {
      status: 'New',
      matchedTo: `Likely Bank+ - ${bankOnlySuggestion.accountLabel}`,
      remarks: `Imported from source intake. ${bankOnlySuggestion.reason}`,
    }
  }

  return {
    status: bankRow.direction === 'CR' ? 'Needs Review' : 'Needs Review',
    matchedTo:
      bankRow.direction === 'CR'
        ? 'Review incoming receipt or settlement against WP1.'
        : 'Review outgoing payment against WP1 or post as Bank+.',
    remarks:
      bankRow.direction === 'CR'
        ? 'Imported from source intake. No confident direct match was found for this incoming row.'
        : 'Imported from source intake. No confident direct match was found for this outgoing row.',
  }
}
