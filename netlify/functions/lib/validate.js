const ACTIONS = ["analyze", "read_screenshot", "split_food", "backfill_food"];
const SCREENSHOT_TYPES = ["food", "sleep", "workout"];
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_FOOD_CHARS = 2000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ValidationError";
    this.status = status;
  }
}

function validateFood(payload) {
  const text = payload?.text;
  if (typeof text !== "string" || text.trim() === "") {
    throw new ValidationError("Enter some food text.");
  }
  if (text.length > MAX_FOOD_CHARS) {
    throw new ValidationError("That text is too long.", 413);
  }
  return { text };
}

function decodedSize(base64) {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function validateScreenshot(payload) {
  const { type, mediaType, data } = payload ?? {};
  if (!SCREENSHOT_TYPES.includes(type)) {
    throw new ValidationError("Unsupported screenshot type.");
  }
  if (!IMAGE_TYPES.includes(mediaType)) {
    throw new ValidationError("Use a JPEG, PNG or WebP image.");
  }
  if (typeof data !== "string" || data === "") {
    throw new ValidationError("No image was sent.");
  }
  if (decodedSize(data) > MAX_IMAGE_BYTES) {
    throw new ValidationError("That image is too large. The limit is 4 MB.", 413);
  }
  if (data.length % 4 !== 0 || !BASE64.test(data)) {
    throw new ValidationError("That image could not be read.");
  }
  return { type, mediaType, data };
}

const VALIDATORS = {
  analyze: () => ({}),
  read_screenshot: validateScreenshot,
  split_food: validateFood,
  backfill_food: validateFood,
};

// Returns only the fields each action uses, so nothing else in the body can
// reach a prompt, a model choice or a token limit.
export function validateRequest(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("Invalid request.");
  }
  const { action, payload } = body;
  if (!ACTIONS.includes(action)) {
    throw new ValidationError("Unknown action.");
  }
  return { action, payload: VALIDATORS[action](payload) };
}
