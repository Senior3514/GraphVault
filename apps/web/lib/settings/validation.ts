/**
 * Lightweight, framework-free validation helpers for the Settings provider
 * forms (sync server, WebDAV, S3, Azure, GCS, AI gateway, web-clip).
 *
 * The forms historically carried `noValidate` and validated nothing, so a
 * malformed endpoint or an empty required field could be "saved" silently
 * (the request would then fail server-side, or worse, persist garbage). These
 * helpers do the minimum that prevents a broken save:
 *   - URL fields must parse as well-formed http(s) URLs.
 *   - Required fields must be non-empty (after trimming).
 *   - Optional "prefix" fields, when provided, must end with `/`.
 *
 * Everything here is pure and unit-tested; the UI layer maps the returned
 * errors to inline messages and blocks submit when any error is present.
 */

/** Returns true when `value` is a well-formed absolute http(s) URL. */
export function isHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/** A field name → error message map. Empty object means "valid". */
export type FieldErrors = Record<string, string>;

/** A single field's validation rule. */
export interface FieldRule {
  /** The field's current value. */
  value: string;
  /** True if the field must be non-empty. */
  required?: boolean;
  /** True if the (non-empty) value must be a valid http(s) URL. */
  url?: boolean;
  /** True if the (non-empty) value must end with `/` (key prefixes). */
  endsWithSlash?: boolean;
  /** Human label used in the generated message (e.g. "WebDAV URL"). */
  label: string;
}

/**
 * Validate a set of named field rules and return a map of field → message for
 * every field that failed. The first failing condition per field wins. Fields
 * that pass are omitted from the result.
 */
export function validateFields(rules: Record<string, FieldRule>): FieldErrors {
  const errors: FieldErrors = {};
  for (const [name, rule] of Object.entries(rules)) {
    const trimmed = rule.value.trim();
    if (rule.required && trimmed === '') {
      errors[name] = `${rule.label} is required.`;
      continue;
    }
    // For optional fields, an empty value is acceptable — skip remaining checks.
    if (trimmed === '') continue;
    if (rule.url && !isHttpUrl(trimmed)) {
      errors[name] = `${rule.label} must be a valid http(s) URL.`;
      continue;
    }
    if (rule.endsWithSlash && !trimmed.endsWith('/')) {
      errors[name] = `${rule.label} must end with "/".`;
      continue;
    }
  }
  return errors;
}

/** True when a {@link FieldErrors} map has no entries. */
export function isValid(errors: FieldErrors): boolean {
  return Object.keys(errors).length === 0;
}
