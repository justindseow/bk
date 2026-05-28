import { cashAccount, findAccount } from '../data/accounts'
import type { JournalLine, SampleSession, SourceDocument } from '../types/session'

const parseAccount = (accountText: string) => {
  const [code = '', ...nameParts] = accountText.split(' - ')
  const fromList = findAccount(code.trim())
  return {
    code: fromList?.code ?? code.trim(),
    name: fromList?.name ?? nameParts.join(' - ').trim(),
  }
}

const buildCashLine = (document: SourceDocument, source: JournalLine['source'], index: number): JournalLine => {
  const isCashIn = document.flow === 'IN'
  return {
    id: `${document.id}-cash-${index}`,
    documentId: document.id,
    date: document.date,
    description: isCashIn ? `${document.party} - cash received` : `${document.party} - cash paid`,
    accountCode: cashAccount.code,
    accountName: cashAccount.name,
    debit: isCashIn ? document.amount : 0,
    credit: isCashIn ? 0 : document.amount,
    source,
  }
}

const buildPostedLines = (document: SourceDocument): JournalLine[] => {
  const account = parseAccount(document.glAccount)
  if (!account.code) return []

  const documentLine: JournalLine = {
    id: `${document.id}-doc-1`,
    documentId: document.id,
    date: document.date,
    description: document.party,
    accountCode: account.code,
    accountName: account.name,
    debit: document.flow === 'OUT' ? document.amount : 0,
    credit: document.flow === 'IN' ? document.amount : 0,
    source: 'Doc',
  }

  return document.flow === 'IN'
    ? [buildCashLine(document, 'Doc', 0), documentLine]
    : [documentLine, buildCashLine(document, 'Doc', 0)]
}

const buildSplitLines = (session: SampleSession, document: SourceDocument): JournalLine[] => {
  const split = session.splitDecisions.find((decision) => decision.documentId === document.id)
  if (!split) return []

  const splitLines = split.lines.map((line, index) => ({
    id: `${document.id}-split-${line.id}-${index}`,
    documentId: document.id,
    date: document.date,
    description: line.description,
    accountCode: line.accountCode,
    accountName: line.accountName,
    debit: line.direction === 'DR' ? line.amount : 0,
    credit: line.direction === 'CR' ? line.amount : 0,
    source: 'Split' as const,
  }))

  return document.flow === 'IN'
    ? [buildCashLine(document, 'Split', 0), ...splitLines]
    : [...splitLines, buildCashLine(document, 'Split', 0)]
}

const reclassDebitCredit = (document: SourceDocument) => {
  if (document.flow === 'OUT') {
    return {
      debit: document.amount,
      credit: 0,
      cashDebit: 0,
      cashCredit: document.amount,
    }
  }

  return {
    debit: 0,
    credit: document.amount,
    cashDebit: document.amount,
    cashCredit: 0,
  }
}

const buildReclassifyLines = (session: SampleSession, document: SourceDocument): JournalLine[] => {
  const decision = session.reclassifyDecisions.find((item) => item.documentId === document.id)
  if (!decision) return []

  const values = reclassDebitCredit(document)
  const reclassLine: JournalLine = {
    id: `${document.id}-reclass-1`,
    documentId: document.id,
    date: document.date,
    description:
      decision.reclassifyType === 'Asset purchase'
        ? `${document.party} - capitalised`
        : `${document.party} - ${decision.directorNature}`,
    accountCode: decision.accountCode,
    accountName: decision.accountName,
    debit: values.debit,
    credit: values.credit,
    source: 'Reclassify',
  }
  const cashLine: JournalLine = {
    ...buildCashLine(document, 'Reclassify', 0),
    debit: values.cashDebit,
    credit: values.cashCredit,
  }

  return document.flow === 'IN' ? [cashLine, reclassLine] : [reclassLine, cashLine]
}

export function generateDraftJournalLinesFromWP1(session: SampleSession): JournalLine[] {
  return session.documents.flatMap((document) => {
    if (document.status === 'Split Done') return buildSplitLines(session, document)
    if (document.status === 'Reclassified') return buildReclassifyLines(session, document)
    if (document.status === 'Posted') return buildPostedLines(document)
    return []
  })
}
