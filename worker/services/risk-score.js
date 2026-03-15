const BASE_SCORE = 50;

export const RISK_LEVEL_THRESHOLDS = {
  criticalMax: 24,
  highMax: 49,
  mediumMax: 74
};

const RULE_POINTS = {
  INACTIVE_STATUS: -35,
  LIQUIDATION_STATUS: -30,
  BANKRUPTCY_SIGNAL: -25,
  ADDRESS_INVALID: -20,
  TAX_DEBT_HIGH: -18,
  FSSP_SERIOUS: -16,
  DIRECTOR_PROBLEM: -14,
  MASS_ADDRESS: -10,
  VERY_YOUNG_COMPANY: -10,
  YOUNG_COMPANY: -6,
  ONE_EMPLOYEE: -8,
  NO_REVENUE: -10,
  ARBITRATION_LOAD_HIGH: -10,
  ARBITRATION_LOAD_MEDIUM: -6,
  AFFILIATED_OVERLOAD: -6,
  SCALE_MISMATCH: -8,
  NO_CONTACTS: -5,
  OLD_COMPANY: 10,
  NO_CRITICAL_FLAGS: 8,
  STAFF_OK: 6,
  REVENUE_OK: 6,
  CONTACTS_OK: 4,
  FINANCE_STABLE: 4,
  LOW_DEBT_LOAD: 6
};

const MAX_TOP_FACTORS = 3;

export function calculateCompanyRiskScore(input) {
  const metrics = extractRiskMetrics(input);
  const factors = [];
  const unknowns = [];

  addUnknown(unknowns, metrics.statusText, "Не удалось определить статус компании");
  addUnknown(unknowns, metrics.registrationDate, "Нет даты регистрации");
  addUnknown(unknowns, metrics.employeeCount, "Нет данных о числе сотрудников");
  addUnknown(unknowns, metrics.revenue, "Нет данных о выручке");
  addUnknown(unknowns, metrics.contactCount, "Нет данных по контактам");

  if (metrics.flags.isInactive) {
    pushFactor(factors, "INACTIVE_STATUS", "Компания недействующая", "critical", RULE_POINTS.INACTIVE_STATUS, metrics.statusText);
  }
  if (metrics.flags.isInLiquidation) {
    pushFactor(factors, "LIQUIDATION_STATUS", "Ликвидация / прекращение деятельности", "critical", RULE_POINTS.LIQUIDATION_STATUS, metrics.statusText);
  }
  if (metrics.flags.hasBankruptcy) {
    pushFactor(factors, "BANKRUPTCY_SIGNAL", "Признаки банкротства", "critical", RULE_POINTS.BANKRUPTCY_SIGNAL, metrics.flags.bankruptcyEvidence);
  }
  if (metrics.flags.addressInvalid) {
    pushFactor(factors, "ADDRESS_INVALID", "Недостоверный адрес или реквизиты", "high", RULE_POINTS.ADDRESS_INVALID, metrics.flags.addressEvidence);
  }
  if (metrics.taxDebt >= 500000) {
    pushFactor(factors, "TAX_DEBT_HIGH", "Серьезная налоговая задолженность", "high", RULE_POINTS.TAX_DEBT_HIGH, `Недоимка: ${metrics.taxDebt}`);
  }
  if (metrics.fsspCount >= 3) {
    pushFactor(factors, "FSSP_SERIOUS", "Есть нагрузка по ФССП", "high", RULE_POINTS.FSSP_SERIOUS, `Производств: ${metrics.fsspCount}`);
  }
  if (metrics.flags.directorProblem) {
    pushFactor(factors, "DIRECTOR_PROBLEM", "Есть рисковый статус руководителя", "high", RULE_POINTS.DIRECTOR_PROBLEM, metrics.flags.directorEvidence);
  }
  if (metrics.flags.massAddress) {
    pushFactor(factors, "MASS_ADDRESS", "Массовый юридический адрес", "medium", RULE_POINTS.MASS_ADDRESS, "company.data.ЮрАдрес.Массовый");
  }

  if (metrics.ageYears !== null && metrics.ageYears < 1) {
    pushFactor(factors, "VERY_YOUNG_COMPANY", "Компания очень молодая", "medium", RULE_POINTS.VERY_YOUNG_COMPANY, `Возраст: ${metrics.ageYears} лет`);
  } else if (metrics.ageYears !== null && metrics.ageYears < 3) {
    pushFactor(factors, "YOUNG_COMPANY", "Небольшой срок работы компании", "low", RULE_POINTS.YOUNG_COMPANY, `Возраст: ${metrics.ageYears} лет`);
  }
  if (metrics.employeeCount === 1) {
    pushFactor(factors, "ONE_EMPLOYEE", "Только 1 сотрудник", "medium", RULE_POINTS.ONE_EMPLOYEE, "DaData.employee_count=1");
  }
  if (metrics.revenue === 0 && (metrics.ageYears === null || metrics.ageYears >= 1)) {
    pushFactor(factors, "NO_REVENUE", "Нет выручки / нулевая активность", "medium", RULE_POINTS.NO_REVENUE, "finances[latest][2110]=0");
  }
  if (metrics.legalCasesCount >= 5) {
    pushFactor(factors, "ARBITRATION_LOAD_HIGH", "Высокая судебная нагрузка", "medium", RULE_POINTS.ARBITRATION_LOAD_HIGH, `Арбитражных дел: ${metrics.legalCasesCount}`);
  } else if (metrics.legalCasesCount >= 2) {
    pushFactor(factors, "ARBITRATION_LOAD_MEDIUM", "Есть судебная нагрузка", "low", RULE_POINTS.ARBITRATION_LOAD_MEDIUM, `Арбитражных дел: ${metrics.legalCasesCount}`);
  }
  if (metrics.affiliatedCount >= 8) {
    pushFactor(factors, "AFFILIATED_OVERLOAD", "Много аффилированных связей у участников", "low", RULE_POINTS.AFFILIATED_OVERLOAD, `Связанных лиц: ${metrics.affiliatedCount}`);
  }
  if (metrics.revenue >= 100000000 && metrics.employeeCount !== null && metrics.employeeCount <= 3) {
    pushFactor(factors, "SCALE_MISMATCH", "Несоответствие масштаба: высокая выручка при малом штате", "medium", RULE_POINTS.SCALE_MISMATCH, `Выручка: ${metrics.revenue}, сотрудники: ${metrics.employeeCount}`);
  }
  if (metrics.contactCount === 0) {
    pushFactor(factors, "NO_CONTACTS", "Слабая верифицируемость контактов", "low", RULE_POINTS.NO_CONTACTS, "Нет телефона, email и сайта");
  }

  if (metrics.ageYears !== null && metrics.ageYears >= 5) {
    pushFactor(factors, "OLD_COMPANY", "Компания действует давно", "low", RULE_POINTS.OLD_COMPANY, `Возраст: ${metrics.ageYears} лет`);
  }
  if (!hasCriticalNegativeFactor(factors)) {
    pushFactor(factors, "NO_CRITICAL_FLAGS", "Нет критичных красных флагов", "low", RULE_POINTS.NO_CRITICAL_FLAGS, "Нет факторов critical severity");
  }
  if (metrics.employeeCount !== null && metrics.employeeCount >= 10) {
    pushFactor(factors, "STAFF_OK", "Есть штат и операционная активность", "low", RULE_POINTS.STAFF_OK, `Сотрудники: ${metrics.employeeCount}`);
  }
  if (metrics.revenue > 0) {
    pushFactor(factors, "REVENUE_OK", "Есть выручка", "low", RULE_POINTS.REVENUE_OK, `Выручка: ${metrics.revenue}`);
  }
  if (metrics.contactCount > 0) {
    pushFactor(factors, "CONTACTS_OK", "Контакты подтверждаются", "low", RULE_POINTS.CONTACTS_OK, `Контактов: ${metrics.contactCount}`);
  }
  if (metrics.netProfit !== null && metrics.netProfit > 0) {
    pushFactor(factors, "FINANCE_STABLE", "Есть признаки стабильной финансовой деятельности", "low", RULE_POINTS.FINANCE_STABLE, `Чистая прибыль: ${metrics.netProfit}`);
  }
  if (metrics.taxDebt === 0 && metrics.fsspCount === 0) {
    pushFactor(factors, "LOW_DEBT_LOAD", "Нет выраженной долговой нагрузки", "low", RULE_POINTS.LOW_DEBT_LOAD, "Недоимка=0 и ФССП=0");
  }

  const score = clampScore(BASE_SCORE + factors.reduce((sum, factor) => sum + factor.points, 0));
  const level = scoreToLevel(score);
  const negatives = factors.filter((factor) => factor.points < 0).sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  const positives = factors.filter((factor) => factor.points > 0).sort((a, b) => b.points - a.points);

  const recommendation = recommendationByLevel(level);
  const summary = buildSummary(level, score, negatives.length, positives.length, unknowns.length);

  return {
    score,
    level,
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
    "⚠️ <b>Риски</b>",
    `Риск: <b>${levelText}</b>`,
    `Score: <b>${result.score}/100</b>`,
    "",
    "Почему:"
  ];

  if (result.topFactors.length === 0) {
    lines.push("• Существенных негативных факторов не выявлено");
  } else {
    for (const factor of result.topFactors) {
      lines.push(`• ${factor.title}`);
    }
  }

  lines.push("", "Плюсы:");
  if (result.positives.length === 0) {
    lines.push("• Не выявлены");
  } else {
    for (const title of result.positives.slice(0, MAX_TOP_FACTORS)) {
      lines.push(`• ${title}`);
    }
  }

  if (result.unknowns.length > 0) {
    lines.push("", "Неизвестно:");
    for (const title of result.unknowns.slice(0, 2)) {
      lines.push(`• ${title}`);
    }
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
  const revenue = valueOrNull(latestFinance?.[2110]);
  const netProfit = valueOrNull(latestFinance?.[2400]);

  const dadata = input?.dadataParty || null;
  const employeeCount = valueOrNull(dadata?.employee_count);

  const contacts = companyData.Контакты || {};
  const contactCount = countContacts(contacts, dadata);

  const directors = normalizeArray(companyData.Руковод);
  const affiliatedCount = normalizeArray(dadata?.founders).length + normalizeArray(dadata?.managers).length;

  const bankruptcyCount = safeLength(input?.bankruptcyData) + safeLength(input?.fedresursData) + safeLength(companyData.ЕФРСБ);

  const flags = {
    isInactive: /не\s*действ|прекращ/.test(statusText.toLowerCase()),
    isInLiquidation: Boolean(companyData.Ликвид?.Дата) || /ликвидац/.test(statusText.toLowerCase()),
    hasBankruptcy: /банкрот/.test(statusText.toLowerCase()) || bankruptcyCount > 0,
    bankruptcyEvidence: bankruptcyCount > 0 ? `Сообщений о банкротстве/ЕФРСБ: ${bankruptcyCount}` : statusText,
    addressInvalid: Boolean(dadata?.invalid),
    addressEvidence: dadata?.invalid ? "DaData.data.invalid=true" : "нет",
    massAddress: Boolean(companyData.ЮрАдрес?.Массовый),
    directorProblem: directors.some((item) => /дисквалиф|недостовер/.test(String(item?.Статус || item?.Наим || "").toLowerCase())),
    directorEvidence: directors.map((item) => String(item?.Статус || item?.Наим || "")).filter(Boolean).join(", ") || "company.data.Руковод"
  };

  return {
    statusText,
    registrationDate,
    ageYears,
    taxDebt: toNum(taxes.СумНедоим),
    legalCasesCount: safeLength(input?.legalData),
    fsspCount: safeLength(input?.fsspData),
    contractsCount: safeLength(input?.contractsData),
    revenue: revenue === null ? null : toNum(revenue),
    netProfit: netProfit === null ? null : toNum(netProfit),
    employeeCount: employeeCount === null ? null : toNum(employeeCount),
    contactCount,
    affiliatedCount,
    flags
  };
}

function pushFactor(factors, code, title, severity, points, evidence) {
  factors.push({ code, title, severity, points, evidence: String(evidence || "") });
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

function recommendationByLevel(level) {
  if (level === "low") return "Можно работать на стандартных условиях.";
  if (level === "medium") return "Запросите базовый пакет документов и ограничьте отсрочку.";
  if (level === "high") return "Работайте только с ограничением риска и проверьте бенефициаров/руководство.";
  return "Не давайте отсрочку: только полная предоплата или ручная проверка юр/фин контроля.";
}

function levelToRussian(level) {
  if (level === "low") return "Низкий";
  if (level === "medium") return "Средний";
  if (level === "high") return "Высокий";
  return "Критический";
}

function buildSummary(level, score, negativeCount, positiveCount, unknownCount) {
  return `Итог: ${levelToRussian(level)} риск (${score}/100). Факторов: -${negativeCount} / +${positiveCount}. Неизвестных полей: ${unknownCount}.`;
}

function clampScore(value) {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value);
}

function addUnknown(unknowns, value, message) {
  if (value === null || value === undefined || value === "") {
    unknowns.push(message);
  }
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

function countContacts(contacts, dadata) {
  const fromCompany = [contacts.Тел, contacts.Емэйл, contacts.ВебСайт].flat().filter(Boolean).length;
  const dadataPhones = normalizeArray(dadata?.phones).length;
  const dadataEmails = normalizeArray(dadata?.emails).length;
  const total = fromCompany + dadataPhones + dadataEmails;
  return total;
}

function valueOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  return value;
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

function toNum(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
