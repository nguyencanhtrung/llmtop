// The providers this tool can read, by the name used in the config.
import { agy } from "./agy.mjs";
import { claude } from "./claude.mjs";
import { codex } from "./codex.mjs";

export const PROVIDERS = { claude, codex, agy };
export const PROVIDER_ORDER = ["claude", "codex", "agy"];

export const providerLabel = (name) => PROVIDERS[name]?.label ?? name;

export function familyOf(model, provider) {
  if (provider && PROVIDERS[provider]?.familyOf) return PROVIDERS[provider].familyOf(model);
  if (model.includes("claude")) return claude.familyOf(model);
  if (model.startsWith("gemini-")) return agy.familyOf(model);
  if (model.startsWith("gpt-") || model.startsWith("codex-")) return codex.familyOf(model);
  return claude.familyOf(model);
}

export function modelName(family) {
  for (const p of Object.values(PROVIDERS)) {
    const shown = p.displayModel?.(family);
    if (shown && shown !== family) return shown;
  }
  return family;
}
