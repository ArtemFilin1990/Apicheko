const DEFAULT_DADATA_API_URL = "https://suggestions.dadata.ru/suggestions/api/4_1/rs";
const DEFAULT_WEBHOOK_PATH = "/webhook";
const COMPANY_NOT_FOUND_MESSAGE = "❌ Компания не найдена";
const SECTION_DIVIDER = "\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015";
const BLOCK_DIVIDER = "\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7";
const PAGE_SIZE = 5;
const MAX_AFFILIATION_SOURCE_INNS = 5;
const CACHE_TTL_DADATA_PARTY_SECONDS = 12 * 60 * 60;
const CACHE_TTL_AFFILIATED_SECONDS = 24 * 60 * 60;
const CACHE_TTL_EMAIL_SECONDS = 6 * 60 * 60;
const EXTERNAL_FETCH_TIMEOUT_MS = 10000;

const COMPANY_SECTION_TITLES = {
  main: "🏢 Карточка",
  lnk: "🔗 Связи",
  own: "👥 Учредители",
  fin: "📊 Финансы",
  okv: "🏷 ОКВЭД",
  his: "📜 История",
  scr: "🎯 Скоринг"
};

class DadataServiceError extends Error {
  constructor(message) {
    super(message);
    this.name = "DadataServiceError";
  }
}

class DadataNotFoundError extends Error {
  constructor(message = COMPANY_NOT_FOUND_MESSAGE) {
    super(message);
    this.name = "DadataNotFoundError";
  }
}

const BASE_SCORE = 50;
const MONTHS_24 = 24;

const RISK_LEVEL_THRESHOLDS = {
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
  LOSS_MAKING: -5,
  FINANCE_GAP: -4,

  // litigation
  DEFENDANT_CASES_24M_LOW: -3,
  DEFENDANT_CASES_24M_MEDIUM: -8,
  DEFENDANT_CASES_24M_HIGH: -14,
  DEFENDANT_CASES_24M_PATTERN: -7,
  LEGAL_LOAD_GENERAL: -4,

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

function calculateCompanyRiskScore(input) {
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

function formatRiskResultForTelegram(result) {
  const levelText = levelToRussian(result.level);
  const lines = [
    "⚠️ <b>Риски v2 (Checko + DaData Maximum)</b>",
    `Риск: <b>${levelText}</b>`,
    `Score: <b>${result.score}/100</b>`,
    `Решение: <b>${escapeHtml(String(result.decision || "manual_review"))}</b>`
  ];


  if (result.negatives.length > 0) {
    lines.push("", "Почему:");
    for (const title of result.negatives.slice(0, 5)) lines.push(`• ${title}`);
  }

  if (result.positives.length > 0) {
    lines.push("", "Плюсы:");
    for (const title of result.positives.slice(0, 3)) lines.push(`• ${title}`);
  }

  if (result.unknowns.length > 0) {
    lines.push("", "Неизвестно:");
    for (const title of result.unknowns.slice(0, 3)) lines.push(`• ${title}`);
  }

  lines.push("", "Что делать:", `• ${result.recommendation}`);
  lines.push("", result.summary);

  return lines.join("\n");
}

function extractRiskMetrics(input) {
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
  const fsspCount = safeLength(input?.fsspData);

  const legalCases = extractCaseRows(input?.legalData);
  const litigation24m = analyzeDefendantCases24m(legalCases);
  const caseStats = buildCaseStats(legalCases);

  const hasRevenueSignal = (revenue !== null && revenue > 0) || (dadataIncome !== null && dadataIncome > 0);
  const hasOperationalFootprint = Boolean((employeeCount !== null && employeeCount >= 2) || contactCount > 0 || hasRevenueSignal);
  const hasVerifiedContacts = phonesCount > 0 || emailsCount > 0 || websitesCount > 0;

  const scaleMismatch = Boolean(
    ((revenue !== null && revenue >= 100000000) || (dadataIncome !== null && dadataIncome >= 100000000)) && employeeCount !== null && employeeCount <= 1
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
    litigation24m,
    caseStats,

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

  if (metrics.netProfit !== null && metrics.netProfit < 0) {
    pushFactor(factors, "financial", "LOSS_MAKING", "Убыток по последней отчетности", "medium", RULE_POINTS.LOSS_MAKING, `Чистая прибыль: ${metrics.netProfit}`);
  }

  const confirmedNoActivity = metrics.revenue === 0 && metrics.dadataIncome === 0;
  const isYoungWithoutReports = metrics.ageYears !== null && metrics.ageYears < 3;

  if (confirmedNoActivity && metrics.ageYears !== null && metrics.ageYears >= 3) {
    pushFactor(factors, "financial", "FINANCE_GAP", "Подтверждена нулевая финансовая активность", "medium", RULE_POINTS.FINANCE_GAP, "Последняя выручка и доход = 0");
  } else if (metrics.financeMissing && !isYoungWithoutReports) {
    pushFactor(factors, "financial", "FINANCE_GAP", "Недостаточно финансовых данных", "low", RULE_POINTS.FINANCE_GAP, "Нет revenue/income");
  }
}

function applyLitigationRules(factors, metrics) {
  const litigation = metrics.litigation24m || {};
  const caseStats = metrics.caseStats || {};

  if (litigation.highConfidenceCount >= 6 || (litigation.highConfidenceCount >= 3 && litigation.totalAmount >= 1000000)) {
    pushFactor(
      factors,
      "litigation",
      "DEFENDANT_CASES_24M_HIGH",
      "Высокое давление по судам: компания регулярно выступает ответчиком",
      "high",
      RULE_POINTS.DEFENDANT_CASES_24M_HIGH,
      `Дел: ${litigation.highConfidenceCount}, сумма: ${litigation.totalAmount || 0}`
    );
  } else if (litigation.highConfidenceCount >= 3 || (litigation.highConfidenceCount >= 2 && litigation.totalAmount >= 300000)) {
    pushFactor(
      factors,
      "litigation",
      "DEFENDANT_CASES_24M_MEDIUM",
      "Есть серия недавних дел, где компания подтверждённо выступает ответчиком",
      "medium",
      RULE_POINTS.DEFENDANT_CASES_24M_MEDIUM,
      `Дел: ${litigation.highConfidenceCount}, сумма: ${litigation.totalAmount || 0}`
    );
  } else if (
    litigation.highConfidenceCount >= 1 &&
    (!litigation.zeroOrMissingOnly || litigation.materialDefendantCount > 0 || litigation.totalAmount > 0)
  ) {
    pushFactor(
      factors,
      "litigation",
      "DEFENDANT_CASES_24M_LOW",
      "Есть недавние дела, где компания выступает ответчиком",
      "low",
      RULE_POINTS.DEFENDANT_CASES_24M_LOW,
      `Дел: ${litigation.highConfidenceCount}, сумма: ${litigation.totalAmount || 0}`
    );
  }

  if (litigation.repeatedPattern) {
    pushFactor(
      factors,
      "litigation",
      "DEFENDANT_CASES_24M_PATTERN",
      "Повторяющийся судебный паттерн по делам ответчика",
      "medium",
      RULE_POINTS.DEFENDANT_CASES_24M_PATTERN,
      `Повторяемость: ${litigation.highConfidenceCount} дел`
    );
  }

  const hasDefendantPenalty = factors.some((factor) => factor.group === "litigation" && factor.points < 0);
  if (!hasDefendantPenalty && caseStats.nonDefendantCasesCount >= 5) {
    pushFactor(
      factors,
      "litigation",
      "LEGAL_LOAD_GENERAL",
      "Есть общий судебный фон, но без подтверждённого давления по роли ответчика",
      "low",
      RULE_POINTS.LEGAL_LOAD_GENERAL,
      `Прочих дел: ${caseStats.nonDefendantCasesCount}`
    );
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
  const defendantCases = metrics.litigation24m.highConfidenceCount;
  const debtPressure = (metrics.taxDebt !== null && metrics.taxDebt >= 100000) || metrics.fsspCount >= 1;

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

  if (defendantCases >= 3 && debtPressure) {
    pushFactor(factors, "compound", "CMP_DEFENDANT_DEBT_PRESSURE", "Комбинация: серия судов ответчика + долговая нагрузка", "high", RULE_POINTS.CMP_DEFENDANT_DEBT_PRESSURE, "defendant cases + debt pressure");
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
  const hasBankruptcyBlock = metrics.hasBankruptcy || metrics.isInactive || metrics.isInLiquidation;
  const defendantCases = metrics.litigation24m?.highConfidenceCount || 0;
  const repeatedPattern = Boolean(metrics.litigation24m?.repeatedPattern);
  const debtPressure = metrics.hasDebtPressure || (metrics.taxPenalties !== null && metrics.taxPenalties >= 50000);
  const hasCompoundDefendantDebt = factors.some((factor) => factor.code === "CMP_DEFENDANT_DEBT_PRESSURE");

  if (level === "critical" || hasCritical || hasBankruptcyBlock) return "reject_or_legal_review";
  if (hasCompoundDefendantDebt || (defendantCases >= 6 && debtPressure)) return "prepay_only";
  if (level === "high") return repeatedPattern || debtPressure ? "prepay_only" : "manual_review";
  if ((defendantCases >= 3 && repeatedPattern) || (defendantCases >= 2 && debtPressure)) return "manual_review";
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
  return extractCaseRows(source).length;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNumOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(/\s|₽|руб\.?/gi, "").replace(/,/g, "."));
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


function extractCaseRows(source) {
  if (Array.isArray(source)) return source;
  if (Array.isArray(source?.data)) return source.data;
  if (Array.isArray(source?.data?.Записи)) return source.data.Записи;
  if (Array.isArray(source?.data?.cases)) return source.data.cases;
  if (Array.isArray(source?.data?.items)) return source.data.items;
  return [];
}

function analyzeDefendantCases24m(legalCases) {
  const recentCases = legalCases.filter((item) => isWithinMonths(item, MONTHS_24));

  let highConfidenceCount = 0;
  let mediumConfidenceCount = 0;
  let lowConfidenceCount = 0;
  let totalAmount = 0;
  let materialDefendantCount = 0;
  let zeroOrMissingOnly = true;
  const claimants = new Map();
  const subjects = new Map();

  for (const item of recentCases) {
    const confidence = getDefendantConfidence(item);
    const amount = extractCaseAmount(item);
    const claimant = String(item?.Истец || item?.claimant || item?.plaintiff || item?.Кредитор || "").trim().toLowerCase();
    const subject = String(item?.Категория || item?.Предмет || item?.subject || "").trim().toLowerCase();

    if (confidence === "high") {
      highConfidenceCount += 1;
      if (amount !== null) totalAmount += Math.max(amount, 0);
      if (amount !== null && amount > 0) {
        materialDefendantCount += 1;
        zeroOrMissingOnly = false;
      }
      if (claimant) claimants.set(claimant, (claimants.get(claimant) || 0) + 1);
      if (subject) subjects.set(subject, (subjects.get(subject) || 0) + 1);
    } else if (confidence === "medium") {
      mediumConfidenceCount += 1;
    } else {
      lowConfidenceCount += 1;
    }
  }

  const repeatedPattern = hasRepeat(claimants) || hasRepeat(subjects);
  const totalConsideredCount = highConfidenceCount + mediumConfidenceCount;

  return {
    highConfidenceCount,
    mediumConfidenceCount,
    lowConfidenceCount,
    materialDefendantCount,
    totalAmount,
    repeatedPattern,
    zeroOrMissingOnly,
    totalConsideredCount,
    nonDefendantCasesCount: Math.max(legalCases.length - highConfidenceCount, 0)
  };
}

function getDefendantConfidence(item) {
  const explicitRole = String(item?.Роль || item?.role || item?.ПроцРоль || item?.role_name || "").toLowerCase();
  if (/ответчик|defendant|respondent/.test(explicitRole)) return "high";

  const sideRole = String(item?.Сторона || item?.Участник || item?.party_role || "").toLowerCase();
  if (/ответчик|defendant|respondent/.test(sideRole)) return "high";

  const text = [item?.Описание, item?.description, item?.Содержание, item?.Наим, item?.subject, item?.participants].map((v) => String(v || "").toLowerCase()).join(" ");
  if (/ответчик|defendant|respondent/.test(text)) return "medium";

  return "low";
}

function extractCaseAmount(item) {
  const amount =
    toNumOrNull(item?.Сумма) ??
    toNumOrNull(item?.СуммаИска) ??
    toNumOrNull(item?.amount) ??
    toNumOrNull(item?.claim_amount) ??
    toNumOrNull(item?.sum);
  return amount;
}

function isWithinMonths(item, months) {
  const dateValue = item?.Дата || item?.date || item?.date_start || item?.ДатаПоступления;
  if (!dateValue) return true;
  const stamp = Date.parse(String(dateValue));
  if (!Number.isFinite(stamp)) return true;
  const diffMs = Date.now() - stamp;
  if (diffMs < 0) return true;
  const maxMs = months * 30.5 * 24 * 60 * 60 * 1000;
  return diffMs <= maxMs;
}

function hasRepeat(map) {
  for (const count of map.values()) {
    if (count >= 2) return true;
  }
  return false;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const webhookPaths = resolveWebhookPaths(env);

    if (request.method === "GET" && url.pathname === "/") {
      return jsonResponse({ ok: true, service: "telegram-dadata-bot", webhookPaths });
    }

    if (request.method === "POST" && webhookPaths.includes(url.pathname)) {
      try {
        verifyTelegramWebhookSecret(request, env);
        return await handleTelegramUpdate(request, env);
      } catch (error) {
        const status = String(error.message || "").includes("Unauthorized") ? 401 : 400;
        return jsonResponse({ ok: false, error: String(error.message || error) }, status);
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};

async function handleTelegramUpdate(request, env) {
  ensureTelegramSecret(env);
  const update = await request.json();

  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return jsonResponse({ ok: true });
  }

  const msg = update.message;
  if (!msg || typeof msg.text !== "string" || !msg.chat?.id) {
    return jsonResponse({ ok: true, skipped: true });
  }

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === "/start") {
    const view = buildMainMenuView();
    await sendHtmlMessage(env, chatId, view);
    return jsonResponse({ ok: true });
  }

  if (text === "/help") {
    const view = buildHelpView();
    await sendHtmlMessage(env, chatId, view);
    return jsonResponse({ ok: true });
  }

  if (text === "/history") {
    const view = await buildLookupHistoryView(env, chatId);
    await sendHtmlMessage(env, chatId, view);
    return jsonResponse({ ok: true });
  }

  try {
    const view = await buildViewForUserText(env, text);
    await sendHtmlMessage(env, chatId, view);
    await persistViewHistory(env, chatId, view);
  } catch (error) {
    if (error instanceof DadataNotFoundError) {
      await sendMessage(env, { chat_id: chatId, text: COMPANY_NOT_FOUND_MESSAGE });
    } else if (error instanceof DadataServiceError) {
      await sendMessage(env, { chat_id: chatId, text: "⚠️ DaData временно недоступен" });
    } else {
      throw error;
    }
  }

  return jsonResponse({ ok: true });
}

async function handleCallbackQuery(callbackQuery, env) {
  await telegramRequest(env, "answerCallbackQuery", { callback_query_id: callbackQuery.id });

  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  if (!chatId || !messageId) return;

  try {
    env.__cbChatId__ = chatId;
    const view = await buildViewForCallback(env, String(callbackQuery.data || ""));
    if (!view) return;
    await editMessage(env, chatId, messageId, view.text, view.reply_markup);
    await persistViewHistory(env, chatId, view);
  } catch (error) {
    if (error instanceof DadataNotFoundError) {
      await editMessage(env, chatId, messageId, COMPANY_NOT_FOUND_MESSAGE, { inline_keyboard: [[kb("🏠 В меню", "menu")]] });
      return;
    }
    if (error instanceof DadataServiceError) {
      await editMessage(env, chatId, messageId, "⚠️ DaData временно недоступен", { inline_keyboard: [[kb("🏠 В меню", "menu")]] });
      return;
    }
    throw error;
  }
}

async function buildViewForUserText(env, text) {
  const compact = text.replace(/\s+/g, "");
  if (isValidEmail(text)) {
    return buildCompanyByEmailView(env, text);
  }
  if (/^\d{10}$/.test(compact) || /^\d{13}$/.test(compact) || /^\d{10}\/\d{9}$/.test(compact)) {
    return buildCompanyMainView(env, compact);
  }
  return buildUnsupportedLookupView();
}

async function buildViewForCallback(env, data) {
  if (data === "menu") return buildMainMenuView();
  if (data === "help") return buildHelpView();
  if (data === "search:inn") return buildSearchInnView();
  if (data === "search:email") return buildSearchEmailView();
  if (data === "history") return buildLookupHistoryView(env, env.__cbChatId__ || null);

  if (data.startsWith("select:company:")) {
    return buildCompanyMainView(env, data.split(":").pop());
  }

  if (!data.startsWith("co:")) return null;
  const parsed = parseCompanySectionCallback(data);
  if (!parsed || !COMPANY_SECTION_TITLES[parsed.section] || !parsed.id) return null;
  return buildCompanySectionView(env, parsed.section, parsed.id, parsed.page);
}

async function buildCompanySectionView(env, section, id, page = 1) {
  switch (section) {
    case "main":
      return buildCompanyMainView(env, id);
    case "lnk":
      return buildConnectionsView(env, id, page);
    case "own":
      return buildFoundersView(env, id);
    case "fin":
      return buildFinancesView(env, id);
    case "okv":
      return buildOkvedView(env, id);
    case "his":
      return buildHistoryView(env, id);
    case "scr":
      return buildScoringView(env, id);
    default:
      return null;
  }
}

function buildMainMenuView() {
  return {
    text: [
      "🔍 <b>Проверка контрагентов</b>",
      SECTION_DIVIDER,
      "",
      "Отправь в чат один из форматов:",
      "• <code>7707083893</code> — ИНН (10 цифр)",
      "• <code>1027700132195</code> — ОГРН (13 цифр)",
      "• <code>7707083893/773601001</code> — ИНН/КПП",
      "• <code>info@company.ru</code> — корп. email",
      "",
      "📊 Данные ЕГРЮЛ/ЕГРИП через DaData · учредители · финансы · связи · ОКВЭД"
    ].join("\n"),
    reply_markup: buildMainMenuKeyboard()
  };
}

function buildHelpView() {
  return {
    text: [
      "ℹ️ <b>Как пользоваться</b>",
      SECTION_DIVIDER,
      "",
      "<b>Что вводить:</b>",
      "• ИНН (10 цифр) — юрлицо",
      "• ОГРН (13 цифр) — любая организация",
      "• ИНН/КПП — конкретный филиал",
      "• Корпоративный email — найти компанию по почте",
      "",
      "<b>Что возвращает карточка:</b>",
      "🏢 Название · статус · реквизиты",
      "👤 Руководитель · адрес · капитал",
      "👥 Учредители с долями (тариф Максимальный)",
      "📊 Финансы: выручка, доход, расход, долги, штрафы",
      "🔗 Связи: все аффилированные компании · с ролями",
      "🏷 ОКВЭД: основной · дополнительные с названиями",
      "",
      "<b>Команды:</b> /start · /help · /history"
    ].join("\n"),
    reply_markup: buildMainMenuKeyboard()
  };
}

function buildSearchInnView() {
  return {
    text: [
      "🔎 <b>Поиск по ИНН / ОГРН</b>",
      SECTION_DIVIDER,
      "",
      "Отправь <b>прямо в чат</b> один из форматов:",
      "",
      "• <code>7707083893</code> — ИНН (10 цифр)",
      "• <code>1027700132195</code> — ОГРН (13 цифр)",
      "• <code>7707083893/773601001</code> — ИНН/КПП"
    ].join("\n"),
    reply_markup: { inline_keyboard: [[kb("🏠 В меню", "menu")]] }
  };
}

function buildSearchEmailView() {
  return {
    text: [
      "✉️ <b>Поиск по корпоративному email</b>",
      SECTION_DIVIDER,
      "",
      "Отправь <b>прямо в чат</b>, например:",
      "<code>info@company.ru</code>"
    ].join("\n"),
    reply_markup: { inline_keyboard: [[kb("🏠 В меню", "menu")]] }
  };
}

function buildUnsupportedLookupView() {
  return {
    text: [
      "❓ <b>Формат не распознан</b>",
      SECTION_DIVIDER,
      "",
      "Поддерживаются:",
      "• ИНН компании — <b>10 цифр</b>",
      "• ОГРН — <b>13 цифр</b>",
      "• ИНН/КПП через слеш",
      "• корпоративный email",
      "",
      "Введи один из этих форматов прямо в чат."
    ].join("\n"),
    reply_markup: { inline_keyboard: [[kb("🏠 В меню", "menu")]] }
  };
}

async function buildCompanyByEmailView(env, email) {
  const company = await findCompanyByEmail(env, email);
  if (!company?.inn) throw new DadataNotFoundError();
  return buildCompanyMainView(env, company.inn);
}

async function buildCompanyMainView(env, query) {
  const party = await findPartyByInnOrOgrn(env, query);
  if (!party) throw new DadataNotFoundError();

  const shortName = firstNonEmpty([party?.name?.short_with_opf, party?.name?.full_with_opf, "Компания"]);
  const fullName = party?.name?.full_with_opf;
  const statusBadge = companyStatusBadge(party?.state?.status);
  const regDate = formatTimestamp(party?.state?.registration_date);
  const revenue = party?.finance?.revenue;
  const invalidNote = party?.invalid ? "  ⚠️ <i>Недостоверные сведения ФНС</i>" : "";

  const lines = [
    `🏢 <b>${escapeHtml(shortName)}</b>${invalidNote}`,
  ];
  if (fullName && fullName !== shortName) {
    lines.push(`<i>${escapeHtml(fullName)}</i>`);
  }
  lines.push(
    SECTION_DIVIDER,
    "",
    `${statusBadge}` + (regDate ? `  ·  зарег. <b>${escapeHtml(regDate)}</b>` : ""),
    "",
    `🪪 <b>ИНН:</b> <code>${escapeHtml(firstNonEmpty([party?.inn, "—"]))}</code>   🏛 <b>ОГРН:</b> <code>${escapeHtml(firstNonEmpty([party?.ogrn, "—"]))}</code>`,
  );
  if (party?.kpp) {
    lines.push(`🧩 <b>КПП:</b> <code>${escapeHtml(party.kpp)}</code>`);
  }
  lines.push(
    "",
    `👤 <b>Руководитель:</b> ${escapeHtml(firstNonEmpty([party?.management?.name, "—"]))}` +
      (party?.management?.post ? `  <i>${escapeHtml(party.management.post)}</i>` : ""),
    `📍 <b>Адрес:</b> ${escapeHtml(firstNonEmpty([party?.address?.value, "—"]))}`,
    "",
    BLOCK_DIVIDER,
    `💼 <b>Капитал:</b> <b>${escapeHtml(formatMoney(party?.capital?.value))}</b>   👥 <b>Сотрудники:</b> <b>${escapeHtml(firstNonEmpty([party?.employee_count != null ? String(party.employee_count) : null, "—"]))}</b>`,
  );
  if (revenue != null) {
    lines.push(`💰 <b>Выручка:</b> <b>${escapeHtml(formatMoney(revenue))}</b>` + (party?.finance?.year ? `  <i>(${party.finance.year})</i>` : ""));
  }
  const okveds = ensureArray(party?.okveds);
  const mainOkved = okveds.find(o => o?.main);
  lines.push(`🏷 <b>ОКВЭД:</b> ${escapeHtml(firstNonEmpty([party?.okved, "—"]))}` + (mainOkved?.name ? `  <i>${escapeHtml(mainOkved.name)}</i>` : ""));
  lines.push("");

  return {
    text: lines.join("\n"),
    reply_markup: buildCompanyKeyboard(buildCompanyContext(party, query))
  };
}

async function buildFoundersView(env, query) {
  const party = await findPartyByInnOrOgrn(env, query);
  if (!party) throw new DadataNotFoundError();
  const id = normalizedCompanyId(party, query);
  const founders = ensureArray(party?.founders);
  const lines = ["👥 <b>Учредители</b>", SECTION_DIVIDER, ""];

  if (!founders.length) {
    lines.push("Учредители не найдены.");
  } else {
    for (const [i, founder] of founders.slice(0, 10).entries()) {
      const fname = escapeHtml(firstNonEmpty([founder?.name, founder?.fio, "—"]));
      const finn = escapeHtml(firstNonEmpty([founder?.inn, "—"]));
      const fshare = escapeHtml(formatShare(founder?.share));
      const ftype = founder?.type === "PHYSICAL" ? "👤" : "🏢";
      lines.push(`${ftype} <b>${fname}</b>`);
      lines.push(`   ИНН: <code>${finn}</code>   Доля: <b>${fshare}</b>`);
      if (i < founders.slice(0, 10).length - 1) lines.push("");
    }
    if (founders.length > 10) lines.push(`<i>…и ещё ${founders.length - 10}</i>`);
  }

  return { text: lines.join("\n"), reply_markup: buildCompanyKeyboard(buildCompanyContext(party, query), "own") };
}

async function buildFinancesView(env, query) {
  const party = await findPartyByInnOrOgrn(env, query);
  if (!party) throw new DadataNotFoundError();
  const id = normalizedCompanyId(party, query);
  const finance = party?.finance || {};
  const tax = party?.finance?.tax_system || party?.tax_system;
  const income = party?.finance?.income || party?.income;
  const expense = party?.finance?.expense || party?.expense;
  const debt = party?.finance?.debt || party?.finance?.tax_debt;
  const penalty = party?.finance?.penalty || party?.finance?.tax_penalty;
  const year = party?.finance?.year || party?.finance?.period;

  const profitVal = (income != null && expense != null) ? (Number(income) - Number(expense)) : null;
  const profitPct = (income && expense && Number(income) > 0)
    ? Math.round((Number(income) - Number(expense)) / Number(income) * 100)
    : null;
  const profitTrend = profitPct != null ? (profitPct >= 0 ? "▲" : "▼") : "";
  const finLines = [
    "📊 <b>Финансы</b>",
    SECTION_DIVIDER,
    "",
    `<b>Период:</b> <b>${escapeHtml(firstNonEmpty([year, "—"]))}</b>`,
    "",
    `📈 <b>Доходы:</b>  <b>${escapeHtml(formatMoney(income))}</b>`,
    `📉 <b>Расходы:</b> <b>${escapeHtml(formatMoney(expense))}</b>`,
  ];
  if (profitVal != null) {
    finLines.push(`${profitPct >= 0 ? "✅" : "🔴"} <b>Прибыль:</b>  <b>${escapeHtml(formatMoney(profitVal))}</b>` + (profitPct != null ? `  <i>${profitTrend} ${Math.abs(profitPct)}%</i>` : ""));
  }
  finLines.push(
    "",
    BLOCK_DIVIDER,
    `🧾 <b>Налог. режим:</b> ${escapeHtml(firstNonEmpty([tax, "—"]))}`,
    `⚠️ <b>Задолженность:</b> <b>${escapeHtml(formatMoney(debt))}</b>`,
    `🔴 <b>Пени и штрафы:</b> <b>${escapeHtml(formatMoney(penalty))}</b>`,
  );
  return {
    text: finLines.join("\n"),
    reply_markup: buildCompanyKeyboard(buildCompanyContext(party, query), "fin")
  };
}

async function buildOkvedView(env, query) {
  const party = await findPartyByInnOrOgrn(env, query);
  if (!party) throw new DadataNotFoundError();
  const id = normalizedCompanyId(party, query);
  const okveds = ensureArray(party?.okveds);
  const mainOkved = okveds.find(o => o?.main);
  const extraOkveds = okveds.filter(o => !o?.main);
  const lines = ["🏷 <b>ОКВЭД</b>", SECTION_DIVIDER, ""];

  lines.push("<b>Основной:</b>");
  if (mainOkved) {
    lines.push(`• <b>${escapeHtml(mainOkved.code || party?.okved || "—")}</b>  <i>${escapeHtml(mainOkved.name || "")}</i>`);
  } else {
    lines.push(`• <b>${escapeHtml(firstNonEmpty([party?.okved, "—"]))}</b>`);
  }

  if (extraOkveds.length) {
    lines.push("", `<b>Дополнительные</b> (${extraOkveds.length}):`);
    for (const item of extraOkveds.slice(0, 15)) {
      const code = escapeHtml(item?.code || "—");
      const name = item?.name ? `  <i>${escapeHtml(item.name)}</i>` : "";
      lines.push(`• ${code}${name}`);
    }
    if (extraOkveds.length > 15) lines.push(`<i>…и ещё ${extraOkveds.length - 15}</i>`);
  }

  return { text: lines.join("\n"), reply_markup: buildCompanyKeyboard(buildCompanyContext(party, query), "okv") };
}

async function buildConnectionsView(env, query, page = 1) {
  const party = await findPartyByInnOrOgrn(env, query);
  if (!party) throw new DadataNotFoundError();
  const id = normalizedCompanyId(party, query);
  const sourceInns = collectAffiliationSourceInns(party).slice(0, MAX_AFFILIATION_SOURCE_INNS);

  if (!sourceInns.length) {
    return {
      text: ["🔗 <b>Связи</b>", SECTION_DIVIDER, "", "У руководителей и учредителей нет ИНН для поиска аффилированности."].join("\n"),
      reply_markup: buildCompanyKeyboard(buildCompanyContext(party, query), "lnk")
    };
  }

  const batches = await Promise.all(sourceInns.map((inn) => findAffiliatedByInn(env, inn)));
  const deduped = dedupeAffiliatedCompanies(batches.flat(), id);
  const totalPages = Math.max(1, Math.ceil(deduped.length / PAGE_SIZE));
  const currentPage = clampPage(page, totalPages);
  const slice = deduped.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const lines = [`🔗 <b>Связи</b>  <i>(${deduped.length})</i>`, SECTION_DIVIDER, ""];
  if (!slice.length) {
    lines.push("Связанные компании не найдены.");
  } else {
    for (const [i, item] of slice.entries()) {
      const roleIcon = item.relations.some(r => r.includes("учредитель")) ? "👥" :
                       item.relations.some(r => r.includes("руковод")) ? "👤" : "🔗";
      const statusIcon = item.status === "Действует" ? "🟢" :
                         item.status === "Ликвидирована" ? "🔴" :
                         item.status === "Банкротство" ? "🔴" : "🟡";
      lines.push(`• <b>${escapeHtml(item.name)}</b>  ${roleIcon}`);
      lines.push(`  <code>${escapeHtml(item.inn)}</code>  ${statusIcon} ${escapeHtml(item.status)}  · <i>${escapeHtml(item.relations.join(", "))}</i>`);
      if (i < slice.length - 1) lines.push("");
    }
  }

  return {
    text: lines.join("\n"),
    reply_markup: buildConnectionsKeyboard(buildCompanyContext(party, query), currentPage, totalPages)
  };
}

async function buildScoringView(env, query) {
  const party = await findPartyByInnOrOgrn(env, query);
  if (!party) throw new DadataNotFoundError();

  // Собираем аффилированные для network-метрик
  const sourceInns = collectAffiliationSourceInns(party).slice(0, MAX_AFFILIATION_SOURCE_INNS);
  const affiliatedBatches = sourceInns.length
    ? await Promise.all(sourceInns.map((inn) => findAffiliatedByInn(env, inn)))
    : [];
  const allAffiliated = affiliatedBatches.flat();

  // Формируем input для движка скоринга (только DaData-данные, без Checko)
  const input = {
    dadataParty: {
      ...party,
      // Добавляем количество аффилированных для network-правил
      managers: ensureArray(party?.managers),
      founders: ensureArray(party?.founders),
      // Сигналы из аффилированных
      _affiliatedCount: allAffiliated.length,
    },
    companyData: {
      // Маппинг DaData → Checko-формат для extractRiskMetrics
      ДатаРег: formatTimestamp(party?.state?.registration_date),
      Статус: { Наим: readablePartyStatus(party?.state?.status) },
      ЮрАдрес: { АдресРФ: party?.address?.value, Массовый: null },
      Руковод: ensureArray(party?.managers).map(m => ({ ФИО: m?.name || (m?.fio || {})?.source, Статус: m?.invalidity ? "недостоверный" : "" })),
      Налоги: {
        СумНедоим: party?.finance?.debt ?? null,
        СумПениШтр: party?.finance?.penalty ?? null,
      },
      Контакты: {
        Тел: ensureArray(party?.phones).map(p => p?.data?.number).filter(Boolean),
        Емэйл: ensureArray(party?.emails).map(e => e?.data ? `${e.data.local}@${e.data.domain}` : null).filter(Boolean),
      },
    },
    financesData: party?.finance?.year
      ? { [party.finance.year]: {
          2110: party?.finance?.revenue ?? null,
          2400: (party?.finance?.income != null && party?.finance?.expense != null)
            ? party.finance.income - party.finance.expense
            : null,
        }}
      : {},
    bankruptcyData: [],
    fsspData: [],
    legalData: [],
    contractsData: [],
  };

  const result = calculateCompanyRiskScore(input);

  // Визуальное оформление
  const levelIcons = { low: "🟢", medium: "🟡", high: "🔴", critical: "⛔" };
  const decisionLabels = {
    approve_standard:    "✅ Работать можно",
    approve_caution:    "⚠️ С осторожностью",
    manual_review:      "🔍 Ручная проверка",
    prepay_only:        "🔒 Только предоплата",
    reject_or_legal_review: "🚫 Отказ / юр. проверка",
  };
  const levelIcon = levelIcons[result.level] || "⚪";
  const levelRu = { low: "Низкий", medium: "Средний", high: "Высокий", critical: "Критический" }[result.level] || result.level;
  const decisionLabel = decisionLabels[result.decision] || result.decision;

  // Шкала: 10 делений
  const filled = Math.round(result.score / 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);

  const name = escapeHtml(firstNonEmpty([party?.name?.short_with_opf, party?.name?.full_with_opf, "Компания"]));

  const lines = [
    `🎯 <b>Скоринг контрагента</b>`,
    SECTION_DIVIDER,
    `<i>${name}</i>`,
    "",
    `${levelIcon} <b>${levelRu} риск</b>  ·  <b>${result.score}/100</b>`,
    `<code>${bar}</code>`,
    "",
    `Решение: <b>${decisionLabel}</b>`,
    "",
    BLOCK_DIVIDER,
  ];

  if (result.negatives.length > 0) {
    lines.push("🔴 <b>Факторы риска:</b>");
    for (const title of result.negatives.slice(0, 5)) {
      lines.push(`  • ${escapeHtml(title)}`);
    }
    lines.push("");
  }

  if (result.positives.length > 0) {
    lines.push("🟢 <b>Позитивные факторы:</b>");
    for (const title of result.positives.slice(0, 3)) {
      lines.push(`  • ${escapeHtml(title)}`);
    }
    lines.push("");
  }

  if (result.unknowns.length > 0) {
    lines.push(`<i>⚠️ Нет данных по ${result.unknowns.length} параметрам — скор может быть занижен</i>`);
    lines.push("");
  }

  lines.push(BLOCK_DIVIDER);
  lines.push(`💡 ${escapeHtml(result.recommendation)}`);

  return {
    text: lines.join("\n"),
    reply_markup: buildCompanyKeyboard(buildCompanyContext(party, query), "scr")
  };
}

async function buildHistoryView(env, query) {
  const party = await findPartyByInnOrOgrn(env, query);
  if (!party) throw new DadataNotFoundError();

  const lines = ["📜 <b>История компании</b>", SECTION_DIVIDER, ""];

  // Регистрация
  const regDate = formatTimestamp(party?.state?.registration_date);
  const ogrnDate = formatTimestamp(party?.ogrn_date);
  if (regDate) lines.push(`📅 <b>Зарегистрирована:</b> <b>${escapeHtml(regDate)}</b>`);
  if (ogrnDate && ogrnDate !== regDate) lines.push(`🏛 <b>ОГРН выдан:</b> ${escapeHtml(ogrnDate)}`);

  // Ликвидация
  const liqDate = formatTimestamp(party?.state?.liquidation_date);
  if (liqDate) lines.push(`🔴 <b>Ликвидирована:</b> <b>${escapeHtml(liqDate)}</b>`);

  // Актуальность данных
  const actualDate = formatTimestamp(party?.state?.actuality_date);
  if (actualDate) lines.push(`🔄 <b>Данные актуальны на:</b> ${escapeHtml(actualDate)}`);

  lines.push("");

  // Руководители (managers — полный список)
  const managers = ensureArray(party?.managers);
  if (managers.length) {
    lines.push(`${BLOCK_DIVIDER}`, "<b>Руководители</b>");
    for (const m of managers.slice(0, 5)) {
      const mname = escapeHtml(firstNonEmpty([m?.name, (m?.fio || {})?.source, "—"]));
      const mpost = m?.post ? `  <i>${escapeHtml(m.post)}</i>` : "";
      const mdate = m?.start_date ? `  с ${formatTimestamp(m.start_date)}` : "";
      lines.push(`• <b>${mname}</b>${mpost}${mdate}`);
    }
    lines.push("");
  }

  // Правопредшественники
  const predecessors = ensureArray(party?.predecessors);
  if (predecessors.length) {
    lines.push(`${BLOCK_DIVIDER}`, "<b>Правопредшественники</b>");
    for (const p of predecessors) {
      lines.push(`• <b>${escapeHtml(p?.name || "—")}</b>  ИНН <code>${escapeHtml(p?.inn || "—")}</code>`);
    }
    lines.push("");
  }

  // Правопреемники
  const successors = ensureArray(party?.successors);
  if (successors.length) {
    lines.push(`${BLOCK_DIVIDER}`, "<b>Правопреемники</b>");
    for (const s of successors) {
      lines.push(`• <b>${escapeHtml(s?.name || "—")}</b>  ИНН <code>${escapeHtml(s?.inn || "—")}</code>`);
    }
    lines.push("");
  }

  if (lines.length <= 4) {
    lines.push("История изменений недоступна.");
  }

  // Ссылка на ЕГРЮЛ для полной истории
  lines.push("", `<a href="https://egrul.nalog.ru/">📋 Полная история в ЕГРЮЛ ↗</a>`);

  return {
    text: lines.join("\n"),
    reply_markup: buildCompanyKeyboard(buildCompanyContext(party, query), "his")
  };
}

async function buildLookupHistoryView(env, chatId) {
  if (!env.COMPANY_CACHE) {
    return {
      text: "🕘 <b>История</b>\n\nИстория пока недоступна без хранилища.\nМожно продолжить через новый поиск.",
      reply_markup: buildMainMenuKeyboard()
    };
  }

  const raw = await env.COMPANY_CACHE.get(`history:chat:${chatId}`, "json");
  const items = ensureArray(raw);
  if (!items.length) {
    return { text: "🕘 <b>История</b>\n\nИстория запросов пока пуста.", reply_markup: buildMainMenuKeyboard() };
  }

  return {
    text: "🕘 <b>История</b>\n\nВыберите последнюю карточку:",
    reply_markup: {
      inline_keyboard: [
        ...items.slice(0, 10).map((item) => [kb(item.title || item.id, `select:company:${item.id}`)]),
        [kb("🏠 В меню", "menu")]
      ]
    }
  };
}

function buildMainMenuKeyboard() {
  return {
    inline_keyboard: [
      [kb("🔎 По ИНН / ОГРН", "search:inn"), kb("✉️ По email", "search:email")],
      [kb("📜 История", "history"), kb("ℹ️ Справка", "help")]
    ]
  };
}

function buildCompanyKeyboard(company, active = "main") {
  const id = normalizedCompanyId(company);
  const activeBtn = (sec, label, icon) =>
    kb(active === sec ? `${icon} ${label} ✦` : `${icon} ${label}`, `co:${sec}:${id}`);

  return {
    inline_keyboard: [
      [activeBtn("main", "Карточка", "🏢"), activeBtn("scr", "Скоринг", "🎯")],
      [activeBtn("fin", "Финансы", "📊"), activeBtn("own", "Учредители", "👥")],
      [activeBtn("okv", "ОКВЭД", "🏷"), activeBtn("lnk", "Связи", "🔗")],
      [activeBtn("his", "История", "📜"), kb("🏠 В меню", "menu")]
    ]
  };
}

function buildConnectionsKeyboard(company, page, totalPages) {
  const id = normalizedCompanyId(company);
  // Start from base keyboard rows (all except last "В меню" row)
  const base = buildCompanyKeyboard(company, "lnk").inline_keyboard;
  const menuRow = base[base.length - 1];
  const keyboard = base.slice(0, base.length - 1);
  if (totalPages > 1) {
    const pager = [];
    if (page > 1) pager.push(kb("⬅️", `co:lnk:${id}:p:${page - 1}`));
    pager.push(kb(`${page} / ${totalPages}`, "noop"));
    if (page < totalPages) pager.push(kb("➡️", `co:lnk:${id}:p:${page + 1}`));
    keyboard.push(pager);
  }
  keyboard.push(menuRow);
  return { inline_keyboard: keyboard };
}

async function findCompanyByEmail(env, email) {
  const normalizedEmail = normalizeEmail(email);
  const payload = await withCache(env, `email:${normalizedEmail}`, CACHE_TTL_EMAIL_SECONDS, () =>
    dadataPost(env, "findByEmail/company", { query: normalizedEmail })
  );
  return payload?.suggestions?.[0]?.data?.company || null;
}

async function findPartyByInnOrOgrn(env, query) {
  const normalizedQuery = String(query || "").trim();
  const payload = await withCache(env, `dadata:party:${normalizedQuery}`, CACHE_TTL_DADATA_PARTY_SECONDS, () =>
    dadataPost(env, "findById/party", { query: normalizedQuery })
  );
  return payload?.suggestions?.[0]?.data || null;
}

async function findAffiliatedByInn(env, inn) {
  const payload = await withCache(env, `affiliated:${inn}`, CACHE_TTL_AFFILIATED_SECONDS, () =>
    dadataPost(env, "findAffiliated/party", { query: inn })
  );
  return ensureArray(payload?.suggestions).map((item) => item?.data).filter(Boolean);
}

function collectAffiliationSourceInns(party) {
  const managerInns = ensureArray([party?.management, ...(party?.managers || [])])
    .map((item) => String(item?.inn || "").trim())
    .filter((inn) => /^\d{10,12}$/.test(inn));
  const founderInns = ensureArray(party?.founders)
    .map((item) => String(item?.inn || "").trim())
    .filter((inn) => /^\d{10,12}$/.test(inn));
  return Array.from(new Set([...managerInns, ...founderInns]));
}

function dedupeAffiliatedCompanies(items, companyId) {
  const map = new Map();
  for (const item of items) {
    const inn = String(item?.inn || "").trim();
    if (!inn || inn === String(companyId || "")) continue;
    const existing = map.get(inn);
    const normalized = {
      inn,
      name: firstNonEmpty([item?.name?.short_with_opf, item?.name?.full_with_opf, "Без названия"]),
      status: readablePartyStatus(item?.state?.status),
      relations: inferAffiliationRelations(item)
    };
    if (existing) {
      existing.relations = Array.from(new Set([...existing.relations, ...normalized.relations]));
    } else {
      map.set(inn, normalized);
    }
  }
  return Array.from(map.values()).sort((left, right) => left.name.localeCompare(right.name, "ru"));
}

function inferAffiliationRelations(item) {
  const markers = [
    item?.relation_type,
    item?.scope,
    item?.affiliated_type,
    item?.branch_type,
    item?.type
  ].filter(Boolean).map((value) => String(value).toLowerCase());
  const labels = [];
  if (markers.some((value) => value.includes("found"))) labels.push("учредитель");
  if (markers.some((value) => value.includes("manager") || value.includes("employee"))) labels.push("руководитель");
  if (!labels.length) labels.push("аффилированность");
  return labels;
}

async function dadataPost(env, method, payload) {
  if (!env.DADATA_API_KEY) throw new DadataServiceError("Missing DADATA_API_KEY");
  const baseUrl = (env.DADATA_API_URL || DEFAULT_DADATA_API_URL).replace(/\/$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXTERNAL_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Token ${env.DADATA_API_KEY}`,
        ...(env.DADATA_SECRET_KEY ? { "X-Secret": env.DADATA_SECRET_KEY } : {})
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const raw = await response.text();
    if (!response.ok) throw new DadataServiceError(`HTTP ${response.status}; snippet=${raw.slice(0, 200)}`);

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new DadataServiceError(`Non-JSON response; snippet=${raw.slice(0, 200)}`);
    }

    if (!data || typeof data !== "object") {
      throw new DadataServiceError("Unexpected DaData response shape");
    }
    return data;
  } catch (error) {
    if (error instanceof DadataServiceError) throw error;
    throw new DadataServiceError(String(error?.message || error));
  } finally {
    clearTimeout(timeout);
  }
}

function parseCompanySectionCallback(data) {
  const parts = String(data || "").split(":");
  if (parts.length < 3 || parts[0] !== "co") return null;
  const section = parts[1];
  const id = parts[2];
  let page = 1;
  if (parts[3] === "p" && parts[4]) page = Number(parts[4]) || 1;
  return { section, id, page };
}

async function persistViewHistory(env, chatId, view) {
  if (!env.COMPANY_CACHE?.put) return;
  const firstCallback = view?.reply_markup?.inline_keyboard?.flat()?.find((button) => String(button?.callback_data || "").startsWith("co:main:"));
  if (!firstCallback) return;
  const id = String(firstCallback.callback_data).split(":").pop();
  const title = stripHtml(view.text).split("\n")[0]?.slice(0, 80) || id;
  const key = `history:chat:${chatId}`;
  const current = ensureArray(await env.COMPANY_CACHE.get(key, "json"));
  const next = [{ id, title, timestamp: new Date().toISOString() }, ...current.filter((item) => item?.id !== id)].slice(0, 10);
  await env.COMPANY_CACHE.put(key, JSON.stringify(next));
}

async function withCache(env, key, ttlSeconds, loader) {
  if (!env.COMPANY_CACHE?.get || !env.COMPANY_CACHE?.put) return loader();
  const cached = await env.COMPANY_CACHE.get(key, "json");
  if (cached) return cached;
  const value = await loader();
  await env.COMPANY_CACHE.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
  return value;
}

function resolveWebhookPaths(env) {
  return [String(env.WEBHOOK_PATH || DEFAULT_WEBHOOK_PATH).trim() || DEFAULT_WEBHOOK_PATH];
}

function verifyTelegramWebhookSecret(request, env) {
  ensureTelegramSecret(env);
  const actual = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (actual !== env.WEBHOOK_SECRET) {
    throw new Error("Unauthorized: invalid Telegram webhook secret");
  }
}

function ensureTelegramSecret(env) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  if (!env.WEBHOOK_SECRET) throw new Error("Missing WEBHOOK_SECRET");
}

async function sendHtmlMessage(env, chatId, view) {
  return sendMessage(env, {
    chat_id: chatId,
    text: view.text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: view.reply_markup
  });
}

async function sendMessage(env, body) {
  return telegramRequest(env, "sendMessage", body);
}

async function editMessage(env, chatId, messageId, text, replyMarkup) {
  return telegramRequest(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: replyMarkup
  });
}

async function telegramRequest(env, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return response.json();
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function kb(text, callbackData) {
  return { text, callback_data: callbackData };
}

function firstNonEmpty(values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return String(value);
  }
  return "—";
}

function ensureArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function companyStatusBadge(status) {
  const s = String(status || "").toUpperCase();
  if (s === "ACTIVE")       return "🟢 <b>Действует</b>";
  if (s === "LIQUIDATING")  return "🟡 <b>Ликвидируется</b>";
  if (s === "LIQUIDATED")   return "🔴 <b>Ликвидирована</b>";
  if (s === "BANKRUPT")     return "🔴 <b>Банкротство</b>";
  if (s === "REORGANIZING") return "🔄 <b>Реорганизация</b>";
  return "⚪ <b>Неизвестно</b>";
}

function formatTimestamp(ts) {
  if (!ts) return null;
  try {
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return null;
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
  } catch {
    return null;
  }
}

function readablePartyStatus(status) {
  const map = {
    ACTIVE: "Действует",
    LIQUIDATING: "Ликвидируется",
    LIQUIDATED: "Ликвидирована",
    BANKRUPT: "Банкротство",
    REORGANIZING: "Реорганизация"
  };
  return map[String(status || "").toUpperCase()] || "—";
}

function formatMoney(value) {
  if (value === undefined || value === null || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return `${new Intl.NumberFormat("ru-RU").format(number)} ₽`;
}

function formatShare(share) {
  if (!share) return "—";
  if (share.value !== undefined && share.type) {
    const t = String(share.type).replace("PERCENT", "%").replace("FRACTION", "д.");
    return `${share.value} ${t}`;
  }
  if (share.value !== undefined) return String(share.value);
  return "—";
}

function buildCompanyContext(party, fallback) {
  return {
    inn: normalizedCompanyId(party, fallback),
    finance: party?.finance || null,
    authorized_capital: party?.authorized_capital ?? party?.capital?.value ?? null
  };
}

function companyHasFinance(company) {
  const revenue = company?.finance?.revenue ?? company?.finance?.income ?? null;
  return revenue !== null && revenue !== undefined && revenue !== "" || Boolean(company?.authorized_capital);
}

function normalizedCompanyId(party, fallback) {
  return String(party?.inn || fallback || "").trim();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value || "").trim());
}

function escapeHtml(value) {
  return String(value || "—")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function stripHtml(value) {
  return String(value || "").replace(/<[^>]+>/g, "").trim();
}

function clampPage(page, totalPages) {
  const numeric = Number(page) || 1;
  return Math.min(Math.max(numeric, 1), totalPages);
}
