import type { ErrorEvent } from "@sentry/node";
import { REDACTED, redactEvent } from "@src/confluent/sentry-redact.js";
import { describe, expect, it } from "vitest";

function flatten(event: ErrorEvent): string {
  return JSON.stringify(event);
}

describe("redactEvent", () => {
  it("scrubs every known secret shape", () => {
    const event = {
      message:
        "auth failed: Bearer abcDEF123.token-value_990 and Basic dXNlcjpwYXNz",
      exception: {
        values: [
          {
            type: "Error",
            value:
              "Connection error sasl.password=SuperSecretPass123 api_key: ABC123DEF456GHI7 secret: aB9kQ2mN7pR4tV6xY1zC3dE5fG8hJ0kL2mN4pQ6rS8tU0vW",
          },
        ],
      },
      request: {
        headers: {
          Authorization: "Bearer xyzToken1234567890",
          "x-api-key": "ABC123DEF456GHI7",
          cookie: "session=deadbeef",
        },
      },
      extra: {
        configYaml: "kafka:\n  api_secret: aB9kQ2mN7pR4tV6xY1zC3dE5fG8hJ0kL\n",
        password: "plaintext-pw",
      },
    } as unknown as ErrorEvent;

    const out = flatten(redactEvent(event));

    expect(out).toContain(REDACTED);
    expect(out).not.toContain("SuperSecretPass123");
    expect(out).not.toContain("xyzToken1234567890");
    expect(out).not.toContain("dXNlcjpwYXNz");
    expect(out).not.toContain(
      "aB9kQ2mN7pR4tV6xY1zC3dE5fG8hJ0kL2mN4pQ6rS8tU0vW",
    );
    expect(out).not.toContain("aB9kQ2mN7pR4tV6xY1zC3dE5fG8hJ0kL");
    expect(out).not.toContain("plaintext-pw");
    expect(out).not.toContain("session=deadbeef");
  });

  it("preserves non-secret content", () => {
    const event = {
      message: "Failed to fetch topics: 404 Not Found",
    } as unknown as ErrorEvent;
    expect(redactEvent(event).message).toBe(
      "Failed to fetch topics: 404 Not Found",
    );
  });
});
