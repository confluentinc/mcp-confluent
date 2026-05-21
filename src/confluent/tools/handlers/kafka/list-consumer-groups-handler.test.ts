import { KafkaJS } from "@confluentinc/kafka-javascript";
import type {
  GroupOverview,
  LibrdKafkaError,
} from "@confluentinc/kafka-javascript/types/rdkafka.js";
import {
  listConsumerGroupsArgs,
  ListConsumerGroupsHandler,
} from "@src/confluent/tools/handlers/kafka/list-consumer-groups-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { textOf } from "@tests/call-tool-result.js";
import {
  bareRuntime,
  DEFAULT_CONNECTION_ID,
  kafkaRuntime,
} from "@tests/factories/runtime.js";
import { getMockedClientManager } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

/** Build a `GroupOverview` fixture with all fields populated. */
function fakeGroup(overrides: Partial<GroupOverview>): GroupOverview {
  return {
    groupId: "g",
    protocolType: "consumer",
    isSimpleConsumerGroup: false,
    state: KafkaJS.ConsumerGroupStates.STABLE,
    type: KafkaJS.ConsumerGroupTypes.CONSUMER,
    ...overrides,
  };
}

/** Build a `LibrdKafkaError` fixture with the required fields populated. */
function fakeError(overrides: Partial<LibrdKafkaError>): LibrdKafkaError {
  return {
    message: "broker error",
    code: 7,
    errno: 7,
    origin: "kafka",
    ...overrides,
  };
}

describe("list-consumer-groups-handler.ts", () => {
  describe("listConsumerGroupsArgs (schema)", () => {
    it("should accept an empty object (all fields optional)", () => {
      expect(() => listConsumerGroupsArgs.parse({})).not.toThrow();
    });

    it("should reject an empty matchStates array (the ambiguous filter)", () => {
      try {
        listConsumerGroupsArgs.parse({ matchStates: [] });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ZodError);
        const issues = (err as ZodError).issues;
        expect(issues).toHaveLength(1);
        expect(issues[0]!.path).toEqual(["matchStates"]);
        expect(issues[0]!.code).toBe("too_small");
      }
    });

    it("should reject an unknown state name", () => {
      try {
        listConsumerGroupsArgs.parse({ matchStates: ["Bogus"] });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ZodError);
        const issues = (err as ZodError).issues;
        expect(issues).toHaveLength(1);
        expect(issues[0]!.path).toEqual(["matchStates", 0]);
        expect(issues[0]!.code).toBe("invalid_value");
      }
    });

    it("should reject an unknown protocol type", () => {
      try {
        listConsumerGroupsArgs.parse({ matchType: "Bogus" });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ZodError);
        const issues = (err as ZodError).issues;
        expect(issues).toHaveLength(1);
        expect(issues[0]!.path).toEqual(["matchType"]);
        expect(issues[0]!.code).toBe("invalid_value");
      }
    });
  });

  describe("getToolConfig()", () => {
    const handler = new ListConsumerGroupsHandler();

    it("should expose the expected name, annotations, category, and predicate identity", () => {
      const config = handler.getToolConfig();
      expect(config.name).toBe(ToolName.LIST_CONSUMER_GROUPS);
      expect(config.annotations.readOnlyHint).toBe(true);
      expect(Object.keys(config.inputSchema).sort()).toEqual([
        "cluster_id",
        "environment_id",
        "matchStates",
        "matchType",
      ]);
    });
  });

  describe("enabledConnectionIds()", () => {
    const handler = new ListConsumerGroupsHandler();

    it("should enable on a kafka runtime", () => {
      expect(handler.enabledConnectionIds(kafkaRuntime())).toEqual([
        DEFAULT_CONNECTION_ID,
      ]);
    });

    it("should disable on a bare runtime", () => {
      expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
    });
  });

  describe("handle()", () => {
    const handler = new ListConsumerGroupsHandler();

    it("should return an empty structured payload and 'Found 0 consumer group(s).' when listGroups returns nothing", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.listGroups.mockResolvedValue({ groups: [], errors: [] });

      const result = await handler.handle(kafkaRuntime(clientManager), {});

      expect(admin.listGroups).toHaveBeenCalledOnce();
      expect(admin.listGroups).toHaveBeenCalledWith({});

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({ groups: [], errors: [] });
      expect(textOf(result)).toBe("Found 0 consumer group(s).");
    });

    it("should map numeric librdkafka state/type enums to TitleCase strings on the response", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.listGroups.mockResolvedValue({
        groups: [
          fakeGroup({
            groupId: "live",
            state: KafkaJS.ConsumerGroupStates.STABLE,
            type: KafkaJS.ConsumerGroupTypes.CONSUMER,
            protocolType: "consumer",
            isSimpleConsumerGroup: false,
          }),
          fakeGroup({
            groupId: "orphan",
            state: KafkaJS.ConsumerGroupStates.EMPTY,
            type: KafkaJS.ConsumerGroupTypes.CLASSIC,
            protocolType: "consumer",
            isSimpleConsumerGroup: true,
          }),
          fakeGroup({
            groupId: "shutting-down",
            state: KafkaJS.ConsumerGroupStates.DEAD,
            type: KafkaJS.ConsumerGroupTypes.UNKNOWN,
            protocolType: "",
            isSimpleConsumerGroup: false,
          }),
        ],
        errors: [],
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {});

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        groups: [
          {
            groupId: "live",
            state: "Stable",
            type: "Consumer",
            protocolType: "consumer",
            isSimpleConsumerGroup: false,
          },
          {
            groupId: "orphan",
            state: "Empty",
            type: "Classic",
            protocolType: "consumer",
            isSimpleConsumerGroup: true,
          },
          {
            groupId: "shutting-down",
            state: "Dead",
            type: "Unknown",
            protocolType: "",
            isSimpleConsumerGroup: false,
          },
        ],
        errors: [],
      });
      expect(textOf(result)).toBe("Found 3 consumer group(s).");
    });

    it("should forward matchStates to listGroups as the corresponding numeric enum values", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.listGroups.mockResolvedValue({ groups: [], errors: [] });

      await handler.handle(kafkaRuntime(clientManager), {
        matchStates: ["Stable", "Empty"],
      });

      expect(admin.listGroups).toHaveBeenCalledOnce();
      expect(admin.listGroups).toHaveBeenCalledWith({
        matchConsumerGroupStates: [
          KafkaJS.ConsumerGroupStates.STABLE,
          KafkaJS.ConsumerGroupStates.EMPTY,
        ],
      });
    });

    it("should wrap a scalar matchType in a single-element array for matchConsumerGroupTypes", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.listGroups.mockResolvedValue({ groups: [], errors: [] });

      await handler.handle(kafkaRuntime(clientManager), {
        matchType: "Consumer",
      });

      expect(admin.listGroups).toHaveBeenCalledOnce();
      expect(admin.listGroups).toHaveBeenCalledWith({
        matchConsumerGroupTypes: [KafkaJS.ConsumerGroupTypes.CONSUMER],
      });
    });

    it("should forward both filters together when both are supplied", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.listGroups.mockResolvedValue({ groups: [], errors: [] });

      await handler.handle(kafkaRuntime(clientManager), {
        matchStates: ["Stable"],
        matchType: "Classic",
      });

      expect(admin.listGroups).toHaveBeenCalledOnce();
      expect(admin.listGroups).toHaveBeenCalledWith({
        matchConsumerGroupStates: [KafkaJS.ConsumerGroupStates.STABLE],
        matchConsumerGroupTypes: [KafkaJS.ConsumerGroupTypes.CLASSIC],
      });
    });

    it("should switch the summary text to the (filtered) form when any filter is in play", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.listGroups.mockResolvedValue({
        groups: [fakeGroup({ groupId: "g1" }), fakeGroup({ groupId: "g2" })],
        errors: [],
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {
        matchStates: ["Stable"],
      });

      expect(textOf(result)).toBe("Found 2 consumer group(s) (filtered).");
    });

    it("should surface per-broker partial failures verbatim alongside the returned groups (not collapsed to a tool-level error)", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.listGroups.mockResolvedValue({
        groups: [fakeGroup({ groupId: "g1" })],
        errors: [
          fakeError({ message: "broker 2 unreachable", code: 6 }),
          fakeError({ message: "metadata stale", code: 17 }),
        ],
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {});

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        groups: [
          {
            groupId: "g1",
            state: "Stable",
            type: "Consumer",
            protocolType: "consumer",
            isSimpleConsumerGroup: false,
          },
        ],
        errors: [
          { message: "broker 2 unreachable", code: 6 },
          { message: "metadata stale", code: 17 },
        ],
      });
    });

    it("should return a tool-level error citing the first broker error when listGroups returns no groups and an error array", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.listGroups.mockResolvedValue({
        groups: [],
        errors: [
          fakeError({ message: "all brokers down", code: 6 }),
          fakeError({ message: "secondary failure", code: 2 }),
        ],
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {});

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("all brokers down");
    });

    it("should let listGroups rejections propagate without try/catch swallow", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.listGroups.mockRejectedValue(new Error("network unreachable"));

      await expect(
        handler.handle(kafkaRuntime(clientManager), {}),
      ).rejects.toThrow("network unreachable");
    });
  });
});
