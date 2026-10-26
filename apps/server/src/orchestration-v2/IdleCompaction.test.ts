import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  idleCompactionWindow,
  openCodeAutoCompactThreshold,
  thresholdCompactionDue,
  type IdleCompactionRecords,
} from "./IdleCompaction.ts";

const NOW_MS = Date.parse("2026-10-19T12:00:00.000Z");
const MINUTE_MS = 60_000;
const at = (offset = 0) => DateTime.makeUnsafe(NOW_MS + offset);
const threadId = ThreadId.make("idle-thread");
const runId = RunId.make("run-1");
const instanceId = ProviderInstanceId.make("claudeAgent");
const providerThreadId = ProviderThreadId.make("provider-thread");
const modelSelection = { instanceId, model: "claude-opus-5-5" };

function records(
  usage: { readonly usedTokens?: number; readonly cacheExpiresInMs?: number } = {},
): { -readonly [Key in keyof IdleCompactionRecords]: IdleCompactionRecords[Key] } {
  const messageId = MessageId.make("message-1");
  const nodeId = NodeId.make("root-node");
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Idle thread",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdAt: at(-MINUTE_MS),
      updatedAt: at(),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: at(),
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId,
        userMessageId: messageId,
        rootNodeId: nodeId,
        activeAttemptId: null,
        status: "completed",
        requestedAt: at(-MINUTE_MS),
        startedAt: at(-MINUTE_MS),
        completedAt: at(),
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    messages: [
      {
        id: messageId,
        threadId,
        runId,
        nodeId,
        role: "user",
        text: "Explain this code",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: at(-MINUTE_MS),
        updatedAt: at(-MINUTE_MS),
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        driver: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: nodeId,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        createdAt: at(-MINUTE_MS),
        updatedAt: at(),
      },
    ],
    providerTurns: [
      {
        id: ProviderTurnId.make("provider-turn-1"),
        providerThreadId,
        nodeId,
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "completed",
        startedAt: at(-MINUTE_MS),
        completedAt: at(),
        tokenUsage: {
          usedTokens: usage.usedTokens ?? 250_000,
          ...(usage.cacheExpiresInMs === undefined
            ? {}
            : { promptCacheExpiresAt: DateTime.formatIso(at(usage.cacheExpiresInMs)) }),
          updatedAt: DateTime.formatIso(at()),
        },
      },
    ],
    runtimeRequests: [],
    turnItems: [],
    contextTransfers: [],
  };
}

describe("idleCompactionWindow", () => {
  it("skips small contexts, unknown expiry, other providers, switched threads, and compactions", () => {
    const cache = { cacheExpiresInMs: 60 * MINUTE_MS };
    expect(idleCompactionWindow(records({ ...cache, usedTokens: 199_999 }), NOW_MS)).toBeNull();
    expect(idleCompactionWindow(records(), NOW_MS)).toBeNull();
    const codex = records(cache);
    codex.providerThreads = [
      { ...codex.providerThreads[0]!, driver: ProviderDriverKind.make("codex") },
    ];
    expect(idleCompactionWindow(codex, NOW_MS)).toBeNull();
    const switched = records(cache);
    switched.thread = { ...switched.thread, providerInstanceId: ProviderInstanceId.make("codex") };
    expect(idleCompactionWindow(switched, NOW_MS)).toBeNull();
    const compacted = records(cache);
    compacted.messages = [{ ...compacted.messages[0]!, text: "/compact" }];
    expect(idleCompactionWindow(compacted, NOW_MS)).toBeNull();
    const archived = records(cache);
    archived.thread = { ...archived.thread, archivedAt: at() };
    expect(idleCompactionWindow(archived, NOW_MS)).toBeNull();
  });
});

const openCodeInstanceId = ProviderInstanceId.make("opencode");

function openCodeRecords(
  usage: { readonly usedTokens?: number; readonly autoCompactThreshold?: number } = {},
): { -readonly [Key in keyof IdleCompactionRecords]: IdleCompactionRecords[Key] } {
  const base = records(usage.usedTokens === undefined ? {} : { usedTokens: usage.usedTokens });
  return {
    ...base,
    thread: {
      ...base.thread,
      providerInstanceId: openCodeInstanceId,
      modelSelection: { instanceId: openCodeInstanceId, model: "opencode/big-pickle" },
    },
    runs: [
      {
        ...base.runs[0]!,
        providerInstanceId: openCodeInstanceId,
        modelSelection: { instanceId: openCodeInstanceId, model: "opencode/big-pickle" },
      },
    ],
    providerThreads: [
      {
        ...base.providerThreads[0]!,
        driver: ProviderDriverKind.make("opencode"),
        providerInstanceId: openCodeInstanceId,
      },
    ],
    providerTurns: [
      {
        ...base.providerTurns[0]!,
        tokenUsage: {
          usedTokens: usage.usedTokens ?? 250_000,
          maxTokens: 1_000_000,
          ...(usage.autoCompactThreshold === undefined
            ? {}
            : { autoCompactThreshold: usage.autoCompactThreshold }),
          updatedAt: DateTime.formatIso(at()),
        },
      },
    ],
  };
}

describe("thresholdCompactionDue", () => {
  it("fires at and above the threshold, and skips below it", () => {
    expect(thresholdCompactionDue(openCodeRecords({ usedTokens: 199_999 }), 200_000)).toBeNull();
    expect(thresholdCompactionDue(openCodeRecords({ usedTokens: 200_000 }), 200_000)).toEqual({
      runId,
    });
    expect(thresholdCompactionDue(openCodeRecords({ usedTokens: 400_000 }), 200_000)).toEqual({
      runId,
    });
  });

  it("prefers the threshold the provider reported over the configured one", () => {
    // A tighter provider-reported threshold fires even when the configured one is higher.
    expect(
      thresholdCompactionDue(
        openCodeRecords({ usedTokens: 150_000, autoCompactThreshold: 100_000 }),
        200_000,
      ),
    ).toEqual({ runId });
    // A looser provider-reported threshold holds back a crossed configured one.
    expect(
      thresholdCompactionDue(
        openCodeRecords({ usedTokens: 150_000, autoCompactThreshold: 300_000 }),
        100_000,
      ),
    ).toBeNull();
  });

  it("skips unset thresholds, other drivers, and compactions", () => {
    expect(thresholdCompactionDue(openCodeRecords(), 0)).toBeNull();
    expect(thresholdCompactionDue(openCodeRecords(), Number.NaN)).toBeNull();
    const claude = records({ usedTokens: 400_000 });
    expect(thresholdCompactionDue(claude, 200_000)).toBeNull();
    const compacted = openCodeRecords({ usedTokens: 400_000 });
    compacted.messages = [{ ...compacted.messages[0]!, text: "/compact" }];
    expect(thresholdCompactionDue(compacted, 200_000)).toBeNull();
    const running = openCodeRecords({ usedTokens: 400_000 });
    running.runs = [{ ...running.runs[0]!, status: "running", completedAt: null }];
    expect(thresholdCompactionDue(running, 200_000)).toBeNull();
    const pending = openCodeRecords({ usedTokens: 400_000 });
    pending.runtimeRequests = [
      {
        id: RuntimeRequestId.make("request-1"),
        nodeId: NodeId.make("root-node"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "permission",
        status: "pending",
        responseCapability: {
          type: "live",
          providerSessionId: ProviderSessionId.make("provider-session-1"),
        },
        createdAt: at(),
        resolvedAt: null,
      },
    ];
    expect(thresholdCompactionDue(pending, 200_000)).toBeNull();
  });
});

describe("openCodeAutoCompactThreshold", () => {
  const settingsFor = (config: unknown) => ({
    providerInstances: {
      [openCodeInstanceId]: { driver: ProviderDriverKind.make("opencode"), config },
    },
  });
  it("reads the instance threshold and rejects empty or invalid values", () => {
    expect(
      openCodeAutoCompactThreshold(
        settingsFor({ autoCompactThreshold: "200000" }),
        openCodeInstanceId,
      ),
    ).toBe(200_000);
    expect(openCodeAutoCompactThreshold(settingsFor({}), openCodeInstanceId)).toBeNull();
    expect(
      openCodeAutoCompactThreshold(settingsFor({ autoCompactThreshold: "" }), openCodeInstanceId),
    ).toBeNull();
    expect(
      openCodeAutoCompactThreshold(
        settingsFor({ autoCompactThreshold: "lots" }),
        openCodeInstanceId,
      ),
    ).toBeNull();
    expect(
      openCodeAutoCompactThreshold(
        settingsFor({ autoCompactThreshold: "200000" }),
        ProviderInstanceId.make("codex"),
      ),
    ).toBeNull();
  });
});
