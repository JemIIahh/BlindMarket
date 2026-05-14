import type { VerificationCriteria } from '../types.js';

export interface AutoVerifyResult {
  passed: boolean;
  reasons: string[];
}

export function autoVerify(
  resultData: Record<string, unknown>,
  criteria: VerificationCriteria,
): AutoVerifyResult {
  const reasons: string[] = [];
  let passed = true;

  // Check required fields
  if (criteria.required_fields) {
    for (const field of criteria.required_fields) {
      if (!(field in resultData) || resultData[field] === undefined || resultData[field] === null) {
        reasons.push(`Missing required field: ${field}`);
        passed = false;
      }
    }
  }

  // Check min_length on output field (if present) or the whole object stringified
  if (criteria.min_length) {
    const content = typeof resultData.output === 'string' ? resultData.output : JSON.stringify(resultData);
    if (content.length < criteria.min_length) {
      reasons.push(`Content length ${content.length} below minimum ${criteria.min_length}`);
      passed = false;
    }
  }

  // Check contains_keywords (case-insensitive)
  if (criteria.contains_keywords) {
    const content = JSON.stringify(resultData).toLowerCase();
    for (const keyword of criteria.contains_keywords) {
      if (!content.includes(keyword.toLowerCase())) {
        reasons.push(`Missing keyword: ${keyword}`);
        passed = false;
      }
    }
  }

  if (passed) {
    reasons.push('All verification criteria met');
  }

  return { passed, reasons };
}
