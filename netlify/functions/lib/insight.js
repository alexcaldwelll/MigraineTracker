// The Insights result: its schema, the safety check on what Claude returns, and
// how it is tied back to the numbers from patterns.js.
import { MIGRAINE_MEDS, isBroadType, mentionsMedicine } from "../../../public/js/patterns.js";
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
});

const MEDICATION_ADVICE = ["stop taking", "dose", "dosage", "start taking", "increase your", "reduce your med"];
const MEDICATION_WORDS = /\b(?:medications?|medicines?|meds?|pills?|preventives?|rescue|supplements?|prescriptions?|tablets?|capsules?|painkillers?|drugs?|nsaids?)\b|\b\d+(?:\.\d+)?\s*(?:mg|mcg|milligrams?)\b/;
// Words that give an order when nobody is asking. A first-person question may use
// them, because asking a doctor is the allowed path.
const MEDICATION_ORDERS = /\bstart taking\b|\btry(?:ing)? taking\b|\btak(?:e|ing) (?:more|less|extra|another|fewer)\b|\b(?:stop(?:ping)?|quit(?:ting)?|ditch(?:ing)?|paus(?:e|ing)|drop(?:ping)?)\b|\bcut(?:ting)? (?:back|down)\b|\bskip(?:ping)?\b|\bswitch(?:ing)?\b|\b(?:doubl(?:e|ing)|halv(?:e|ing)) (?:up on )?(?:your|my|the)\b|\b(?:rais(?:e|ing)|increas(?:e|ing)|lower(?:ing)?|reduc(?:e|ing)|decreas(?:e|ing)|doubl(?:e|ing)|halv(?:e|ing)|chang(?:e|ing)|adjust(?:ing)?|cut(?:ting)?)\b[^.!?]*\b(?:dose|dosage)\b/;
const ASKS = /^(?:should|shall|could|can|would|will|might|may|must|is|are|am|was|were|do|does|did|has|have|how|what|when|where|which|who|why)\b/;
const FIRST_PERSON = /\b(?:i|me|my)\b/;
// "Try" and a medicine form, for the products no list can keep up with.
const TRY_MEDICINE = /\btry(?:ing)? taking\b|\btry(?:ing)?\b[^.!?]*\b(?:gumm(?:y|ies)|pills?|drops|capsules?|softgels?|lozenges?|tinctures?|cbd|benadryl)\b/;

// Words in a saved med name that say nothing about which medicine it is.
const FORM_WORDS = new Set([
  "acid", "aid", "chewable", "daily", "day", "er", "extra", "headache", "hcl", "injection", "max", "maximum",
  "migraine", "nasal", "night", "odt", "oil", "oral", "pain", "rapid", "regular", "release", "relief", "sleep",
  "sodium", "spray", "strength", "sublingual", "tablet", "tablets", "xr",
]);

// "Nurtec ODT" must also catch plain "Nurtec", so each distinctive word counts as
// a name. Only here: food factors keep the whole-name match in patterns.js.
const distinctiveWords = (name) => String(name ?? "").toLowerCase().split(/[^a-z]+/)
  .filter((word) => word.length > 2 && !FORM_WORDS.has(word));

const MACRO = "(?:carbs?|carbohydrates?|proteins?|fats?|macronutrients?|macros?)";
const CUT = "(?:cut(?:ting)?|avoid(?:ing)?|skip(?:ping)?|remov(?:e|ing)|eliminat(?:e|ing)|drop(?:ping)?|stop(?:ping)?|quit(?:ting)?|reduc(?:e|ing)|lower(?:ing)?|limit(?:ing)?|restrict(?:ing)?|ditch(?:ing)?|giv(?:e|ing) up|banish(?:ing)?|fast(?:ing)?|replac(?:e|ing)|swap(?:ping)?|stay away|steer clear|don't|do not|never)";
const LITTLE = "(?:less|fewer|low|lower|no|without|zero)";
const GAP = "[\\s,'-]+";
const WORD = "[\\w']+";
// Words in one sentence, so "Skip cheese. Protein ..." is not a match. An adding
// form does not excuse these: "anything with fat" still follows "stop eating".
const CUTS_MACRO = [
  new RegExp(`\\b${CUT}(?:${GAP}${WORD}){0,6}?${GAP}${MACRO}\\b`),
  new RegExp(`\\b${LITTLE}(?:${GAP}${WORD})?${GAP}${MACRO}\\b`),
  new RegExp(`\\b${MACRO}${GAP}free\\b`),
];
const ADDS_MACRO = new RegExp(`\\b(?:add(?:ing)?|more|with|extra)(?:${GAP}${WORD})?${GAP}${MACRO}\\b`, "g");
const MACRO_WORD = new RegExp(`\\b${MACRO}\\b`);
const MACRO_DIETS = /\b(?:keto|ketogenic|carnivore|atkins)\b/;

// A macro word is refused unless it is being added, because there are too many
// ways to say "cut it". This leans strict: "skip protein bars" and "your protein
// at lunch" fail too, and the rule result takes their place.
const targetsMacro = (lower) => MACRO_DIETS.test(lower)
  || CUTS_MACRO.some((pattern) => pattern.test(lower))
  || MACRO_WORD.test(lower.replace(ADDS_MACRO, " "));

// Words for a whole food group. Bread, pasta and rice are single foods, so they
// count only as "all bread" or as a list. Dairy and sweets are the narrow groups
// worth trying, so they are not here.
const GROUP = "(?:grains?|meats?|fish|seafood|poultry|fruits?|vegetables?|veggies|veg|legumes?|beans|nuts|starch(?:es)?)";
const STAPLE = "(?:bread|pasta|rice|wheat|cereals?|potato(?:es)?)";
const NARROWED_BEFORE = "(?<!\\b(?:processed|cured|deli|lunch|red|smoked|canned|dried|pickled)[\\s-])";
const NARROWED_AFTER = `(?!${GAP}(?:juices?|snacks?|sauces?|cakes?|pies?|bars?|stocks?|rolls?|butters?|smoothies?|sticks?))`;
const WHOLE_GROUP = `${NARROWED_BEFORE}${GROUP}\\b${NARROWED_AFTER}`;
// A few words in one sentence, stopping where the sentence turns to adding
// something: "swap soda for fruit" and "skip cheese and add fruit" are fine.
const NEAR = `(?:${GAP}(?!(?:add|adding|more|extra|with|for|instead)\\b)${WORD}){0,4}?`;
const CUTS_GROUP = [
  new RegExp(`\\b${CUT}${NEAR}${GAP}${WHOLE_GROUP}`),
  new RegExp(`\\b${LITTLE}(?:${GAP}${WORD})?${GAP}${WHOLE_GROUP}`),
  new RegExp(`\\b${GROUP}${GAP}free\\b`),
  new RegExp(`\\b${CUT}${NEAR}${GAP}(?:all|any|every|everything|anything)${NEAR}${GAP}${STAPLE}\\b`),
  new RegExp(`\\b${CUT}${NEAR}${GAP}${STAPLE}(?:${GAP}(?:and|or))?${GAP}${STAPLE}\\b`),
  /\b(?:vegan|vegetarian|pescatarian|paleo|whole30|elimination diet)\b/,
];

const targetsGroup = (lower) => CUTS_GROUP.some((pattern) => pattern.test(lower));

const normalize = (value) => value.toLowerCase().replace(/\s+/g, " ");

const isUnsafe = (value, medicines) => {
  const lower = normalize(value);
  return MEDICATION_ADVICE.some((phrase) => lower.includes(phrase))
    || MEDICATION_WORDS.test(lower)
    || TRY_MEDICINE.test(lower)
    || targetsMacro(lower)
    || targetsGroup(lower)
    || mentionsMedicine(value, medicines);
};

const isText = (value) => typeof value === "string" && value.trim() !== "";
const isNote = (value) => value === null || typeof value === "string";

// "Quit Excedrin?" is an order with a question mark, so anything asked has to open
// like a question, and order words need the person asking about themselves.
const isFineSentence = (sentence) => {
  const asked = sentence.endsWith("?");
  if (asked && !ASKS.test(sentence)) return false;
  return !MEDICATION_ORDERS.test(sentence) || (asked && FIRST_PERSON.test(sentence));
};
const isQuestion = (value) => {
  const trimmed = normalize(value).trim();
  return trimmed.endsWith("?") && trimmed.split(/(?<=[.!?])\s+/).every(isFineSentence);
};

function validTryNext(next) {
  if (typeof next !== "object" || next === null) return false;
  return [next.title, next.action, next.why].every(isText)
    && CONFIDENCE.includes(next.confidence)
    && Number.isInteger(next.days) && next.days >= MIN_DAYS && next.days <= MAX_DAYS;
}

// Returns the result with only its known fields, or null if it is malformed or
// breaks a safety rule. Doctor questions may name medicines and bigger food
// changes, which is the allowed path, but one that is not a question or gives an
// order is dropped on its own. "Should I stop taking X?" stays. medication_note is never Claude's: any sent is
// ignored and it stays null, for the caller to fill from the engine's counts.
export function validateInsight(result, { medNames = [] } = {}) {
  if (typeof result !== "object" || result === null || !validTryNext(result.try_next)) return null;
  const { try_next: next, also_watching: watching, keep_logging, doctor_questions, cycle_note = null } = result;
  if (!Array.isArray(watching) || !watching.every((w) => isText(w?.item) && isText(w?.evidence))) return null;
  if (!isText(keep_logging)) return null;
  if (!Array.isArray(doctor_questions) || !doctor_questions.every(isText)) return null;
  if (!isNote(cycle_note)) return null;

  const medicines = [...MIGRAINE_MEDS, ...medNames, ...medNames.flatMap(distinctiveWords)];
  const scanned = [next.title, next.action, next.why, ...watching.flatMap((w) => [w.item, w.evidence]), keep_logging];
  if (cycle_note !== null) scanned.push(cycle_note);
  if (scanned.some((value) => isUnsafe(value, medicines))) return null;

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
    doctor_questions: doctor_questions.filter(isQuestion),
    cycle_note,
    medication_note: null,
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
// the counts show. A broad food group is too much to cut alone: null. That check
// reads the key itself, because Claude can name a factor it was never sent.
export function fitToStats(result, factors) {
  if (!result) return null;
  const key = result.try_next.factor_key;
  if (key !== null && isBroadType({ key: key.trim().toLowerCase() })) return null;
  const factor = factors.find((f) => f.key === key);
  return {
    ...result,
    try_next: { ...result.try_next, confidence: factor ? factor.confidence : "early guess" },
  };
}
