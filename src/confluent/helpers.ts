import env, { Environment } from "@src/env.js";

/**
 * Ensures a parameter exists either from the provided value or environment variable. Favor the provided param over the environment variable when truthy.
 * @param envVarName - The name of the environment variable to check
 * @param errorMessage - The error message to throw if neither parameter nor environment variable exists
 * @param param - Optional parameter value to use instead of environment variable
 * @returns The parameter value or environment variable value with its original type
 * @throws {Error} When neither parameter nor environment variable exists
 */
export const getEnsuredParam = <T extends Environment[keyof Environment]>(
  envVarName: keyof Environment,
  errorMessage: string,
  param?: T,
): T => {
  const finalParam = param || env[envVarName];
  if (!finalParam) {
    throw new Error(`${errorMessage}`);
  }
  return finalParam as T;
};

/**
 *  Resolves a template string by replacing placeholders with corresponding values from the args object.
 *  Placeholders are in the format {key}, where key corresponds to a key in the args object.
 *  If a key is not found in the args object, it will be replaced with the original placeholder.
 *  @param template - The template string containing placeholders
 *  @param args - An object containing key-value pairs for replacement
 *  @returns The resolved string with placeholders replaced by corresponding values
 */
export const fillTemplate = (
  template: string,
  args: Record<string, string>,
): string => {
  return template.replace(/{(\w+)}/g, (_, key) => args[key] ?? `{${key}}`);
};
