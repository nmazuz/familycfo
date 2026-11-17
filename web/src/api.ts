export interface Member { id: number; name: string; color: string | null }
export interface Account {
  id: string; company: string; kind: 'bank' | 'card' | 'manual'; displayName: string | null; ownerMemberId: number | null;
  billingBankAccountId: string | null; cardFrame: number | null; active: number; lastScrapedAt: string | null;
}
export interface Category { id: number; name: string; parentId: number | null; kind: string; defaultFixed: number; discretionary: number }
export interface Business { id: number; name: string; color: string | null; archived: number }
export interface Tag {
  id: number; name: string; color: string | null; startDate: string | null; endDate: string | null;
  budget: number | null; notes: string | null; archived: number;
}
export interface Fund { id: number; name: string; monthlyTarget: number; balance: number; goalAmount: number | null; goalDate: string | null }
export interface Meta {
  members: Member[]; accounts: Account[]; categories: Category[]; businesses: Business[]; tags: Tag[]; funds: Fund[];
  settings: Record<string, string>;
}

export interface Tx {
  id: number; accountId: string; accountName?: string; accountKind: 'bank' | 'card' | 'manual'; date: string; processedDate: string;
  effectiveDate: string; description: string; merchant: string; amount: number; personalAmount: number; businessAmount: number;
  kind: string; categoryId: number | null; categoryName: string | null; categoryParentId?: number | null; categoryParentName?: string | null; fixed: boolean; memberId: number; businessId: number | null;
  status: string | null; txnType: string | null; installmentNumber: number | null; installmentTotal: number | null;
  tagIds: number[]; paybackTotal: number; linkedInflow: boolean; categorySource: string | null; notes: string | null; excluded?: boolean;
  matchedTxnId?: number | null; settledByTxnId?: number | null;
  /** the other side of an immediate card charge (bank "ויזה" row ↔ card purchase) */
  link?: { id: number; description: string; account: string | null; date: string } | null;
}

export interface Cycle { key: string; start: string; end: string }
export interface CategorySpend { categoryId: number | null; name: string; parentId: number | null; parentName: string | null; spend: number; fixed: number; dynamic: number; count: number }
export interface CycleSummary {
  cycle: Cycle; income: number; spend: number; fixed: number; dynamic: number; net: number; savingsDeposits: number; txCount: number;
  byCategory: CategorySpend[]; byMember: Record<string, { income: number; spend: number }>;
  byBusiness: Record<string, { income: number; spend: number }>;
}
export interface BudgetStatus {
  budgetId: number | null; categoryId: number; categoryName: string; parentId: number | null; memberId: number | null; budget: number | null;
  spent: number; pct: number | null; planned: number; projected: number; remaining: number | null; typical: number;
  status: 'ok' | 'warning' | 'over' | 'none';
}
export interface CardCharge {
  cardAccountId: string; company: string; displayName: string; chargeDate: string; knownAmount: number; projectedInstallments: number; typicalAmount: number;
  projectedFixed: number; fixedItems: { scheduledId: number; name: string; amount: number; purchaseDate: string }[];
  expectedAmount: number; transactions: number; billingBankAccountId: string | null; typicalChargeDay: number | null;
  /** reported everyday purchases / typical everyday purchases of a statement (no installments or listed fixed payments) */
  knownVariable: number; typicalVariable: number;
  /** planned one-off purchases (entered in advance) the card hasn't reported yet */
  projectedPlanned: number; plannedItems: { plannedId: number; name: string; amount: number; n: number; of: number }[];
}
export interface ForecastPoint { date: string; expected: number; low: number; high: number }
export interface AccountForecast {
  accountId: string; displayName: string; ownerMemberId: number | null; startBalance: number; balanceDate: string | null;
  stale: boolean; points?: ForecastPoint[]; lowest: { date: string; amount: number }; endOfCycle: number; dailyRate: number;
  shortfall: { amount: number; by: string | null };
}
export interface ForecastEvent {
  date: string; accountId: string; name: string; kind: string; amount: number; memberId: number | null; estimated: boolean; source: string;
  cardAccountId?: string | null;
}
export interface Forecast {
  asOf: string; cycle: Cycle;
  /** the month being planned: the current cycle, or the next one in its last days */
  period: Cycle; horizonEnd: string; buffer: number; accounts: AccountForecast[]; total: AccountForecast;
  events: ForecastEvent[]; remaining: { income: number; scheduledOut: number; cardCharges: number; dynamic: number }; warnings: string[];
}
export interface Alert {
  id: number; type: string; severity: 'info' | 'warning' | 'critical'; title: string; message: string; txnIds: string | null;
  createdAt: string; seenAt: string | null; dismissedAt: string | null;
}
export interface SavingsCapacity {
  expectedIncome: number; averageFixed: number; averageDynamic: number; irregularReserve: number; monthsUsed: string[]; monthlyCapacity: number;
  allocation: { fundId: number; name: string; amount: number }[];
}
export interface IncomeExpectation {
  recurring: { name: string; accountId: string; typicalAmount: number; typicalDay: number; memberId: number }[];
  recurringTotal: number; irregularAverage: number; expectedMonthly: number;
}
export interface Summary {
  cycle: CycleSummary;
  balances: { id: string; display_name: string | null; owner_member_id: number | null; balance: number; balanceDate: string | null }[];
  forecast: Omit<Forecast, 'asOf' | 'horizonEnd'>;
  cardCharges: CardCharge[]; budgets: BudgetStatus[]; alerts: Alert[]; capacity: SavingsCapacity; income: IncomeExpectation;
  monthIncome: MonthIncome;
}
/** A month's income: what arrived + recurring income still expected before it ends. */
export interface MonthIncome {
  cycle: Cycle; received: number; pending: number; total: number; other: number;
  recurring: { name: string; accountId: string; memberId: number; amount: number; date: string; received: boolean }[];
}
export interface TightMonthPlan {
  isTight: boolean; reasons: string[]; gap: number;
  cuts: { categoryId: number | null; name: string; spentSoFar: number; typical: number; projected: number; suggestedCut: number }[];
}
export interface Recommendation {
  key: string; type: string; title: string; detail: string; monthlySaving: number; annualSaving: number;
  examples: { description: string; amount: number }[];
}
export interface InstallmentPlan {
  description: string; cardAccountId: string; memberId: number; purchaseDate: string; installmentAmount: number;
  paid: number; total: number; remaining: number; nextChargeDate: string | null; lastChargeMonth: string;
  remainingAmount: number; schedule: Record<string, number>;
  projected: { date: string; amount: number }[];
}
export interface ScheduledItem {
  id: number; name: string; kind: string; amount: number; amountMode: 'fixed' | 'estimated'; dayOfMonth: number;
  bankAccountId: string | null; memberId: number | null; categoryId: number | null; matchPattern: string | null;
  cardAccountId: string | null; liabilityId: number | null; startDate: string | null; endDate: string | null;
  status: 'suggested' | 'confirmed' | 'dismissed';
}
export interface NetWorthItem {
  id: string; name: string; group: 'bank' | 'asset' | 'card_debt' | 'liability'; type: string; ownerMemberId: number | null;
  provider: string | null; currency: string; value: number; valueIls: number; asOf: string | null; liquidityDate: string | null;
}
export interface NetWorth {
  asOf: string; items: NetWorthItem[]; totals: { assets: number; liabilities: number; netWorth: number; liquid: number };
  byType: Record<string, number>; byOwner: Record<string, number>; history: { date: string; netWorth: number }[];
}
export interface Asset {
  id: number; name: string; type: string; provider: string | null; ownerMemberId: number | null; currency: string;
  liquidityDate: string | null; managementFee: string | null; monthlyDeposit: number | null; notes: string | null; archived: number;
}
export interface Liability {
  id: number; name: string; type: string; lender: string | null; ownerMemberId: number | null; originalPrincipal: number | null;
  interestRate: number | null; indexType: string | null; startDate: string | null; endDate: string | null;
  monthlyPayment: number | null; paymentDay: number | null; bankAccountId: string | null; matchPattern: string | null;
  notes: string | null; archived: number;
}
export interface Link {
  id: number; fromTxnId: number; toTxnId: number; type: string; amount: number; status: string;
  fromDescription: string; fromDate: string; fromAmount: number; toDescription: string; toDate: string; toAmount: number;
}
export interface Rule {
  id: number; matchType: string; pattern: string; accountId: string | null; setCategoryId: number | null;
  setBusinessId: number | null; setBusinessSharePct: number | null; setMemberId: number | null; setKind: string | null; setTagIds: string | null;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

/** Build a query string from defined values. */
export function qs(params: Record<string, string | number | undefined | null | (string | number)[]>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export interface Commitment {
  id: number; name: string; kind: string; status: 'confirmed' | 'suggested';
  categoryId: number | null; categoryName: string | null; parentId: number | null; parentName: string | null;
  method: 'bank' | 'card'; accountId: string; memberId: number | null; day: number; dueDate: string;
  expected: number; actual: number; state: 'paid' | 'partial' | 'pending' | 'missing'; txIds: number[];
  estimated: boolean; liabilityId: number | null;
  payingAccountId: string | null; chargeDate: string | null;
}
export interface MonthPlan {
  cycle: { key: string; start: string; end: string }; asOf: string; commitments: Commitment[];
  fixed: { expected: number; paid: number; remaining: number; total: number };
  otherFixed: { amount: number; count: number };
  installments: { total: number; paid: number; items: { description: string; accountId: string; amount: number; date: string; number: number | null; of: number | null; known: boolean }[] };
  income: number; incomeReceived: number; incomePending: number; forVariable: number; variableSpent: number; variableLeft: number; daysLeft: number; perDayLeft: number;
  billing: Record<string, string | null>;
  planned: { total: number; items: MonthPlanned[] };
}
export interface MonthPlanned {
  id: number; description: string; accountId: string; accountKind: string; date: string; installments: number; amount: number;
  status: 'planned' | 'matched'; matchedTxnId: number | null; categoryId: number | null; memberId: number; overdue: boolean;
  candidates: { id: number; description: string; date: string; amount: number }[];
}
/** [last month, YTD, 12 months, 3 years, 5 years, 3-year avg, 5-year avg] in % */
export type TrackReturns = (number | null)[];
export interface PensionProduct {
  id: number; name: string; type: 'pension' | 'keren_hishtalmut' | 'kupat_gemel'; provider: string | null; ownerMemberId: number | null;
  value: number | null; valueDate: string | null; liquidityDate: string | null; managementFee: string | null; monthlyDeposit: number | null;
  policyNumber: string | null; employer: string | null; status: 'active' | 'inactive' | null; joinDate: string | null;
  feeDepositPct: number | null; feeBalancePct: number | null; expectedAnnuity: number | null; notes: string | null; liquidNow: boolean;
  details: {
    product: string; tracks: { name: string; share: number; balance: number; returns: TrackReturns }[];
    components: { pitzuyim: number; tagmulim: number; capital: number } | null;
    coverages: { name: string; pct: number; monthly: number }[]; coverageCost: { disability: number; survivors: number } | null;
    insuredSalary: number | null; expectedAnnuityWithDeposits: number | null; lastDeposit: string | null; agentOfRecord: string | null;
  } | null;
  deposits: { valueDate: string; salaryMonth: string | null; salary: number | null; employee: number | null; employer: number | null; severance: number | null; total: number }[];
}
export interface PensionReportSummary {
  totalSavings: number; ytdReturnPct: number; lifeHealthMonthlyPremium: number;
  byProductType: { name: string; amount: number; pct: number }[]; byProvider: { name: string; amount: number; pct: number }[];
  tradedPct: { traded: number; nonTraded: number }; exposurePct: { stocks: number; abroad: number; foreignCurrency: number };
  assetMixPct: { name: string; pct: number }[];
  monthlyDeposits: Record<string, number> & { total: number };
  expectedAnnuity: { pensionWithoutDeposits: number; pensionWithDeposits: number; managers: number; totalWithoutDeposits: number };
  coverage: { disability: number; death: number; noInfo: string[] };
  agent: { name: string; agency?: string; phone?: string; email?: string } | null; issuedAt: string | null;
}
export interface PensionOverview {
  products: PensionProduct[];
  report: { id: number; asOf: string; source: string; memberId: number | null; documentPath: string | null; summary: PensionReportSummary } | null;
  totals: {
    value: number; byType: Record<string, number>; monthlyDeposits: number; expectedAnnuity: number; active: number;
    inactive: { count: number; value: number }; liquidStudyFunds: { count: number; value: number };
  };
}
export type InsuranceType = 'health' | 'life' | 'nursing' | 'critical_illness' | 'disability' | 'car' | 'home' | 'travel' | 'mortgage' | 'pet' | 'other';
export interface InsuranceDocument {
  id: number; policyId: number; fileName: string; originalName: string; mime: string; size: number;
  kind: 'policy' | 'appendix' | 'renewal' | 'claim' | 'other'; uploadedAt: string; path: string;
}
export interface InsurancePolicy {
  id: number; name: string; type: InsuranceType; insurer: string | null; policyNumber: string | null;
  insuredMemberId: number | null; insuredDetails: string | null; premium: number | null; premiumFrequency: 'monthly' | 'yearly' | 'one_time';
  paymentAccountId: string | null; matchPattern: string | null; startDate: string | null; endDate: string | null;
  coverage: string | null; deductible: string | null; agentName: string | null; agentPhone: string | null; agentEmail: string | null;
  notes: string | null; archived: number;
  monthlyPremium: number; documents: InsuranceDocument[]; renewalSoon: boolean;
  /** what the bank / cards charged for it in the last 12 months (by matchPattern) */
  payments: { last12: number; count: number; lastDate: string | null; lastAmount: number | null };
}
export interface InsuranceOverview {
  policies: InsurancePolicy[];
  /** insurance charges of the last year that no policy explains */
  unlinked: { description: string; accountId: string; count: number; total: number; lastDate: string; lastAmount: number }[];
  totals: { count: number; monthly: number; paidLast12: number; renewalsSoon: number; documents: number };
}
/** The scrape started from the UI (one at a time). */
export interface ScrapeJob {
  /** check = the desktop app checking one login (log in only, nothing saved) */
  mode: 'scrape' | 'check';
  status: 'idle' | 'running' | 'pipeline' | 'done' | 'failed'; startedAt: string | null; finishedAt: string | null;
  companies: { company: string; status: 'pending' | 'running' | 'done' | 'failed'; newTransactions: number; error: string | null }[];
  /** the bank is waiting for an OTP code */
  otp: { company: string; requestedAt: string } | null;
  newTransactions: number; error: string | null;
  /** last successful bank scrape (UTC, "YYYY-MM-DD HH:MM:SS") */
  lastSuccessAt: string | null;
}
/** A one-off expense entered in advance, waiting for the card / bank to charge it. */
export interface PlannedItem {
  id: number; description: string; amount: number; date: string; accountId: string; accountKind: string; installments: number;
  matchPattern: string | null; categoryId: number | null; memberId: number | null; tagIds: number[]; notes: string | null;
  status: 'planned' | 'matched' | 'cancelled'; matchedTxnId: number | null; rejectedTxnIds: number[]; overdue: boolean;
}

export interface Holding {
  id: number; symbol: string; name: string; quantity: number; currency: string; broker: string | null; ownerMemberId: number | null;
  notes: string | null; exchange: string | null; instrumentType: string | null;
  buyPrice: number | null; buyDate: string | null; baselinePrice: number | null; baselineDate: string | null;
  manualPrice: number | null; manualPriceDate: string | null;
  price: number | null; priceSource: 'quote' | 'manual' | 'none'; priceAsOf: string | null; previousClose: number | null; quoteError: string | null;
  rate: number; value: number; valueIls: number;
  basis: 'buy' | 'baseline' | null; basisDate: string | null; cost: number | null; costIls: number | null;
  gain: number | null; gainPct: number | null; gainIls: number | null; gainIlsPct: number | null;
  dayChangePct: number | null; dayChangeIls: number;
}
export interface Portfolio {
  holdings: Holding[];
  totals: {
    count: number; valueIls: number; costIls: number; gainIls: number; gainPct: number | null;
    dayChangeIls: number; dayChangePct: number | null; quotesAsOf: string | null; errors: number;
  };
  byCurrency: Record<string, number>; byBroker: Record<string, number>;
  history: { date: string; value: number }[];
}
export interface SymbolMatch { symbol: string; name: string; exchange: string | null; type: string | null }
export interface LiveQuote { symbol: string; name: string | null; currency: string; price: number; previousClose: number | null; exchange: string | null }
