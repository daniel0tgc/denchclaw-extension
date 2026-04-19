/**
 * Phone-number normalization for dedup matching.
 *
 * The CRM stores phone numbers as free-form strings on the `people.Phone Number`
 * field. Two records that look identical to a human (`+1 (555) 234-5678` vs
 * `15552345678` vs `(555) 234-5678`) need to collapse to the same key so the
 * people-merge engine can recognize them as duplicates.
 *
 * Strategy: strip everything that isn't a digit, then chop a leading `1` if
 * the result is 11 digits long (common North-American "country code or no?"
 * ambiguity). Anything shorter than 7 digits is rejected — too short to be a
 * real phone number, almost certainly junk in a phone field.
 *
 * For display/href formatting (e.g. `tel:` links) see `normalizePhone` in
 * `workspace-cell-format.ts`. That helper preserves the leading `+` and is
 * intentionally less aggressive — display values shouldn't pretend to know
 * the country code.
 */

const MIN_DEDUP_DIGITS = 7;

/**
 * Normalize a phone-number string to a stable dedup key. Returns `null` for
 * input that doesn't have enough digits to be a real number.
 *
 * Examples:
 *   "+1 (555) 234-5678"  -> "5552345678"
 *   "15552345678"        -> "5552345678"
 *   "(555) 234-5678"     -> "5552345678"
 *   "+44 20 7946 0958"   -> "442079460958"
 *   "555-1234"           -> "5551234"
 *   "x1234"              -> null   (only 4 digits)
 *   ""                   -> null
 *   null / undefined     -> null
 */
export function normalizePhoneKey(input: string | null | undefined): string | null {
  if (typeof input !== "string") {return null;}
  const trimmed = input.trim();
  if (!trimmed) {return null;}

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < MIN_DEDUP_DIGITS) {return null;}

  // North-American "1" prefix: 11 digits starting with 1 collapses to 10.
  // We deliberately don't try to be clever about other country codes; the
  // 1-prefix case is the one users hit constantly because Gmail / Apollo /
  // manual entry all flip-flop on whether to include it.
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1);
  }

  return digits;
}
