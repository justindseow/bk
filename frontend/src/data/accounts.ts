import type { AccountOption, DocumentType } from '../types/session'

export const cashAccount: AccountOption = {
  code: '1020',
  name: 'CIMB Current Account',
  category: 'Current Asset',
  normalBalance: 'DR',
}

export const accountOptions: AccountOption[] = [
  cashAccount,
  { code: '1120', name: 'Prepaid Expenses', category: 'Current Asset', normalBalance: 'DR' },
  { code: '1530', name: 'Office Equipment', category: 'Non-current Asset', normalBalance: 'DR' },
  { code: '1590', name: 'Accumulated Depreciation', category: 'Contra Asset', normalBalance: 'CR' },
  { code: '2110', name: 'Accrued Liabilities', category: 'Current Liability', normalBalance: 'CR' },
  { code: '2400', name: 'EPF Payable', category: 'Current Liability', normalBalance: 'CR' },
  { code: '2410', name: 'SOCSO Payable', category: 'Current Liability', normalBalance: 'CR' },
  { code: '2420', name: 'EIS Payable', category: 'Current Liability', normalBalance: 'CR' },
  { code: '2430', name: 'PCB / MTD Payable', category: 'Current Liability', normalBalance: 'CR' },
  { code: '2700', name: 'Term Loan Payable', category: 'Non-current Liability', normalBalance: 'CR' },
  { code: '2800', name: "Director's Loan Payable", category: 'Current Liability', normalBalance: 'CR' },
  { code: '3100', name: 'Paid-Up Capital', category: 'Equity', normalBalance: 'CR' },
  { code: '3200', name: "Director's Drawing", category: 'Equity', normalBalance: 'DR' },
  { code: '4100', name: 'Sales Revenue', category: 'Revenue', normalBalance: 'CR' },
  { code: '4120', name: 'F&B Revenue', category: 'Revenue', normalBalance: 'CR' },
  { code: '5020', name: 'Direct Materials', category: 'Cost of Sales', normalBalance: 'DR' },
  { code: '6100', name: 'Salaries & Wages', category: 'Expense', normalBalance: 'DR' },
  { code: '6110', name: 'Employer EPF', category: 'Expense', normalBalance: 'DR' },
  { code: '6120', name: 'Employer SOCSO', category: 'Expense', normalBalance: 'DR' },
  { code: '6130', name: 'Employer EIS', category: 'Expense', normalBalance: 'DR' },
  { code: '6200', name: 'Rent Expense', category: 'Expense', normalBalance: 'DR' },
  { code: '6210', name: 'Utilities Electricity', category: 'Expense', normalBalance: 'DR' },
  { code: '6370', name: 'Bank Charges & Fees', category: 'Expense', normalBalance: 'DR' },
  { code: '6380', name: 'Insurance Expense', category: 'Expense', normalBalance: 'DR' },
  { code: '6390', name: 'Tax Payments', category: 'Expense', normalBalance: 'DR' },
  { code: '6600', name: 'Interest Expense', category: 'Expense', normalBalance: 'DR' },
  { code: '7100', name: 'Interest Income', category: 'Other Income', normalBalance: 'CR' },
  { code: '6700', name: 'Depreciation Expense', category: 'Expense', normalBalance: 'DR' },
]

export const formatAccount = (account: AccountOption) => `${account.code} - ${account.name}`

export const findAccount = (code: string) => accountOptions.find((account) => account.code === code)

export const accountsForDocumentType = (docType: DocumentType) => {
  const preferredCodes: Record<DocumentType, string[]> = {
    'Sales Invoice': ['4100', '4120'],
    'Purchase Invoice': ['5020', '6200', '6210', '6380'],
    'Payment Voucher': ['5020', '6200', '6210', '6380', '1530', '2700'],
    Receipt: ['4100', '4120', '2800', '3100'],
    'Payroll Summary': ['6100', '6110', '6120', '6130', '2400', '2410', '2420', '2430'],
    'Loan / HP Statement': ['2700', '6600'],
    'Merchant Statement': ['4120', '6370'],
    'Utility Bill': ['6210', '2110'],
  }

  const preferred = preferredCodes[docType]
    .map((code) => findAccount(code))
    .filter((account): account is AccountOption => Boolean(account))
  const extras = accountOptions.filter((account) => !preferred.some((item) => item.code === account.code))
  return [...preferred, ...extras]
}
