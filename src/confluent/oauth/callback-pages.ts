import { fs } from "@src/confluent/node-deps.js";

const SUCCESS_TEMPLATE_FILE = "callback-success.html";
const FAILURE_TEMPLATE_FILE = "callback-failure.html";

const PARTIALS: Record<string, string> = {
  "{#include styles/}": "styles.html",
  "{#include logo/}": "logo.html",
};

const TEMPLATES_DIR_URL = new URL(
  "../../../assets/oauth-templates/",
  import.meta.url,
);

let cachedSuccessPage: string | undefined;
let cachedFailureTemplate: string | undefined;

function readTemplate(fileName: string): string {
  return fs.readFileSync(new URL(fileName, TEMPLATES_DIR_URL), "utf-8");
}

function inlinePartials(template: string): string {
  return Object.entries(PARTIALS).reduce(
    (acc, [directive, fileName]) =>
      acc.replace(directive, readTemplate(fileName)),
    template,
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderSuccessPage(): string {
  cachedSuccessPage ??= inlinePartials(readTemplate(SUCCESS_TEMPLATE_FILE));
  return cachedSuccessPage;
}

export function renderErrorPage(message: string): string {
  cachedFailureTemplate ??= inlinePartials(readTemplate(FAILURE_TEMPLATE_FILE));
  return cachedFailureTemplate.replace("{{error}}", () => escapeHtml(message));
}

/** Test-only: reset the module-level template cache. */
export function _resetCallbackPageCacheForTests(): void {
  cachedSuccessPage = undefined;
  cachedFailureTemplate = undefined;
}
