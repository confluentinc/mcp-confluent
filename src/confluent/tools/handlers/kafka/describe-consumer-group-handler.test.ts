import { KafkaJS } from "@confluentinc/kafka-javascript";
import type {
  GroupDescription,
  LibrdKafkaError,
  MemberDescription,
  Node,
} from "@confluentinc/kafka-javascript/types/rdkafka.js";
import {
  describeConsumerGroupArgs,
  DescribeConsumerGroupHandler,
} from "@src/confluent/tools/handlers/kafka/describe-consumer-group-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { textOf } from "@tests/call-tool-result.js";
import { fakeLibrdKafkaError } from "@tests/factories/librdkafka.js";
import {
  DEFAULT_CONNECTION_ID,
  kafkaRuntime,
  runtimeWithDecoy,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

/** Build a {@link Node} coordinator fixture; pass `rack: undefined` explicitly
 *  to assert the field is omitted from the payload. */
function fakeCoordinator(overrides: Partial<Node> = {}): Node {
  return { id: 0, host: "broker.example.com", port: 9092, ...overrides };
}

/** Build a {@link MemberDescription} fixture with required Buffer fields
 *  populated (the handler is expected to drop them — these are present so the
 *  test fixture matches the upstream type, and a negative assertion can prove
 *  the handler stripped them). */
function fakeMember(overrides: Partial<MemberDescription>): MemberDescription {
  return {
    memberId: "consumer-1-abc",
    clientId: "consumer-1",
    clientHost: "/10.0.0.1",
    memberAssignment: Buffer.from([0x01, 0x02, 0x03]),
    memberMetadata: Buffer.from([0x04, 0x05]),
    assignment: [],
    ...overrides,
  };
}

/** Build a {@link GroupDescription} fixture with all fields populated.
 *  `error` accepts `null` in addition to the upstream type's
 *  `LibrdKafkaError | undefined` shape — kafkajs-compat populates the
 *  field as `null` at runtime when no error occurred, even though the
 *  `.d.ts` declares it absent. The factory exposes that runtime shape so
 *  tests can pin both the explicit-null happy path and the real-error
 *  path. */
function fakeGroupDescription(
  overrides: Omit<Partial<GroupDescription>, "error"> & {
    error?: LibrdKafkaError | null;
  },
): GroupDescription {
  return {
    groupId: "g",
    members: [],
    protocol: "range",
    isSimpleConsumerGroup: false,
    protocolType: "consumer",
    partitionAssignor: "range",
    state: KafkaJS.ConsumerGroupStates.STABLE,
    type: KafkaJS.ConsumerGroupTypes.CONSUMER,
    coordinator: fakeCoordinator(),
    ...overrides,
  } as GroupDescription;
}

/** Curried convenience: most error paths in this file exercise the
 *  not-found mapping, so the local wrapper pins
 *  `ERR_GROUP_ID_NOT_FOUND` as the default code and a matching default
 *  message. Tests for other error scenarios override `code` (and usually
 *  `message`) explicitly. */
function fakeNotFoundError(
  overrides: Partial<Parameters<typeof fakeLibrdKafkaError>[0]> = {},
) {
  return fakeLibrdKafkaError({
    message: "Broker: Group id not found",
    code: KafkaJS.ErrorCodes.ERR_GROUP_ID_NOT_FOUND,
    ...overrides,
  });
}

describe("describe-consumer-group-handler.ts", () => {
  describe("describeConsumerGroupArgs (schema)", () => {
    it("should accept the minimal valid input (groupId only)", () => {
      expect(() =>
        describeConsumerGroupArgs.parse({ groupId: "my-group" }),
      ).not.toThrow();
    });

    it("should reject a missing groupId", () => {
      try {
        describeConsumerGroupArgs.parse({});
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ZodError);
        const issues = (err as ZodError).issues;
        expect(issues).toHaveLength(1);
        expect(issues[0]!.path).toEqual(["groupId"]);
        expect(issues[0]!.code).toBe("invalid_type");
      }
    });

    it("should reject an empty groupId (min(1))", () => {
      try {
        describeConsumerGroupArgs.parse({ groupId: "" });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ZodError);
        const issues = (err as ZodError).issues;
        expect(issues).toHaveLength(1);
        expect(issues[0]!.path).toEqual(["groupId"]);
        expect(issues[0]!.code).toBe("too_small");
      }
    });
  });

  describe("getToolConfig()", () => {
    const handler = new DescribeConsumerGroupHandler();

    it("should expose the expected name, annotations, and schema keys", () => {
      const config = handler.getToolConfig();
      expect(config.name).toBe(ToolName.DESCRIBE_CONSUMER_GROUP);
      expect(config.annotations.readOnlyHint).toBe(true);
      expect(Object.keys(config.inputSchema).sort()).toEqual([
        "cluster_id",
        "environment_id",
        "groupId",
      ]);
    });

    it("should describe the per-member assignment shape honestly (not as 'TopicPartition[]', which the handler narrows past)", () => {
      // The response narrows `assignment` to `AssignedPartition[]`
      // (`{ topic, partition }` only — `error` / `leaderEpoch` stripped).
      // An earlier draft of this description, the response-type
      // docstring, and the CHANGELOG all advertised the wider
      // `TopicPartition[]` upstream shape — a literal-truth lie that
      // Copilot flagged. This test pins the description against
      // recurrence: the surfaced text must not advertise a wider shape
      // than the code actually returns.
      const description = handler.getToolConfig().description;
      expect(description).not.toMatch(/TopicPartition\[\]/);
      expect(description).toMatch(/\{ ?topic, ?partition ?\}/);
    });
  });

  describe("handle()", () => {
    const handler = new DescribeConsumerGroupHandler();

    it("should route to the explicitly addressed connection in a multi-connection config", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.describeGroups.mockResolvedValue({
        groups: [fakeGroupDescription({ groupId: "my-group" })],
      });

      await assertHandleCase({
        handler,
        runtime: runtimeWithDecoy(
          { kafka: { bootstrap_servers: "broker:9092" } },
          DEFAULT_CONNECTION_ID,
          clientManager,
        ),
        args: { groupId: "my-group" },
        outcome: { resolves: 'Consumer group "my-group" is' },
        clientManager,
      });
    });

    it("should forward the single groupId as a one-element array to describeGroups", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.describeGroups.mockResolvedValue({
        groups: [fakeGroupDescription({ groupId: "my-group" })],
      });

      await handler.handle(kafkaRuntime(clientManager), {
        groupId: "my-group",
      });

      expect(admin.describeGroups).toHaveBeenCalledOnce();
      expect(admin.describeGroups).toHaveBeenCalledWith(["my-group"]);
    });

    it("should return a flat structured payload for a Stable group with multiple members, members carrying disjoint cooked TopicPartition assignments", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.describeGroups.mockResolvedValue({
        groups: [
          fakeGroupDescription({
            groupId: "orders-consumer",
            state: KafkaJS.ConsumerGroupStates.STABLE,
            type: KafkaJS.ConsumerGroupTypes.CONSUMER,
            protocol: "range",
            protocolType: "consumer",
            partitionAssignor: "range",
            isSimpleConsumerGroup: false,
            coordinator: fakeCoordinator({
              id: 7,
              host: "b7.example.com",
              port: 9092,
            }),
            members: [
              fakeMember({
                memberId: "m1",
                clientId: "orders-c1",
                clientHost: "/10.0.0.1",
                assignment: [
                  { topic: "orders", partition: 0 },
                  { topic: "orders", partition: 1 },
                ],
              }),
              fakeMember({
                memberId: "m2",
                clientId: "orders-c2",
                clientHost: "/10.0.0.2",
                assignment: [
                  { topic: "orders", partition: 2 },
                  { topic: "orders", partition: 3 },
                ],
              }),
            ],
          }),
        ],
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "orders-consumer",
      });

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        groupId: "orders-consumer",
        state: "Stable",
        type: "Consumer",
        protocol: "range",
        partitionAssignor: "range",
        isSimpleConsumerGroup: false,
        coordinator: { id: 7, host: "b7.example.com", port: 9092 },
        members: [
          {
            memberId: "m1",
            clientId: "orders-c1",
            clientHost: "/10.0.0.1",
            assignment: [
              { topic: "orders", partition: 0 },
              { topic: "orders", partition: 1 },
            ],
          },
          {
            memberId: "m2",
            clientId: "orders-c2",
            clientHost: "/10.0.0.2",
            assignment: [
              { topic: "orders", partition: 2 },
              { topic: "orders", partition: 3 },
            ],
          },
        ],
      });
      expect(textOf(result)).toBe(
        'Consumer group "orders-consumer" is Stable with 2 member(s); coordinator b7.example.com:9092.',
      );
    });

    it("should return zero members and the singular summary suffix for an Empty (orphaned) group", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.describeGroups.mockResolvedValue({
        groups: [
          fakeGroupDescription({
            groupId: "orphan",
            state: KafkaJS.ConsumerGroupStates.EMPTY,
            members: [],
          }),
        ],
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "orphan",
      });

      expect(result.isError).toBe(false);
      expect(
        (result.structuredContent as { members: unknown[] }).members,
      ).toEqual([]);
      expect(textOf(result)).toBe(
        'Consumer group "orphan" is Empty with 0 member(s); coordinator broker.example.com:9092.',
      );
    });

    it("should translate a describeGroups rejection with ERR_GROUP_ID_NOT_FOUND into a caller-friendly tool-level error keyed on the requested name", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.describeGroups.mockRejectedValue(fakeNotFoundError());

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "no-such-group",
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        'Consumer group "no-such-group" not found on this cluster.',
      );
    });

    it("should translate a GroupDescription.error with ERR_GROUP_ID_NOT_FOUND into the same caller-friendly not-found error", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.describeGroups.mockResolvedValue({
        groups: [
          fakeGroupDescription({
            groupId: "no-such-group",
            error: fakeNotFoundError(),
          }),
        ],
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "no-such-group",
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        'Consumer group "no-such-group" not found on this cluster.',
      );
    });

    it("should treat a GroupDescription whose error field is explicitly null (kafkajs-compat's no-error sentinel) as a successful describe and not crash on the null dereference", async () => {
      // kafkajs-compat populates `error: null` on the GroupDescription
      // shape when no per-group error occurred, even though the upstream
      // `.d.ts` declares the field as `LibrdKafkaError | undefined`. A
      // `!== undefined` check would see `null` as "error present" and
      // crash dereferencing `null.code`. The handler uses `!= null`
      // (loose) so both `undefined` and `null` go through the no-error
      // path.
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.describeGroups.mockResolvedValue({
        groups: [
          fakeGroupDescription({
            groupId: "alive-group",
            state: KafkaJS.ConsumerGroupStates.STABLE,
            error: null,
          }),
        ],
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "alive-group",
      });

      expect(result.isError, textOf(result)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        groupId: "alive-group",
        state: "Stable",
      });
    });

    it("should translate the CCloud unknown-group tombstone shape (state=Dead, no members, empty protocol/partitionAssignor, no .error) into the same friendly not-found error", async () => {
      // Discovered via integration testing: Confluent Cloud's brokers
      // don't take either of the documented error paths for unknown
      // groups; they return a successful-shaped GroupDescription with
      // this exact fingerprint. The empty protocol/partitionAssignor
      // strings are the load-bearing signal — a real group that died
      // would still carry its last-used protocol name.
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.describeGroups.mockResolvedValue({
        groups: [
          fakeGroupDescription({
            groupId: "no-such-group",
            state: KafkaJS.ConsumerGroupStates.DEAD,
            members: [],
            protocol: "",
            partitionAssignor: "",
            isSimpleConsumerGroup: true,
            // no `.error` field set
          }),
        ],
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "no-such-group",
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        'Consumer group "no-such-group" not found on this cluster.',
      );
    });

    it("should NOT treat a Dead group that still carries its last-known protocol as not-found (a real group that died)", async () => {
      // Negative pin: the tombstone heuristic must hinge on the empty
      // protocol/partitionAssignor strings. A genuinely-dead consumer
      // group that previously had members will still carry its last-used
      // protocol — that's a legitimate Dead state, not a not-found.
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.describeGroups.mockResolvedValue({
        groups: [
          fakeGroupDescription({
            groupId: "rip-old-group",
            state: KafkaJS.ConsumerGroupStates.DEAD,
            members: [],
            protocol: "range",
            partitionAssignor: "range",
          }),
        ],
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "rip-old-group",
      });

      expect(result.isError).toBe(false);
      expect((result.structuredContent as { state: string }).state).toBe(
        "Dead",
      );
      expect(textOf(result)).toContain('"rip-old-group" is Dead');
    });

    it("should translate a GroupDescription.error with any other code into a tool-level error citing the broker message verbatim", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.describeGroups.mockResolvedValue({
        groups: [
          fakeGroupDescription({
            groupId: "g",
            error: fakeLibrdKafkaError({
              code: KafkaJS.ErrorCodes.ERR_GROUP_AUTHORIZATION_FAILED,
              message: "Broker: Group authorization failed",
            }),
          }),
        ],
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g",
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe("Broker: Group authorization failed");
    });

    it("should let a non-not-found describeGroups rejection propagate without try/catch swallow", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.describeGroups.mockRejectedValue(new Error("network unreachable"));

      await expect(
        handler.handle(kafkaRuntime(clientManager), { groupId: "g" }),
      ).rejects.toThrow("network unreachable");
    });

    it("should include groupInstanceId per member only when the upstream payload sets it (static membership)", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.describeGroups.mockResolvedValue({
        groups: [
          fakeGroupDescription({
            groupId: "mixed-membership",
            members: [
              fakeMember({
                memberId: "static-1",
                groupInstanceId: "deployment-pod-1",
                assignment: [{ topic: "t", partition: 0 }],
              }),
              fakeMember({
                memberId: "dynamic-1",
                // no groupInstanceId
                assignment: [{ topic: "t", partition: 1 }],
              }),
            ],
          }),
        ],
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "mixed-membership",
      });

      const members = (
        result.structuredContent as {
          members: Array<Record<string, unknown>>;
        }
      ).members;
      expect(members).toHaveLength(2);
      // Static member: field present with the upstream value.
      expect(members[0]!.groupInstanceId).toBe("deployment-pod-1");
      // Dynamic member: field literally absent from the payload (not
      // serialized as `undefined`), so a JSON-over-the-wire consumer sees
      // no key at all.
      expect("groupInstanceId" in members[1]!).toBe(false);
    });

    it("should keep the assignment array flat (topic/partition pairs, not grouped-by-topic) for a member assigned across many topics and partitions", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.describeGroups.mockResolvedValue({
        groups: [
          fakeGroupDescription({
            groupId: "fanout",
            members: [
              fakeMember({
                memberId: "single-fat-member",
                assignment: [
                  { topic: "orders", partition: 0 },
                  { topic: "orders", partition: 1 },
                  { topic: "payments", partition: 0 },
                  { topic: "shipments", partition: 5 },
                ],
              }),
            ],
          }),
        ],
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "fanout",
      });

      const members = (
        result.structuredContent as {
          members: Array<{ assignment: Array<{ topic: string }> }>;
        }
      ).members;
      expect(members[0]!.assignment).toEqual([
        { topic: "orders", partition: 0 },
        { topic: "orders", partition: 1 },
        { topic: "payments", partition: 0 },
        { topic: "shipments", partition: 5 },
      ]);
    });

    it("should narrow each assignment entry to {topic, partition} only, dropping upstream TopicPartition.error / .leaderEpoch", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.describeGroups.mockResolvedValue({
        groups: [
          fakeGroupDescription({
            members: [
              fakeMember({
                assignment: [
                  // Upstream TopicPartition is typed with optional
                  // `leaderEpoch` and `error`; the handler must strip
                  // them so the response shape stays the two-field
                  // pair the issue spec promised.
                  {
                    topic: "orders",
                    partition: 0,
                    leaderEpoch: 42,
                  },
                ],
              }),
            ],
          }),
        ],
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g",
      });

      const assignment = (
        result.structuredContent as {
          members: Array<{ assignment: Array<Record<string, unknown>> }>;
        }
      ).members[0]!.assignment;
      expect(assignment).toEqual([{ topic: "orders", partition: 0 }]);
      expect("leaderEpoch" in assignment[0]!).toBe(false);
      expect("error" in assignment[0]!).toBe(false);
    });

    it("should unwrap the {topicPartitions: TopicPartition[]} shape the native binding actually returns (despite the .d.ts claiming a flat array)", async () => {
      // Discovered via live MCP usage (May 2026): the kafkajs
      // .d.ts declares `assignment: TopicPartition[]` (flat array),
      // but the C++ binding in
      // node_modules/@confluentinc/kafka-javascript/src/common.cc →
      // FromMemberDescription actually returns
      // `assignment: { topicPartitions: TopicPartition[] }` (wrapped
      // object). The handler must unwrap this shape; the cast lets
      // the test fixture express the real runtime shape past the
      // upstream type lie.
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.describeGroups.mockResolvedValue({
        groups: [
          fakeGroupDescription({
            members: [
              fakeMember({
                memberId: "wrapped-member",
                assignment: {
                  topicPartitions: [
                    { topic: "orders", partition: 0 },
                    { topic: "orders", partition: 1 },
                  ],
                },
              } as unknown as Partial<MemberDescription>),
            ],
          }),
        ],
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g",
      });

      const member = (
        result.structuredContent as {
          members: Array<{
            assignment: Array<{ topic: string; partition: number }>;
          }>;
        }
      ).members[0]!;
      expect(member.assignment).toEqual([
        { topic: "orders", partition: 0 },
        { topic: "orders", partition: 1 },
      ]);
    });

    it("should fall through to an empty assignment (the Wacky branch) for an unrecognized assignment shape", async () => {
      // Negative pin: if the binding ever delivers a third shape we
      // haven't seen (a Buffer, a string, etc.), the handler must
      // return a usable response with an empty assignment rather
      // than crashing. The Wacky log line provides the visibility.
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.describeGroups.mockResolvedValue({
        groups: [
          fakeGroupDescription({
            members: [
              fakeMember({
                memberId: "unknown-shape-member",
                assignment: Buffer.from([
                  0xde, 0xad, 0xbe, 0xef,
                ]) as unknown as MemberDescription["assignment"],
              }),
            ],
          }),
        ],
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g",
      });

      expect(result.isError).toBe(false);
      const member = (
        result.structuredContent as {
          members: Array<{ assignment: unknown[] }>;
        }
      ).members[0]!;
      expect(member.assignment).toEqual([]);
    });

    it("should drop the raw memberAssignment / memberMetadata Buffer fields the upstream type carries", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.describeGroups.mockResolvedValue({
        groups: [
          fakeGroupDescription({
            groupId: "g",
            members: [fakeMember({ assignment: [] })],
          }),
        ],
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g",
      });

      const member = (
        result.structuredContent as {
          members: Array<Record<string, unknown>>;
        }
      ).members[0]!;
      expect("memberAssignment" in member).toBe(false);
      expect("memberMetadata" in member).toBe(false);
    });

    it("should include coordinator.rack only when the upstream Node carries it", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.describeGroups.mockResolvedValue({
        groups: [
          fakeGroupDescription({
            coordinator: fakeCoordinator({ rack: "us-east-1a" }),
          }),
        ],
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g",
      });

      expect(
        (result.structuredContent as { coordinator: Record<string, unknown> })
          .coordinator,
      ).toEqual({
        id: 0,
        host: "broker.example.com",
        port: 9092,
        rack: "us-east-1a",
      });
    });

    it("should omit coordinator.rack entirely when the upstream Node does not carry it", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.describeGroups.mockResolvedValue({
        groups: [
          fakeGroupDescription({
            coordinator: fakeCoordinator(),
          }),
        ],
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g",
      });

      const coordinator = (
        result.structuredContent as { coordinator: Record<string, unknown> }
      ).coordinator;
      expect("rack" in coordinator).toBe(false);
    });

    it("should surface the cooperative-sticky partitionAssignor verbatim on the response", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.describeGroups.mockResolvedValue({
        groups: [
          fakeGroupDescription({
            partitionAssignor: "cooperative-sticky",
          }),
        ],
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g",
      });

      expect(
        (result.structuredContent as { partitionAssignor: string })
          .partitionAssignor,
      ).toBe("cooperative-sticky");
    });

    it("should return the friendly not-found error when describeGroups resolves with an empty groups array (wacky path)", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.describeGroups.mockResolvedValue({ groups: [] });

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "no-such-group",
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        'Consumer group "no-such-group" not found on this cluster.',
      );
    });
  });
});
