import statusesData from '../../data/reference/statuses.json' with { type: 'json' };
import bankruptcyMessageTypesData from '../../data/reference/bankruptcy_message_types.json' with { type: 'json' };
import accountCodesData from '../../data/reference/account_codes.json' with { type: 'json' };

function normalizeCode(code) {
  if (code === null || code === undefined) {
    return null;
  }

  const normalized = String(code).trim();
  return normalized === '' ? null : normalized;
}

function normalizeEntry(inputCode, value) {
  const normalizedCode = normalizeCode(inputCode);
  if (!normalizedCode || value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return {
      code: normalizedCode,
      value: String(value),
    };
  }

  if (typeof value !== 'object') {
    return null;
  }

  return {
    code: normalizeCode(value.code) ?? normalizedCode,
    ...value,
  };
}

function createLookup(data) {
  const map = new Map();

  if (Array.isArray(data)) {
    for (const item of data) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const itemCode = normalizeCode(item.code ?? item.Code ?? item.Код);
      const normalizedItem = normalizeEntry(itemCode, item);
      if (itemCode && normalizedItem) {
        map.set(itemCode, normalizedItem);
      }
    }
  } else if (data && typeof data === 'object') {
    for (const [key, value] of Object.entries(data)) {
      const normalizedItem = normalizeEntry(key, value);
      if (normalizedItem) {
        map.set(normalizedItem.code, normalizedItem);
      }
    }
  }

  return (code) => {
    const normalizedCode = normalizeCode(code);
    if (!normalizedCode) {
      return null;
    }

    return map.get(normalizedCode) ?? null;
  };
}

const findStatus = createLookup(statusesData);
const findBankruptcyMessageType = createLookup(bankruptcyMessageTypesData);
const findAccountCode = createLookup(accountCodesData);

export function lookupStatus(code) {
  return findStatus(code);
}

export function lookupBankruptcyMessageType(code) {
  return findBankruptcyMessageType(code);
}

export function lookupAccountCode(code) {
  return findAccountCode(code);
}
