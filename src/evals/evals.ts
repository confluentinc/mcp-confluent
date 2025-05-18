//evals.ts

import { EvalConfig } from 'mcp-evals';
import { openai } from "@ai-sdk/openai";
import { grade, EvalFunction } from "mcp-evals";

const CustomToolEval: EvalFunction = {
    name: "Custom Tool Evaluation",
    description: "Evaluates the functionality of the custom tool",
    run: async () => {
        const result = await grade(openai("gpt-4"), "How does this custom tool handle input data with a specific session context?");
        return JSON.parse(result);
    }
};

const ListFlinkStatementsEval: EvalFunction = {
  name: "ListFlinkStatements Tool Evaluation",
  description: "Evaluates the correctness and completeness of listing Flink SQL statements with specific parameters",
  run: async () => {
    const result = await grade(openai("gpt-4"), "List the Flink SQL statements for organization 123 in environment dev with a label selector of 'type=test' and a page size of 5.");
    return JSON.parse(result);
  }
};

const CreateFlinkStatementHandlerEval: EvalFunction = {
    name: "CreateFlinkStatementHandlerEval",
    description: "Evaluates the functionality of the CreateFlinkStatementHandler tool",
    run: async () => {
        const result = await grade(openai("gpt-4"), "Create a Flink statement named 'test_statement' with catalog 'test_catalog', database 'test_db', and the statement 'SELECT * FROM test_table' for a specific compute pool, environment, and organization using the CreateFlinkStatementHandler tool.");
        return JSON.parse(result);
    }
};

const DeleteFlinkStatementHandlerEval: EvalFunction = {
    name: "DeleteFlinkStatementHandlerEval",
    description: "Evaluates the functionality of deleting a Flink SQL statement",
    run: async () => {
        const result = await grade(openai("gpt-4"), "Please delete the Flink SQL statement named 'test-statement' from environment 'env-123' in organization 'org-456' using the base URL 'https://flink.example.com'.");
        return JSON.parse(result);
    }
};

const readFlinkStatementEval: EvalFunction = {
    name: "ReadFlinkStatement Tool Evaluation",
    description: "Evaluates the tool's ability to read a Flink statement and its results",
    run: async () => {
        const result = await grade(openai("gpt-4"), "Please read the results of the Flink SQL statement named 'testStatement' from environment 'testEnv' in org 'testOrg'.");
        return JSON.parse(result);
    }
};

const config: EvalConfig = {
    model: openai("gpt-4"),
    evals: [CustomToolEval, ListFlinkStatementsEval, CreateFlinkStatementHandlerEval, DeleteFlinkStatementHandlerEval, readFlinkStatementEval]
};
  
export default config;
  
export const evals = [CustomToolEval, ListFlinkStatementsEval, CreateFlinkStatementHandlerEval, DeleteFlinkStatementHandlerEval, readFlinkStatementEval];