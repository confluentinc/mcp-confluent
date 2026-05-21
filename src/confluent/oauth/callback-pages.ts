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

let cachedSuccessTemplate: string | undefined;
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

/**
 * Render the OAuth success page. The `copiedPath` and `streamPath` placeholders
 * in the template are replaced with the same constants the server registers
 * its handlers under, so the page and server can't drift on path naming.
 */
export function renderSuccessPage(opts: {
  copiedPath: string;
  streamPath: string;
}): string {
  cachedSuccessTemplate ??= inlinePartials(readTemplate(SUCCESS_TEMPLATE_FILE));
  return cachedSuccessTemplate
    .replaceAll("{{copiedPath}}", opts.copiedPath)
    .replaceAll("{{streamPath}}", opts.streamPath);
}

export function renderErrorPage(message: string): string {
  cachedFailureTemplate ??= inlinePartials(readTemplate(FAILURE_TEMPLATE_FILE));
  return cachedFailureTemplate.replace("{{error}}", () => escapeHtml(message));
}

/** Test-only: reset the module-level template cache. */
export function _resetCallbackPageCacheForTests(): void {
  cachedSuccessTemplate = undefined;
  cachedFailureTemplate = undefined;
}
