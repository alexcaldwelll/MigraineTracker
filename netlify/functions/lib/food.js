// The shape of a split food entry, and a check for what comes back from the model.
export const MAIN_MACROS = ["protein", "carbs", "fat"];
export const FOOD_TYPES = [
  "meat_fish", "dairy", "grains", "fruit_veg", "legumes_nuts", "sweets_snacks", "drinks", "other",
];
export const TRIGGER_TAGS = [
  "caffeine", "alcohol", "aged_cheese", "processed_meat", "chocolate", "msg", "artificial_sweetener",
];

const MAX_NAME = 100;
const MAX_GRAMS = 1000;

export const FOOD_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          main_macro: { type: "string", enum: MAIN_MACROS },
          food_type: { type: "string", enum: FOOD_TYPES },
          protein_g: { type: "number" },
          carbs_g: { type: "number" },
          fat_g: { type: "number" },
          tags: { type: "array", items: { type: "string", enum: TRIGGER_TAGS } },
        },
        required: ["name", "main_macro", "food_type", "protein_g", "carbs_g", "fat_g", "tags"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

const grams = (value) => {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.round(Math.min(Math.max(n, 0), MAX_GRAMS) * 10) / 10;
};

// Keeps only well-formed items. Unknown tags are dropped, an unknown food_type
// becomes "other", and an unknown main_macro becomes the macro with most grams.
// `edited` is never accepted from the model: only the person sets it.
export function validateItems(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) continue;
    const name = typeof raw.name === "string" ? raw.name.trim().slice(0, MAX_NAME) : "";
    if (name === "") continue;
    const amounts = { protein: grams(raw.protein_g), carbs: grams(raw.carbs_g), fat: grams(raw.fat_g) };
    const main_macro = MAIN_MACROS.includes(raw.main_macro)
      ? raw.main_macro
      : MAIN_MACROS.reduce((best, m) => (amounts[m] > amounts[best] ? m : best), "carbs");
    out.push({
      name,
      main_macro,
      food_type: FOOD_TYPES.includes(raw.food_type) ? raw.food_type : "other",
      protein_g: amounts.protein,
      carbs_g: amounts.carbs,
      fat_g: amounts.fat,
      tags: [...new Set(Array.isArray(raw.tags) ? raw.tags.filter((t) => TRIGGER_TAGS.includes(t)) : [])],
    });
  }
  return out;
}
