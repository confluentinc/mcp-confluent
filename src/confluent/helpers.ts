import env, { Environment } from "@src/env";

/**
 * Validates the presence of a parameter by checking if it is provided directly or via an environment variable.
 *
 * @param envVarName - The name of the environment variable to check if the parameter is not provided.
 * @param errorMessage - The error message to throw if the parameter is not found.
 * @param param - The optional parameter to validate.
 * @returns The validated parameter, either from the provided value or the environment variable. Prefers the provided value vs the one loaded from environment variables.
 * @throws Will throw an error if the parameter is not found in both the provided value and the environment variable.
 */
export const validateParam = (
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

export const createResponse = (message: string) => ({
  content: [
    {
      type: "text",
      text: message,
    },
  ],
});
