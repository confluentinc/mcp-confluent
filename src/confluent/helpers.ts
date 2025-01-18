import env, { Environment } from "@src/env.js";

/**
 * Ensures a parameter exists either from the provided value or environment variable. Favor the provided param over the environment variable when truthy.
 * @param envVarName - The name of the environment variable to check
 * @param errorMessage - The error message to throw if neither parameter nor environment variable exists
 * @param param - Optional parameter value to use instead of environment variable
 * @returns The parameter value or environment variable value
 * @throws {Error} When neither parameter nor environment variable exists
 */
export const getEnsuredParam = (
  envVarName: keyof Environment,
  errorMessage: string,
  param?: string,
) => {
  const finalParam = param || env[envVarName];
  if (!finalParam) {
    throw new Error(`${errorMessage}`);
  }
  return finalParam;
};

// /**
//  * Returns the value from the environment variable if the provided value is falsy
//  * @param envVarName - The name of the environment variable to retrieve
//  * @param value - Optional value to use instead of environment variable
//  * @returns The provided value if it exists, otherwise the value from the environment variable
//  */
// export const getValueWithEnvVarFallback = (
//   envVarName: keyof Environment,
//   value?: string,
// ) => value || env[envVarName];

export const createResponse = (message: string) => ({
  content: [
    {
      type: "text",
      text: message,
    },
  ],
});
