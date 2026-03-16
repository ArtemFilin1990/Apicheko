const BASE_SCORE = 50;

export const RISK_LEVEL_THRESHOLDS = {
  criticalMax: 24,
  highMax: 49,
  mediumMax: 74
};

const RULE_POINTS = {
  // legal
  INACTIVE_STATUS: -35,
  LIQUIDATION_STATUS: -28,
  BANKRUPTCY_SIGNAL: -24,
  ADDRESS_INVALID: -14,
  COMPANY_INVALID: -16,
  MASS_ADDRESS: -8,
  DIRECTOR_PROBLEM: -12,
  TOXIC_HISTORY: -8,

  // financial
  TAX_DEBT_HIGH: -18,
  TAX_DEBT_MEDIUM: -10,
  TAX_PENALTY_HIGH: -8,
  FSSP_SERIOUS: -14,
  FSSP_MEDIUM: -8,
  LEGAL_LOAD_HIGH: -7,
  LEGAL_LOAD_MEDIUM: -4,
  BANKRUPTCY_CONTEXT: -8,
  NO_ACTIVITY: -6,
  LOSS_MAKING: -6,
  FINANCE_GAP: -2,

  // litigation
  DEFENDANT_CASES_24M_LOW: -3,
  DEFENDANT_CASES_24M_MEDIUM: -8,
  DEFENDANT_CASES_24M_HIGH: -14,
  DEFENDANT_CASES_24M_PATTERN: -6,

  // operational
  VERY_YOUNG_COMPANY: -10,
  YOUNG_COMPANY: -6,
  NO_CONTACTS: -7,
  ONE_EMPLOYEE: -7,
  OPERATIONAL_FOOTPRINT_WEAK: -8,
  SCALE_MISMATCH: -9,

  // network
  AFFILIATED_OVERLOAD: -8,
  AFFILIATED_MANAGERS_HIGH: -6,
  AFFILIATED_FOUNDERS_HIGH: -6,

  // compound
  CMP_INACTIVE_BANKRUPTCY: -12,
  CMP_INVALID_NO_CONTACTS_YOUNG: -10,
  CMP_SCALE_MISMATCH_STRONG: -8,
  CMP_AFFILIATIONS_WEAK_OPERATIONS: -8,
  CMP_AFFILIATIONS_DEBT: -8,
  CMP_AFFILIATIONS_YOUNG: -6,
  CMP_DEFENDANT_DEBT_PRESSURE: -8,
  CMP_STABLE_OLD_CLEAN: 12,

  // positives
  OLD_COMPANY: 8,
  NO_CRITICAL_FLAGS: 6,
  STAFF_OK: 6,
  REVENUE_OK: 6,
  CONTACTS_OK: 5,
  FINANCE_STABLE: 6,
  LOW_DEBT_LOAD: 7,
  OPERATIONAL_FOOTPRINT_STRONG: 6
};

const MAX_TOP_FACTORS = 3;
const TWO_YEARS_MS = 730 * 24 * 60 * 60 * 1000;

export function calculateCompanyRiskScore(input) {
  const metrics = extractRiskMetrics(input);
  const factors = [];
  const unknowns = [];

  addUnknown(unknowns, metrics.statusText, "Не удалось определить статус компании");
  addUnknown(unknowns, metrics.registrationDate, "Нет даты регистрации");
  addUnknown(unknowns, metrics.employeeCount, "Нет данных о числе сотрудников");
  addUnknown(unknowns, metrics.revenue, "Нет данных о выручке");
  addUnknown(unknowns, metrics.netProfit, "Нет данных о чистой прибыли");
  addUnknown(unknowns, metrics.dadataIncome, "Нет DaData данных о доходах");
  addUnknown(unknowns, metrics.dadataExpense, "Нет DaData данных о расходах");
  addUnknown(unknowns, metrics.contactCount, "Нет данных по контактам");

  applyLegalRules(factors, metrics);
  applyFinancialRules(factors, metrics);
  applyLitigationRules(factors, metrics);
  applyOperationalRules(factors, metrics);
  applyNetworkRules(factors, metrics);
  applyCompoundRules(factors, metrics);
  applyPositiveRules(factors, metrics);

  const score = clampScore(BASE_SCORE + factors.reduce((sum, factor) => sum + factor.points, 0));
  const level = scoreToLevel(score);
  const decision = decisionByScoreAndSignals(score, level, factors, metrics);

  const negatives = factors.filter((factor) => factor.points < 0).sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  const positives = factors.filter((factor) => factor.points > 0).sort((a, b) => b.points - a.points);

  const recommendation = recommendationByDecision(decision);
  const summary = buildSummary(level, score, decision, negatives.length, positives.length, unknowns.length);

  return {
    score,
    level,
    decision,
    factors,
    positives: positives.map((factor) => factor.title),
    negatives: negatives.map((factor) => factor.title),
    unknowns,
    recommendation,
    summary,
    topFactors: negatives.slice(0, MAX_TOP_FACTORS)
  };
}

export function formatRiskResultForTelegram(result) {
  const levelText = levelToRussian(result.level);
  const lines = [
    "⚠️ <b>Риски v2 (Checko + DaData Maximum)</b>",
    `Риск: <b>${levelText}</b>`,
    `Score: <b>${result.score}/100</b>`,
    `Решение: <b>${escapeHtml(String(result.decision || "manual_review"))}</b>`,
    "",
    "Почему:"
  ];

  if (result.topFactors.length === 0) {
    lines.push("• Существенных негативных факторов не выявлено");
  } else {
    for (const factor of result.topFactors) lines.push(`• ${factor.title}`);
  }

  lines.push("", "Плюсы:");
  if (result.positives.length === 0) {
    lines.push("• Не выявлены");
  } else {
    for (const title of result.positives.slice(0, MAX_TOP_FACTORS)) lines.push(`• ${title}`);
  }

  if (result.unknowns.length > 0) {
    lines.push("", "Неизвестно:");
    for (const title of result.unknowns.slice(0, 3)) lines.push(`• ${title}`);
  }

  lines.push("", "Что делать:", `• ${result.recommendation}`);
  lines.push("", result.summary);

  return lines.join("\n");
}

export function extractRiskMetrics(input) {
  const companyData = input?.companyData || {};
  const taxes = companyData.Налоги || {};
  const statusText = String(companyData.Статус?.Наим || "").trim();
  const registrationDate = companyData.ДатаРег || null;
  const ageYears = calcAgeYears(registrationDate);

  const financeRows = input?.financesData || {};
  const latestFinance = pickLatestFinanceRow(financeRows);
  const revenue = toNumOrNull(latestFinance?.[2110]);
  const netProfit = toNumOrNull(latestFinance?.[2400]);

  const dadata = input?.dadataParty || null;
  const dadataIncome = toNumOrNull(dadata?.finance?.income);
  const dadataExpense = toNumOrNull(dadata?.finance?.expense);
  const employeeCount = toNumOrNull(dadata?.employee_count);

  const contacts = companyData.Контакты || {};
  const phonesCount = normalizeArray(contacts.Тел).length + normalizeArray(dadata?.phones).length;
  const emailsCount = normalizeArray(contacts.Емэйл).length + normalizeArray(dadata?.emails).length;
  const websitesCount = normalizeArray(contacts.ВебСайт).length;
  const contactCount = phonesCount + emailsCount + websitesCount;

  const affiliatedManagersCount = normalizeArray(dadata?.managers).length;
  const affiliatedFoundersCount = normalizeArray(dadata?.founders).length;
  const affiliatedCount = affiliatedManagersCount + affiliatedFoundersCount;

  const directors = normalizeArray(companyData.Руковод);
  const statusLc = statusText.toLowerCase();

  const bankruptcyCount = safeLength(input?.bankruptcyData) + safeLength(input?.fedresursData) + safeLength(companyData.ЕФРСБ);
  const historySignals = extractHistorySignals(input?.historyData);

  const taxDebt = toNumOrNull(taxes.СумНедоим);
  const taxPenalties = toNumOrNull(taxes.СумПениШтр);

  const legalCases = extractCaseItems(input?.legalData);
  const caseStats = buildCaseStats(legalCases);
  const fsspCount = safeLength(input?.fsspData);

  const hasRevenueSignal = (revenue !== null && revenue > 0) || (dadataIncome !== null && dadataIncome > 0);
  const hasOperationalFootprint = Boolean((employeeCount !== null && employeeCount >= 2) || contactCount > 0 || hasRevenueSignal);
  const hasVerifiedContacts = phonesCount > 0 || emailsCount > 0 || websitesCount > 0;

  const scaleMismatch = Boolean(
    ((revenue !== null && revenue >= 100000000) || (dadataIncome !== null && dadataIncome >= 100000000)) &&
      employeeCount !== null &&
      employeeCount <= 1
  );

  const addressInvalid = Boolean(dadata?.invalid || dadata?.address?.data?.invalid);
  const companyInvalid = Boolean(dadata?.state?.status === "LIQUIDATING" || dadata?.state?.status === "LIQUIDATED");
  const massAddress = Boolean(companyData.ЮрАдрес?.Массовый || dadata?.address?.data?.qc_complete === "5");
  const directorProblem = directors.some((item) => /дисквалиф|недостовер|массов/.test(String(item?.Статус || item?.Наим || "").toLowerCase()));

  const financeMissing = revenue === null && dadataIncome === null;
  const hasDebtPressure = (taxDebt !== null && taxDebt >= 100000) || fsspCount >= 1;

  return {
    statusText,
    registrationDate,
    ageYears,
    taxDebt,
    taxPenalties,
    fsspCount,
    legalCasesCount: caseStats.legalCasesCount,
    legalCasesNonDefendantCount: caseStats.nonDefendantCasesCount,
    defendantCases24mCount: caseStats.defendantCases24mCount,
    defendantCases24mHighConfidence: caseStats.defendantCases24mHighConfidence,
    defendantCases24mMediumConfidence: caseStats.defendantCases24mMediumConfidence,
    defendantCases24mClaimAmount: caseStats.defendantCases24mClaimAmount,
    defendantCases24mUnknownAmountCount: caseStats.defendantCases24mUnknownAmountCount,
    defendantCases24mZeroAmountCount: caseStats.defendantCases24mZeroAmountCount,
    defendantPattern24m: caseStats.defendantPattern24m,
    defendantPenaltyMaterial: caseStats.defendantPenaltyMaterial,
    contractsCount: safeLength(input?.contractsData),
    revenue,
    netProfit,
    dadataIncome,
    dadataExpense,
    employeeCount,
    contactCount,
    phonesCount,
    emailsCount,
    affiliatedCount,
    affiliatedManagersCount,
    affiliatedFoundersCount,
    addressInvalid,
    companyInvalid,
    massAddress,
    directorProblem,
    bankruptcyCount,
    historySignals,
    scaleMismatch,
    hasVerifiedContacts,
    hasOperationalFootprint,
    financeMissing,
    hasDebtPressure,
    isInactive: /не\s*действ|прекращ/.test(statusLc),
    isInLiquidation: Boolean(companyData.Ликвид?.Дата) || /ликвидац/.test(statusLc),
    hasBankruptcy: /банкрот/.test(statusLc) || bankruptcyCount > 0
  };
}

function applyLegalRules(factors, metrics) {
  if (metrics.isInactive) pushFactor(factors, "legal", "INACTIVE_STATUS", "Компания недействующая", "critical", RULE_POINTS.INACTIVE_STATUS, metrics.statusText);
  if (metrics.isInLiquidation) pushFactor(factors, "legal", "LIQUIDATION_STATUS", "Ликвидация / прекращение деятельности", "critical", RULE_POINTS.LIQUIDATION_STATUS, metrics.statusText);
  if (metrics.hasBankruptcy) pushFactor(factors, "legal", "BANKRUPTCY_SIGNAL", "Признаки банкротства / ЕФРСБ", "critical", RULE_POINTS.BANKRUPTCY_SIGNAL, `Сигналов: ${metrics.bankruptcyCount}`);
  if (metrics.addressInvalid) pushFactor(factors, "legal", "ADDRESS_INVALID", "Недостоверный адрес", "high", RULE_POINTS.ADDRESS_INVALID, "DaData.invalid/address.invalid");
  if (metrics.companyInvalid) pushFactor(factors, "legal", "COMPANY_INVALID", "Есть признаки недостоверности компании", "high", RULE_POINTS.COMPANY_INVALID, "DaData.state.status");
  if (metrics.massAddress) pushFactor(factors, "legal", "MASS_ADDRESS", "Массовый юридический адрес", "medium", RULE_POINTS.MASS_ADDRESS, "company.ЮрАдрес.Массовый");
  if (metrics.directorProblem) pushFactor(factors, "legal", "DIRECTOR_PROBLEM", "Есть рисковый статус руководителя", "high", RULE_POINTS.DIRECTOR_PROBLEM, "company.Руковод[*].Статус");
  if (metrics.historySignals > 0) pushFactor(factors, "legal", "TOXIC_HISTORY", "Токсичная история изменений", "medium", RULE_POINTS.TOXIC_HISTORY, `Сигналов: ${metrics.historySignals}`);
}

function applyFinancialRules(factors, metrics) {
  if (metrics.taxDebt !== null && metrics.taxDebt >= 500000) pushFactor(factors, "financial", "TAX_DEBT_HIGH", "Серьезная налоговая задолженность", "high", RULE_POINTS.TAX_DEBT_HIGH, `Недоимка: ${metrics.taxDebt}`);
  else if (metrics.taxDebt !== null && metrics.taxDebt >= 100000) pushFactor(factors, "financial", "TAX_DEBT_MEDIUM", "Налоговая задолженность", "medium", RULE_POINTS.TAX_DEBT_MEDIUM, `Недоимка: ${metrics.taxDebt}`);

  if (metrics.taxPenalties !== null && metrics.taxPenalties >= 50000) pushFactor(factors, "financial", "TAX_PENALTY_HIGH", "Значимые пени / штрафы", "medium", RULE_POINTS.TAX_PENALTY_HIGH, `Пени/штрафы: ${metrics.taxPenalties}`);

  if (metrics.fsspCount >= 3) pushFactor(factors, "financial", "FSSP_SERIOUS", "Высокая нагрузка по ФССП", "high", RULE_POINTS.FSSP_SERIOUS, `Производств: ${metrics.fsspCount}`);
  else if (metrics.fsspCount >= 1) pushFactor(factors, "financial", "FSSP_MEDIUM", "Есть исполнительные производства", "medium", RULE_POINTS.FSSP_MEDIUM, `Производств: ${metrics.fsspCount}`);

  // Защита от double counting: generic legal load считаем по non-defendant пулу.
  if (metrics.legalCasesNonDefendantCount >= 8) pushFactor(factors, "financial", "LEGAL_LOAD_HIGH", "Высокая судебная нагрузка", "medium", RULE_POINTS.LEGAL_LOAD_HIGH, `Non-defendant дел: ${metrics.legalCasesNonDefendantCount}`);
  else if (metrics.legalCasesNonDefendantCount >= 3) pushFactor(factors, "financial", "LEGAL_LOAD_MEDIUM", "Есть судебная нагрузка", "low", RULE_POINTS.LEGAL_LOAD_MEDIUM, `Non-defendant дел: ${metrics.legalCasesNonDefendantCount}`);

  if (metrics.bankruptcyCount >= 2) pushFactor(factors, "financial", "BANKRUPTCY_CONTEXT", "Накопленный контекст банкротства", "high", RULE_POINTS.BANKRUPTCY_CONTEXT, `Сообщений: ${metrics.bankruptcyCount}`);

  const revenueValue = preferNumber(metrics.revenue, metrics.dadataIncome);
  const hasExplicitZeroRevenue = revenueValue === 0;
  const hasConfirmedNoActivity = hasExplicitZeroRevenue && metrics.revenue !== null && metrics.dadataIncome !== null;
  if (hasConfirmedNoActivity && (metrics.ageYears === null || metrics.ageYears >= 1)) {
    pushFactor(factors, "financial", "NO_ACTIVITY", "Нулевая экономическая активность", "medium", RULE_POINTS.NO_ACTIVITY, "Подтверждено revenue=0 и income=0");
  }

  if (metrics.netProfit !== null && metrics.netProfit < 0) {
    pushFactor(factors, "financial", "LOSS_MAKING", "Убыток по последней отчетности", "medium", RULE_POINTS.LOSS_MAKING, `Чистая прибыль: ${metrics.netProfit}`);
  }

  if (metrics.financeMissing && (metrics.ageYears === null || metrics.ageYears >= 1)) {
    pushFactor(factors, "financial", "FINANCE_GAP", "Недостаточно финансовых данных", "low", RULE_POINTS.FINANCE_GAP, "Нет revenue/income");
  }
}

function applyLitigationRules(factors, metrics) {
  const highCount = metrics.defendantCases24mHighConfidence;
  const mediumCount = metrics.defendantCases24mMediumConfidence;
  const claimAmount = metrics.defendantCases24mClaimAmount;

  if (highCount >= 6) {
    pushFactor(factors, "litigation", "DEFENDANT_CASES_24M_HIGH", "Сильное давление судебных требований к компании (ответчик, 24 мес.)", "high", RULE_POINTS.DEFENDANT_CASES_24M_HIGH, `High confidence дел: ${highCount}, сумма: ${claimAmount}`);
  } else if (highCount >= 3) {
    pushFactor(factors, "litigation", "DEFENDANT_CASES_24M_MEDIUM", "Заметная судебная нагрузка по делам ответчика (24 мес.)", "medium", RULE_POINTS.DEFENDANT_CASES_24M_MEDIUM, `High confidence дел: ${highCount}, сумма: ${claimAmount}`);
  } else if (highCount >= 1) {
    const onlyNonMaterial = highCount === 1 && claimAmount === 0 && metrics.defendantCases24mUnknownAmountCount === 0 && !metrics.defendantPattern24m;
    const points = onlyNonMaterial ? -1 : RULE_POINTS.DEFENDANT_CASES_24M_LOW;
    pushFactor(factors, "litigation", "DEFENDANT_CASES_24M_LOW", "Единичные дела, где компания ответчик (24 мес.)", "low", points, `High confidence дел: ${highCount}, сумма: ${claimAmount}`);
  } else if (mediumCount >= 3 && claimAmount >= 500000) {
    // Осторожный fallback: medium-confidence даёт только мягкий сигнал.
    pushFactor(factors, "litigation", "DEFENDANT_CASES_24M_LOW", "Есть мягкий сигнал дел ответчика (роль частично подтверждена)", "low", -2, `Medium confidence дел: ${mediumCount}, сумма: ${claimAmount}`);
  }

  if (metrics.defendantPattern24m && (highCount >= 2 || (mediumCount >= 3 && claimAmount >= 1000000))) {
    pushFactor(factors, "litigation", "DEFENDANT_CASES_24M_PATTERN", "Повторяемый паттерн дел, где компания ответчик", "medium", RULE_POINTS.DEFENDANT_CASES_24M_PATTERN, `Паттерн: повторяемость, high=${highCount}, medium=${mediumCount}`);
  }
}

function applyOperationalRules(factors, metrics) {
  if (metrics.ageYears !== null && metrics.ageYears < 1) pushFactor(factors, "operational", "VERY_YOUNG_COMPANY", "Компания очень молодая", "medium", RULE_POINTS.VERY_YOUNG_COMPANY, `Возраст: ${metrics.ageYears} лет`);
  else if (metrics.ageYears !== null && metrics.ageYears < 3) pushFactor(factors, "operational", "YOUNG_COMPANY", "Небольшой срок работы компании", "low", RULE_POINTS.YOUNG_COMPANY, `Возраст: ${metrics.ageYears} лет`);

  if (metrics.contactCount === 0) pushFactor(factors, "operational", "NO_CONTACTS", "Слабая верифицируемость контактов", "medium", RULE_POINTS.NO_CONTACTS, "Нет телефона, email и сайта");
  if (metrics.employeeCount === 1) pushFactor(factors, "operational", "ONE_EMPLOYEE", "Только 1 сотрудник", "medium", RULE_POINTS.ONE_EMPLOYEE, "DaData.employee_count=1");
  if (!metrics.hasOperationalFootprint) pushFactor(factors, "operational", "OPERATIONAL_FOOTPRINT_WEAK", "Слабый операционный след", "high", RULE_POINTS.OPERATIONAL_FOOTPRINT_WEAK, "Нет сотрудников/контактов/активности");
  if (metrics.scaleMismatch) pushFactor(factors, "operational", "SCALE_MISMATCH", "Несоответствие масштаба: высокий оборот при микроштабе", "high", RULE_POINTS.SCALE_MISMATCH, `Выручка: ${preferNumber(metrics.revenue, metrics.dadataIncome)}, сотрудники: ${metrics.employeeCount}`);
}

function applyNetworkRules(factors, metrics) {
  if (metrics.affiliatedCount >= 12) pushFactor(factors, "network", "AFFILIATED_OVERLOAD", "Перегруженная сеть аффилированных компаний", "medium", RULE_POINTS.AFFILIATED_OVERLOAD, `Связей: ${metrics.affiliatedCount}`);
  if (metrics.affiliatedManagersCount >= 8) pushFactor(factors, "network", "AFFILIATED_MANAGERS_HIGH", "Много связей через руководителей", "low", RULE_POINTS.AFFILIATED_MANAGERS_HIGH, `Manager-links: ${metrics.affiliatedManagersCount}`);
  if (metrics.affiliatedFoundersCount >= 8) pushFactor(factors, "network", "AFFILIATED_FOUNDERS_HIGH", "Много связей через учредителей", "low", RULE_POINTS.AFFILIATED_FOUNDERS_HIGH, `Founder-links: ${metrics.affiliatedFoundersCount}`);
}

function applyCompoundRules(factors, metrics) {
  if (metrics.isInactive && metrics.hasBankruptcy) {
    pushFactor(factors, "compound", "CMP_INACTIVE_BANKRUPTCY", "Комбинация: недействующая + банкротство", "critical", RULE_POINTS.CMP_INACTIVE_BANKRUPTCY, "inactive + bankruptcy");
  }

  if (metrics.addressInvalid && metrics.contactCount === 0 && metrics.ageYears !== null && metrics.ageYears <= 2) {
    pushFactor(factors, "compound", "CMP_INVALID_NO_CONTACTS_YOUNG", "Комбинация: недостоверный адрес + нет контактов + молодая компания", "high", RULE_POINTS.CMP_INVALID_NO_CONTACTS_YOUNG, "invalid address + no contacts + young");
  }

  if (metrics.scaleMismatch) {
    pushFactor(factors, "compound", "CMP_SCALE_MISMATCH_STRONG", "Комбинация: высокий оборот при минимальном штате", "high", RULE_POINTS.CMP_SCALE_MISMATCH_STRONG, "high revenue + <=1 employee");
  }

  if (metrics.affiliatedCount >= 12 && !metrics.hasOperationalFootprint) {
    pushFactor(factors, "compound", "CMP_AFFILIATIONS_WEAK_OPERATIONS", "Комбинация: много аффилированности + слабая операционная реальность", "high", RULE_POINTS.CMP_AFFILIATIONS_WEAK_OPERATIONS, "many affiliations + weak ops");
  }

  if (metrics.affiliatedCount >= 12 && ((metrics.taxDebt !== null && metrics.taxDebt > 0) || metrics.fsspCount > 0)) {
    pushFactor(factors, "compound", "CMP_AFFILIATIONS_DEBT", "Комбинация: много аффилированности + долговые сигналы", "high", RULE_POINTS.CMP_AFFILIATIONS_DEBT, "many affiliations + debt");
  }

  if (metrics.affiliatedCount >= 12 && metrics.ageYears !== null && metrics.ageYears <= 2) {
    pushFactor(factors, "compound", "CMP_AFFILIATIONS_YOUNG", "Комбинация: много аффилированности + молодая компания", "medium", RULE_POINTS.CMP_AFFILIATIONS_YOUNG, "many affiliations + young");
  }

  if (metrics.defendantCases24mHighConfidence >= 3 && metrics.hasDebtPressure) {
    pushFactor(factors, "compound", "CMP_DEFENDANT_DEBT_PRESSURE", "Комбинация: дела ответчика + долговое давление", "high", RULE_POINTS.CMP_DEFENDANT_DEBT_PRESSURE, `defendant=${metrics.defendantCases24mHighConfidence}, debtPressure=${metrics.hasDebtPressure}`);
  }

  if (metrics.ageYears !== null && metrics.ageYears >= 7 && (metrics.taxDebt === 0 || metrics.taxDebt === null) && metrics.fsspCount === 0 && metrics.netProfit !== null && metrics.netProfit > 0) {
    pushFactor(factors, "compound", "CMP_STABLE_OLD_CLEAN", "Комбинация: зрелая компания без долгов и с прибылью", "low", RULE_POINTS.CMP_STABLE_OLD_CLEAN, "old + clean debt + stable finance");
  }
}

function applyPositiveRules(factors, metrics) {
  if (metrics.ageYears !== null && metrics.ageYears >= 5) pushFactor(factors, "operational", "OLD_COMPANY", "Компания действует давно", "low", RULE_POINTS.OLD_COMPANY, `Возраст: ${metrics.ageYears} лет`);
  if (!hasCriticalNegativeFactor(factors)) pushFactor(factors, "legal", "NO_CRITICAL_FLAGS", "Нет критичных красных флагов", "low", RULE_POINTS.NO_CRITICAL_FLAGS, "Нет факторов critical severity");
  if (metrics.employeeCount !== null && metrics.employeeCount >= 10) pushFactor(factors, "operational", "STAFF_OK", "Есть штат и операционная активность", "low", RULE_POINTS.STAFF_OK, `Сотрудники: ${metrics.employeeCount}`);

  const revenueValue = preferNumber(metrics.revenue, metrics.dadataIncome);
  if (revenueValue !== null && revenueValue > 0) pushFactor(factors, "financial", "REVENUE_OK", "Есть выручка / доход", "low", RULE_POINTS.REVENUE_OK, `Выручка/доход: ${revenueValue}`);

  if (metrics.hasVerifiedContacts) pushFactor(factors, "operational", "CONTACTS_OK", "Контакты подтверждаются", "low", RULE_POINTS.CONTACTS_OK, `Контактов: ${metrics.contactCount}`);
  if (metrics.netProfit !== null && metrics.netProfit > 0) pushFactor(factors, "financial", "FINANCE_STABLE", "Есть признаки стабильной финансовой деятельности", "low", RULE_POINTS.FINANCE_STABLE, `Чистая прибыль: ${metrics.netProfit}`);
  if (metrics.taxDebt === 0 && metrics.fsspCount === 0) pushFactor(factors, "financial", "LOW_DEBT_LOAD", "Нет выраженной долговой нагрузки", "low", RULE_POINTS.LOW_DEBT_LOAD, "Недоимка=0 и ФССП=0");
  if (metrics.hasOperationalFootprint) pushFactor(factors, "operational", "OPERATIONAL_FOOTPRINT_STRONG", "Бизнес операционно верифицируется", "low", RULE_POINTS.OPERATIONAL_FOOTPRINT_STRONG, "Есть операционный след");
}

function pushFactor(factors, group, code, title, severity, points, evidence) {
  factors.push({ group, code, title, severity, points, evidence: String(evidence || "") });
}

function hasCriticalNegativeFactor(factors) {
  return factors.some((factor) => factor.severity === "critical" && factor.points < 0);
}

function scoreToLevel(score) {
  if (score <= RISK_LEVEL_THRESHOLDS.criticalMax) return "critical";
  if (score <= RISK_LEVEL_THRESHOLDS.highMax) return "high";
  if (score <= RISK_LEVEL_THRESHOLDS.mediumMax) return "medium";
  return "low";
}

function decisionByScoreAndSignals(score, level, factors, metrics) {
  const hasCritical = factors.some((factor) => factor.points < 0 && factor.severity === "critical");
  const hasHighLegal = factors.some((factor) => factor.group === "legal" && factor.points < 0 && (factor.severity === "critical" || factor.severity === "high"));
  const hasDebtPressure = metrics.hasDebtPressure;
  const severeDefendantPressure = metrics.defendantCases24mHighConfidence >= 6 || (metrics.defendantCases24mHighConfidence >= 3 && metrics.defendantCases24mClaimAmount >= 1000000);

  if (score <= 24 || hasCritical || (metrics.isInactive && metrics.hasBankruptcy)) return "reject_or_legal_review";
  if (score <= 40 || (hasHighLegal && hasDebtPressure) || (severeDefendantPressure && hasDebtPressure)) return "prepay_only";
  if (level === "high" || score <= 55 || (metrics.defendantPattern24m && hasDebtPressure)) return "manual_review";
  if (level === "medium") return "approve_caution";
  return "approve_standard";
}

function recommendationByDecision(decision) {
  if (decision === "approve_standard") return "Можно работать на стандартных условиях.";
  if (decision === "approve_caution") return "Согласуйте лимит, запросите базовые документы и сократите отсрочку.";
  if (decision === "manual_review") return "Перед сделкой проведите ручную проверку юр/фин блока и бенефициаров.";
  if (decision === "prepay_only") return "Рекомендуется полная или поэтапная предоплата до снятия рисков.";
  return "Рекомендуется отказ или обязательная правовая проверка до любых обязательств.";
}

function levelToRussian(level) {
  if (level === "low") return "Низкий";
  if (level === "medium") return "Средний";
  if (level === "high") return "Высокий";
  return "Критический";
}

function buildSummary(level, score, decision, negativeCount, positiveCount, unknownCount) {
  return `Итог: ${levelToRussian(level)} риск (${score}/100), решение: ${decision}. Факторов: -${negativeCount} / +${positiveCount}. Неизвестных полей: ${unknownCount}.`;
}

function clampScore(value) {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value);
}

function addUnknown(unknowns, value, message) {
  if (value === null || value === undefined || value === "") unknowns.push(message);
}

function calcAgeYears(dateValue) {
  if (!dateValue) return null;
  const stamp = Date.parse(String(dateValue));
  if (!Number.isFinite(stamp)) return null;
  const diff = Date.now() - stamp;
  if (diff < 0) return 0;
  return Math.floor(diff / (365.25 * 24 * 60 * 60 * 1000));
}

function pickLatestFinanceRow(financeRows) {
  if (!financeRows || typeof financeRows !== "object") return null;
  const years = Object.keys(financeRows).filter((value) => /^\d{4}$/.test(value)).sort((a, b) => Number(b) - Number(a));
  if (!years.length) return null;
  return financeRows[years[0]] || null;
}

function safeLength(source) {
  if (Array.isArray(source)) return source.length;
  if (Array.isArray(source?.data)) return source.data.length;
  if (Array.isArray(source?.data?.Записи)) return source.data.Записи.length;
  if (Array.isArray(source?.data?.cases)) return source.data.cases.length;
  if (Array.isArray(source?.data?.items)) return source.data.items.length;
  return 0;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNumOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function extractHistorySignals(historyData) {
  const rows = normalizeArray(historyData?.data || historyData);
  if (!rows.length) return 0;
  return rows.filter((item) => /смена|ликвид|реорган|адрес|руковод|учред/.test(String(item?.Наим || item?.Событие || item?.Содержание || "").toLowerCase())).length;
}

function preferNumber(primary, secondary) {
  if (primary !== null && primary !== undefined) return primary;
  if (secondary !== null && secondary !== undefined) return secondary;
  return null;
}

function extractCaseItems(legalData) {
  if (Array.isArray(legalData)) return legalData;
  if (Array.isArray(legalData?.data)) return legalData.data;
  if (Array.isArray(legalData?.data?.cases)) return legalData.data.cases;
  if (Array.isArray(legalData?.data?.items)) return legalData.data.items;
  return [];
}

function buildCaseStats(legalCases) {
  const now = Date.now();
  const stats = {
    legalCasesCount: legalCases.length,
    nonDefendantCasesCount: 0,
    defendantCases24mCount: 0,
    defendantCases24mHighConfidence: 0,
    defendantCases24mMediumConfidence: 0,
    defendantCases24mClaimAmount: 0,
    defendantCases24mUnknownAmountCount: 0,
    defendantCases24mZeroAmountCount: 0,
    defendantPattern24m: false,
    defendantPenaltyMaterial: false
  };

  const months = new Set();
  const claimants = new Set();
  let repeatedSignals = 0;

  for (const item of legalCases) {
    const confidence = getDefendantConfidence(item);
    const caseDate = parseCaseDate(item);
    const amount = parseCaseAmount(item);
    const in24m = caseDate !== null && now - caseDate <= TWO_YEARS_MS;

    if (!in24m) {
      if (confidence !== "high") stats.nonDefendantCasesCount += 1;
      continue;
    }

    if (confidence === "high") {
      stats.defendantCases24mCount += 1;
      stats.defendantCases24mHighConfidence += 1;
      if (amount === null) stats.defendantCases24mUnknownAmountCount += 1;
      else if (amount === 0) stats.defendantCases24mZeroAmountCount += 1;
      else stats.defendantCases24mClaimAmount += amount;

      const key = monthKey(caseDate);
      if (key) months.add(key);
      const claimant = String(item?.Истец || item?.Claimant || item?.plaintiff || item?.Сторона1 || "").trim();
      if (claimant) claimants.add(claimant.toLowerCase());
      if (amount !== null && amount > 0) repeatedSignals += 1;
      continue;
    }

    if (confidence === "medium") {
      stats.defendantCases24mMediumConfidence += 1;
      if (amount !== null && amount > 0) stats.defendantCases24mClaimAmount += amount;
      stats.nonDefendantCasesCount += 1;
      continue;
    }

    stats.nonDefendantCasesCount += 1;
  }

  stats.defendantPattern24m = stats.defendantCases24mHighConfidence >= 3 && (months.size >= 2 || claimants.size >= 2 || repeatedSignals >= 3);
  stats.defendantPenaltyMaterial = stats.defendantCases24mClaimAmount > 0 || stats.defendantPattern24m || stats.defendantCases24mHighConfidence >= 2;
  return stats;
}

function getDefendantConfidence(item) {
  const explicitRole = String(item?.Роль || item?.role || item?.Role || item?.side || item?.position || item?.ПроцессуальнаяРоль || "").toLowerCase();
  if (/ответчик|defendant|respondent/.test(explicitRole)) return "high";
  if (explicitRole) return "low";

  const weakText = [
    item?.Наим,
    item?.Описание,
    item?.Содержание,
    item?.text,
    item?.description,
    item?.summary,
    item?.payload,
    item?.Стороны
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
    .join(" | ");

  if (/ответчик|defendant|respondent/.test(weakText)) return "medium";
  return "low";
}

function parseCaseDate(item) {
  const raw = item?.Дата || item?.date || item?.ДатаИска || item?.date_start || item?.created_at;
  if (!raw) return null;
  const stamp = Date.parse(String(raw));
  return Number.isFinite(stamp) ? stamp : null;
}

function parseCaseAmount(item) {
  const raw = item?.СуммаИска ?? item?.СуммаТребований ?? item?.amount ?? item?.claim_amount ?? item?.sum;
  return toNumOrNull(raw);
}

function monthKey(stamp) {
  if (stamp === null) return "";
  const d = new Date(stamp);
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${d.getUTCFullYear()}-${month}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
