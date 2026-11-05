// The Insights result: its schema, the safety check on what Claude returns, and
// how it is tied back to the numbers from patterns.js.
import { isBroadType, mentionsMedicine } from "../../../public/js/patterns.js";
import { nullable, objectOf } from "./prompts.js";

const CONFIDENCE = ["early guess", "moderate", "strong"];
const MIN_DAYS = 7;
const MAX_DAYS = 28;

// Enough for every factor with a real signal, without sending hundreds of foods.
export const MAX_PROMPT_FACTORS = 40;

const text = { type: "string" };

// Structured output does not enforce number ranges, so validateInsight checks days.
export const INSIGHT_SCHEMA = objectOf({
  try_next: objectOf({
    title: text,
    action: text,
    why: text,
    confidence: { type: "string", enum: CONFIDENCE },
    days: { type: "integer" },
    factor_key: nullable("string", "The key of the factor this tests, or null"),
  }),
  also_watching: { type: "array", items: objectOf({ item: text, evidence: text }) },
  keep_logging: text,
  doctor_questions: { type: "array", items: text },
  cycle_note: nullable("string"),
  medication_note: nullable("string"),
});

const MEDICATION_ADVICE = ["stop taking", "dose", "dosage", "start taking", "increase your", "reduce your med"];
const MEDICATION_WORDS = /\b(?:medications?|medicines?|meds?|pills?)\b/;

const MACRO = "(?:carbs?|carbohydrates?|proteins?|fats?|macronutrients?|macros?)";
const CUT = "(?:cut(?:ting)?|avoid(?:ing)?|skip(?:ping)?|remov(?:e|ing)|eliminat(?:e|ing)|drop(?:ping)?|stop(?:ping)?|quit(?:ting)?|reduc(?:e|ing)|lower(?:ing)?|limit(?:ing)?|restrict(?:ing)?|ditch(?:ing)?|giv(?:e|ing) up)";
const LITTLE = "(?:less|fewer|low|lower|no|without|zero)";
const GAP = "[\\s,'-]+";
const WORD = "[\\w']+";
// Words in one sentence, so "Skip cheese. Protein ..." is not a match. These lean
// strict: "skip protein bars" fails too, and the rule result takes its place.
const CUTS_MACRO = [
  new RegExp(`\\b${CUT}(?:${GAP}${WORD}){0,3}?${GAP}${MACRO}\\b`),
  new RegExp(`\\b${LITTLE}(?:${GAP}${WORD})?${GAP}${MACRO}\\b`),
  new RegExp(`\\b${MACRO}${GAP}free\\b`),
];

const isUnsafe = (value, medNames) => {
  const lower = value.toLowerCase().replace(/\s+/g, " ");
  return MEDICATION_ADVICE.some((phrase) => lower.includes(phrase))
    || MEDICATION_WORDS.test(lower)
    || CUTS_MACRO.some((pattern) => pattern.test(lower))
    || mentionsMedicine(value, medNames);
};

const isText = (value) => typeof value === "string" && value.trim() !== "";
const isNote = (value) => value === null || typeof value === "string";

function validTryNext(next) {
  if (typeof next !== "object" || next === null) return false;
  return [next.title, next.action, next.why].every(isText)
    && CONFIDENCE.includes(next.confidence)
    && Number.isInteger(next.days) && next.days >= MIN_DAYS && next.days <= MAX_DAYS;
}

// Returns the result with only its known fields, or null if it is malformed or
// breaks a safety rule. doctor_questions and medication_note are not scanned:
// raising medicines and bigger food changes with a doctor is the allowed path.
export function validateInsight(result, { medNames = [] } = {}) {
  if (typeof result !== "object" || result === null || !validTryNext(result.try_next)) return null;
  const { try_next: next, also_watching: watching, keep_logging, doctor_questions, cycle_note = null, medication_note = null } = result;
  if (!Array.isArray(watching) || !watching.every((w) => isText(w?.item) && isText(w?.evidence))) return null;
  if (!isText(keep_logging)) return null;
  if (!Array.isArray(doctor_questions) || !doctor_questions.every(isText)) return null;
  if (!isNote(cycle_note) || !isNote(medication_note)) return null;

  const scanned = [next.title, next.action, next.why, ...watching.flatMap((w) => [w.item, w.evidence])];
  if (scanned.some((value) => isUnsafe(value, medNames))) return null;

  return {
    try_next: {
      title: next.title,
      action: next.action,
      why: next.why,
      confidence: next.confidence,
      days: next.days,
      factor_key: typeof next.factor_key === "string" ? next.factor_key : null,
    },
    also_watching: watching.map(({ item, evidence }) => ({ item, evidence })),
    keep_logging,
    doctor_questions,
    cycle_note,
    medication_note,
  };
}

// Cross-multiplied, so no control windows means no lean.
const leansTowardHeadaches = (f) => f.beforeHeadache * f.controlTotal > f.controlHits * f.headacheTotal;

// The factors Claude sees, best evidence first. A factor can carry a strong
// label from its separate hits while its plain counts lean the other way, and
// more sleep cannot answer 7+ hours, so neither goes.
export function promptFactors(stats) {
  return stats.factors
    .filter((f) => f.key !== "sleep:7_plus" && leansTowardHeadaches(f))
    .slice(0, MAX_PROMPT_FACTORS)
    .map((f) => (isBroadType(f) ? { ...f, doctor_only: true } : f));
}

// Ties a result to the factors Claude was given. Its confidence is the engine's,
// or an early guess if it tests none of them, so it can never claim more than
// the counts show. A broad food group is too much to cut alone: null.
export function fitToStats(result, factors) {
  if (!result) return null;
  const factor = factors.find((f) => f.key === result.try_next.factor_key);
  if (factor && isBroadType(factor)) return null;
  return {
    ...result,
    try_next: { ...result.try_next, confidence: factor ? factor.confidence : "early guess" },
  };
}
