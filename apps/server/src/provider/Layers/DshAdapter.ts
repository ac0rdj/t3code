/**
 * DshAdapter — DeepSeek Harness through its ACP profile.
 *
 * DSH is a pure ACP v1 agent: it streams standard `session/update`
 * notifications and selects models through standard configuration options. It
 * never asks this client for permission, so no approval handler is registered
 * and no interaction-mode toggle applies.
 *
 * @module provider/Layers/DshAdapter
 */
import {
  ApprovalRequestId,
  type DshSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type ProviderDriverKind,
  ProviderInstanceId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  applyDshAcpModelSelection,
  DSH_REASONING_EFFORT_OPTION_ID,
  makeDshAcpRuntime,
} from "../acp/DshAcpSupport.ts";
import type { DshAdapterShape } from "../Services/DshAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const PROVIDER: ProviderDriverKind = "dsh" as ProviderDriverKind;
const DSH_RESUME_VERSION = 1 as const;
const NANOS_PER_MILLI = 1_000_000n;
/**
 * DSH's reasoning phase is not visible on the ACP stream, so a silent turn is
 * not by itself a stall. Ten minutes without any update is long enough that
 * settling the turn beats showing work forever.
 */
const DEFAULT_DSH_TURN_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;
/**
 * A tool can legitimately run without emitting text for far longer than
 * reasoning, but it still needs a deadline so a lost update cannot leave the
 * turn working forever.
 */
const DEFAULT_DSH_ACTIVE_TOOL_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1_000;

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface DshAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * Resolves a workspace path. Production passes the server's `Path` service so
   * this adapter never depends on it; tests can pass `path.resolve`.
   */
  readonly resolveCwd?: (cwd: string) => string;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  /** Override the conservative ACP turn liveness timeout in focused tests. */
  readonly turnInactivityTimeoutMs?: number;
  /** Override the longer active-tool liveness timeout in focused tests. */
  readonly activeToolInactivityTimeoutMs?: number;
}

interface DshTurnLivenessSignal {
  readonly turnId: TurnId;
}

interface DshSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Turns already interrupted or settled; late prompt RPCs must not revive them. */
  readonly settledTurnIds: Set<TurnId>;
  /** Prompts in flight or being prepared. A steer reuses the active turn, so
   * only the last remaining prompt settles it. */
  promptsInFlight: number;
  model: string | undefined;
  stopped: boolean;
  readonly livenessSignals: Queue.Queue<DshTurnLivenessSignal>;
  livenessTurnId: TurnId | undefined;
  lastTurnActivityAtNanos: bigint | undefined;
  readonly activeToolCallIds: Set<string>;
  livenessUpdatesInFlight: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDshResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== DSH_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

/**
 * Whether a stalled turn should be settled.
 *
 * DSH's reasoning phase is silent on the ACP stream, so a turn that emits
 * nothing is only a stall once the deadline passes. This is the whole liveness
 * decision, kept pure so it can be tested without a live harness: a turn is
 * stalled only when it is still the live turn, nothing is waiting on the user,
 * and no update has arrived within the timeout for its current shape (a turn
 * with an open tool call gets the longer deadline).
 */
export function shouldSettleStalledTurn(input: {
  /** The turn the watchdog is tracking. */
  readonly livenessTurnId: TurnId | undefined;
  readonly turnId: TurnId;
  readonly stopped: boolean;
  readonly liveTurn: boolean;
  readonly settled: boolean;
  /** True while an update is being processed or a user response is pending. */
  readonly paused: boolean;
  readonly lastActivityAtNanos: bigint | undefined;
  readonly nowNanos: bigint;
  readonly timeoutMs: number;
}): boolean {
  if (input.stopped || input.settled || input.paused) {
    return false;
  }
  if (input.livenessTurnId !== input.turnId || !input.liveTurn) {
    return false;
  }
  if (input.lastActivityAtNanos === undefined) {
    return false;
  }
  return input.nowNanos - input.lastActivityAtNanos >= BigInt(input.timeoutMs) * NANOS_PER_MILLI;
}

/**
 * How a settled prompt affects its turn.
 *
 * A prompt sent while another is in flight is a steer, so the merged turn only
 * settles when the last prompt resolves. An interrupt settles the turn itself,
 * and a late prompt response must not settle it a second time. This is the whole
 * bookkeeping decision, kept pure so both halves can be tested directly.
 */
export function nextPromptSettlement(input: {
  readonly promptsInFlight: number;
  readonly settled: boolean;
}): {
  readonly promptsInFlight: number;
  readonly shouldSettle: boolean;
} {
  const promptsInFlight = Math.max(0, input.promptsInFlight - 1);
  return {
    promptsInFlight,
    shouldSettle: promptsInFlight === 0 && !input.settled,
  };
}

export function makeDshAdapter(dshSettings: DshSettings, options?: DshAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("dsh");
    const resolveCwd = options?.resolveCwd ?? ((cwd: string) => cwd);
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, DshSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    // `Crypto.randomUUIDv4` is `Effect<string, PlatformError>` (effect/Crypto).
    // Map the platform failure at its source; otherwise `PlatformError` rides
    // along in `makeEventStamp` and leaks into every method that stamps an
    // event, which is not part of `ProviderAdapterError`.
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate DeepSeek Harness runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = Option.fromNullishOr(current.get(threadId));
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const turnInactivityTimeoutMs =
      typeof options?.turnInactivityTimeoutMs === "number" &&
      Number.isFinite(options.turnInactivityTimeoutMs)
        ? Math.max(1, Math.floor(options.turnInactivityTimeoutMs))
        : DEFAULT_DSH_TURN_INACTIVITY_TIMEOUT_MS;
    const activeToolInactivityTimeoutMs =
      typeof options?.activeToolInactivityTimeoutMs === "number" &&
      Number.isFinite(options.activeToolInactivityTimeoutMs)
        ? Math.max(1, Math.floor(options.activeToolInactivityTimeoutMs))
        : DEFAULT_DSH_ACTIVE_TOOL_INACTIVITY_TIMEOUT_MS;

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to write native DeepSeek Harness notification log.", {
            cause,
            threadId,
            method,
          }),
        ),
      );

    const emitPlanUpdate = (
      ctx: DshSessionContext,
      turnId: TurnId | undefined,
      stamp: { readonly eventId: EventId; readonly createdAt: string },
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${turnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp,
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload,
            source: "acp.jsonrpc",
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<DshSessionContext, ProviderAdapterValidationError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "session",
            issue: `No active DeepSeek Harness session for thread '${threadId}'.`,
          }),
        );
      }
      return Effect.succeed(ctx);
    };

    const signalTurnLiveness = (ctx: DshSessionContext, turnId: TurnId) =>
      Queue.offer(ctx.livenessSignals, { turnId }).pipe(Effect.asVoid);

    const beginTurnLiveness = (ctx: DshSessionContext, turnId: TurnId) =>
      Effect.gen(function* () {
        // Start the deadline at turn start. DSH's reasoning phase emits nothing,
        // and the watchdog only wakes on an activity signal or an existing
        // deadline, so waiting for the first update would leave a silent turn
        // active forever.
        const startedAtNanos = yield* Clock.monotonicTimeNanos;
        ctx.livenessTurnId = turnId;
        ctx.lastTurnActivityAtNanos = startedAtNanos;
        ctx.activeToolCallIds.clear();
        ctx.livenessUpdatesInFlight = 0;
      });

    const clearTurnLiveness = (ctx: DshSessionContext) => {
      ctx.livenessTurnId = undefined;
      ctx.lastTurnActivityAtNanos = undefined;
      ctx.activeToolCallIds.clear();
      ctx.livenessUpdatesInFlight = 0;
    };

    const recordTurnActivity = (
      ctx: DshSessionContext,
      turnId: TurnId,
      event: Extract<
        AcpSessionRuntime.AcpSessionRuntimeEvent,
        {
          _tag:
            | "AssistantItemStarted"
            | "AssistantItemCompleted"
            | "PlanUpdated"
            | "ToolCallUpdated"
            | "ContentDelta";
        }
      >,
    ) =>
      Effect.gen(function* () {
        if (
          ctx.livenessTurnId !== turnId ||
          (event._tag === "ContentDelta" && event.text.length === 0)
        ) {
          return;
        }
        ctx.livenessUpdatesInFlight += 1;
        try {
          const activityAtNanos = yield* Clock.monotonicTimeNanos;
          if (ctx.livenessTurnId !== turnId || ctx.settledTurnIds.has(turnId)) {
            return;
          }
          if (event._tag === "ToolCallUpdated") {
            if (event.toolCall.status === "completed" || event.toolCall.status === "failed") {
              ctx.activeToolCallIds.delete(event.toolCall.toolCallId);
            } else {
              ctx.activeToolCallIds.add(event.toolCall.toolCallId);
            }
          }
          ctx.lastTurnActivityAtNanos = activityAtNanos;
        } finally {
          // Decrement before signalling so the watchdog cannot consume a wake
          // while this update is still counted as in flight.
          ctx.livenessUpdatesInFlight = Math.max(0, ctx.livenessUpdatesInFlight - 1);
          yield* signalTurnLiveness(ctx, turnId);
        }
      });

    const hasLivenessPause = (ctx: DshSessionContext) => ctx.livenessUpdatesInFlight > 0;

    const livenessTimeoutFor = (ctx: DshSessionContext) =>
      ctx.activeToolCallIds.size > 0 ? activeToolInactivityTimeoutMs : turnInactivityTimeoutMs;

    const isLiveTurn = (ctx: DshSessionContext, turnId: TurnId) =>
      ctx.promptsInFlight > 0 &&
      ctx.activeTurnId === turnId &&
      (ctx.session.status === "running" || ctx.session.status === "connecting");

    /** Settles a turn exactly once. A repeat call for the same turn is a no-op. */
    const settleTurn = (
      ctx: DshSessionContext,
      turnId: TurnId,
      payload:
        | { readonly state: "failed"; readonly errorMessage: string }
        | {
            readonly state: "completed" | "cancelled";
            readonly stopReason: EffectAcpSchema.StopReason | null;
          },
    ) =>
      Effect.gen(function* () {
        if (ctx.settledTurnIds.has(turnId) || ctx.activeTurnId !== turnId) {
          return;
        }
        ctx.settledTurnIds.add(turnId);
        clearTurnLiveness(ctx);
        ctx.promptsInFlight = 0;
        const updatedAt = yield* nowIso;
        const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
        ctx.activeTurnId = undefined;
        ctx.session = { ...readySession, status: "ready", updatedAt };
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload,
        });
      });

    const settleStalledTurn = (ctx: DshSessionContext, turnId: TurnId) =>
      withThreadLock(
        ctx.threadId,
        Effect.gen(function* () {
          const liveCtx = sessions.get(ctx.threadId);
          if (
            liveCtx !== ctx ||
            ctx.stopped ||
            !isLiveTurn(ctx, turnId) ||
            ctx.settledTurnIds.has(turnId) ||
            hasLivenessPause(ctx)
          ) {
            return;
          }
          const nowNanos = yield* Clock.monotonicTimeNanos;
          if (
            !shouldSettleStalledTurn({
              livenessTurnId: ctx.livenessTurnId,
              turnId,
              stopped: ctx.stopped,
              liveTurn: isLiveTurn(ctx, turnId),
              settled: ctx.settledTurnIds.has(turnId),
              paused: hasLivenessPause(ctx),
              lastActivityAtNanos: ctx.lastTurnActivityAtNanos,
              nowNanos,
              timeoutMs: livenessTimeoutFor(ctx),
            })
          ) {
            return;
          }
          // Settle before cancelling so the terminal event precedes any late
          // notification this cancel provokes.
          yield* settleTurn(ctx, turnId, {
            state: "failed",
            errorMessage: `DeepSeek Harness turn stalled without content or tool progress for ${livenessTimeoutFor(ctx)}ms.`,
          });
          yield* Effect.ignore(
            ctx.acp.cancel.pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, ctx.threadId, "session/cancel", error),
              ),
            ),
          );
        }),
      );

    const runTurnLivenessWatchdog = Effect.fn("DshAdapter.runTurnLivenessWatchdog")(
      function* (ctx: DshSessionContext) {
        while (true) {
          if (ctx.stopped) {
            return;
          }
          const turnId = ctx.livenessTurnId;
          if (
            turnId === undefined ||
            ctx.settledTurnIds.has(turnId) ||
            !isLiveTurn(ctx, turnId) ||
            hasLivenessPause(ctx)
          ) {
            yield* Queue.take(ctx.livenessSignals);
            continue;
          }
          const lastActivityAtNanos = ctx.lastTurnActivityAtNanos;
          if (lastActivityAtNanos === undefined) {
            yield* Queue.take(ctx.livenessSignals);
            continue;
          }
          const nowNanos = yield* Clock.monotonicTimeNanos;
          const remainingNanos =
            BigInt(livenessTimeoutFor(ctx)) * NANOS_PER_MILLI - (nowNanos - lastActivityAtNanos);
          if (remainingNanos <= 0n) {
            yield* settleStalledTurn(ctx, turnId);
            continue;
          }
          const wakeReason = yield* Effect.raceFirst(
            Effect.sleep(Duration.nanos(remainingNanos)).pipe(Effect.as("timeout" as const)),
            Queue.take(ctx.livenessSignals).pipe(Effect.as("activity" as const)),
          );
          if (wakeReason === "timeout") {
            yield* settleStalledTurn(ctx, turnId);
          }
        }
      },
      Effect.catch(() => Effect.void),
    );

    const stopSessionInternal = (ctx: DshSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: DshAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = resolveCwd(input.cwd.trim());
          const modelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx!: DshSessionContext;

          const resumeSessionId = parseDshResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const acp = yield* makeDshAcpRuntime({
            dshSettings,
            ...(options?.environment || mcpSession?.agentDeviceEnvironment
              ? {
                  environment: McpProviderSession.withAgentDeviceEnvironment(
                    options?.environment ?? process.env,
                    mcpSession,
                  ),
                }
              : {}),
            childProcessSpawner,
            cwd,
            runtimeMode: input.runtimeMode,
            ...(resumeSessionId ? { resumeSessionId, resumeMethod: "resume" as const } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...(mcpSession
              ? {
                  mcpServers: [
                    {
                      type: "http" as const,
                      name: "t3-code",
                      url: mcpSession.endpoint,
                      headers: [
                        {
                          name: "Authorization",
                          value: mcpSession.authorizationHeader,
                        },
                      ],
                    },
                  ],
                }
              : {}),
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          // No permission handler is registered. DSH never asks this client to
          // approve a tool call, and ACP answers an unhandled request with
          // "method not found", which fails closed rather than allowing silently.
          const started = yield* acp
            .start()
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
              ),
            );

          yield* applyDshAcpModelSelection({
            runtime: acp,
            model: modelSelection?.model,
            reasoningEffort: getModelSelectionStringOptionValue(
              modelSelection,
              DSH_REASONING_EFFORT_OPTION_ID,
            ),
            mapError: (cause, configId) =>
              new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "session/set_config_option",
                issue: `Failed to apply '${configId}': ${cause.message}`,
              }),
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(modelSelection?.model ? { model: modelSelection.model } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: DSH_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            acpSessionId: started.sessionId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            settledTurnIds: new Set(),
            promptsInFlight: 0,
            model: modelSelection?.model,
            stopped: false,
            livenessSignals: yield* Queue.unbounded<DshTurnLivenessSignal>(),
            livenessTurnId: undefined,
            lastTurnActivityAtNanos: undefined,
            activeToolCallIds: new Set(),
            livenessUpdatesInFlight: 0,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "EventStreamBarrier":
                    yield* Deferred.succeed(event.acknowledge, undefined).pipe(Effect.ignore);
                    return;
                  case "ConnectionTerminated":
                    yield* Effect.logWarning("DeepSeek Harness ACP connection terminated.", {
                      threadId: ctx.threadId,
                      detail: event.error.message,
                    });
                    return;
                  case "ModeChanged":
                  case "AvailableCommandsUpdated":
                  case "ConfigOptionsUpdated":
                  case "ThoughtDelta":
                    return;
                  case "AssistantItemStarted":
                    if (ctx.activeTurnId !== undefined) {
                      yield* recordTurnActivity(ctx, ctx.activeTurnId, event);
                    }
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* emitPlanUpdate(
                      ctx,
                      ctx.activeTurnId,
                      yield* makeEventStamp(),
                      event.payload,
                      event.rawPayload,
                      "session/update",
                    );
                    return;
                  case "ToolCallUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    if (ctx.activeTurnId !== undefined) {
                      yield* recordTurnActivity(ctx, ctx.activeTurnId, event);
                    }
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    if (ctx.activeTurnId !== undefined) {
                      yield* recordTurnActivity(ctx, ctx.activeTurnId, event);
                    }
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Failed to process DeepSeek Harness runtime notification.", {
                cause,
              }),
            ),
            // Fork into the session scope: a child of `startSession` is
            // interrupted when that fiber completes, which would drop every
            // later notification.
            Effect.forkIn(sessionScope),
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;
          yield* Effect.forkIn(runTurnLivenessWatchdog(ctx), sessionScope);

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "DeepSeek Harness ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: DshAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);

        // DSH advertises no image prompt capability, so attachments reach the
        // agent through the path line ProviderService puts in the prompt. An
        // empty turn is rejected before any turn state changes.
        const rawPrompt = input.input?.trim() ?? "";
        if (rawPrompt.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text.",
          });
        }

        // A sendTurn while a prompt is in flight is a steer: reuse the active
        // turn id so the merged work settles once.
        const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
        const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
        const isLastPrompt = steeringTurnId === undefined;
        ctx.promptsInFlight += 1;

        const work = Effect.gen(function* () {
          const turnModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          if (turnModelSelection) {
            yield* applyDshAcpModelSelection({
              runtime: ctx.acp,
              model: turnModelSelection.model,
              reasoningEffort: getModelSelectionStringOptionValue(
                turnModelSelection,
                DSH_REASONING_EFFORT_OPTION_ID,
              ),
              mapError: (cause, configId) =>
                new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "session/set_config_option",
                  issue: `Failed to apply '${configId}': ${cause.message}`,
                }),
            });
            ctx.model = turnModelSelection.model;
            ctx.session = { ...ctx.session, model: turnModelSelection.model };
          }

          ctx.activeTurnId = turnId;
          ctx.settledTurnIds.delete(turnId);
          if (isLastPrompt) {
            ctx.lastPlanFingerprint = undefined;
          }
          ctx.session = {
            ...ctx.session,
            activeTurnId: turnId,
            status: "running",
            updatedAt: yield* nowIso,
          };
          yield* beginTurnLiveness(ctx, turnId);

          if (isLastPrompt) {
            yield* offerRuntimeEvent({
              type: "turn.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: { model: ctx.model },
            });
          }

          const promptParts: Array<EffectAcpSchema.ContentBlock> = [
            { type: "text", text: rawPrompt },
            {
              type: "text",
              text: buildRuntimeInstructions({
                harness: "DeepSeek Harness",
                model: ctx.model,
              }),
            },
          ];

          const result = yield* ctx.acp
            .prompt({ prompt: promptParts })
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
              ),
            );

          yield* ctx.acp.drainEvents;
          const turnRecord = ctx.turns.find((turn) => turn.id === turnId);
          if (turnRecord) {
            turnRecord.items.push({ prompt: promptParts, result });
          } else {
            ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
          }

          return result;
        }).pipe(
          Effect.tapError(() => {
            // The turn was claimed but never produced an answer, so release the
            // claim and settle rather than leaving it running.
            ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
            return isLastPrompt
              ? settleTurn(ctx, turnId, {
                  state: "failed",
                  errorMessage: `DeepSeek Harness turn failed: ${PROVIDER} prompt was not delivered.`,
                })
              : Effect.void;
          }),
        );

        const result = yield* work;

        // Only the last remaining prompt settles the turn. A steer-superseded
        // prompt resolving while another is in flight must leave it running, and
        // an interrupt that already settled must not emit a second completion.
        const settlement = nextPromptSettlement({
          promptsInFlight: ctx.promptsInFlight,
          settled: ctx.settledTurnIds.has(turnId),
        });
        ctx.promptsInFlight = settlement.promptsInFlight;
        if (settlement.shouldSettle) {
          yield* settleTurn(ctx, turnId, {
            state: result.stopReason === "cancelled" ? "cancelled" : "completed",
            stopReason: result.stopReason ?? null,
          });
        }

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      }).pipe(
        // A failure before the turn was claimed still has to release the claim.
        Effect.catchTag("ProviderAdapterValidationError", (error) => Effect.fail(error)),
      );

    const interruptTurn: DshAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const targetTurnId = turnId ?? ctx.activeTurnId;
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
          ),
        );
        if (targetTurnId !== undefined && ctx.activeTurnId === targetTurnId) {
          yield* settleTurn(ctx, targetTurnId, { state: "cancelled", stopReason: "cancelled" });
        }
      });

    const respondToRequest: DshAdapterShape["respondToRequest"] = (
      threadId,
      requestId: ApprovalRequestId,
      _decision: ProviderApprovalDecision,
    ) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "session/request_permission",
          issue: `DeepSeek Harness does not request approvals, so '${requestId}' is unknown.`,
        });
      });

    const respondToUserInput: DshAdapterShape["respondToUserInput"] = (
      threadId,
      requestId: ApprovalRequestId,
      _answers: ProviderUserInputAnswers,
    ) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "session/request_user_input",
          issue: `DeepSeek Harness does not request user input, so '${requestId}' is unknown.`,
        });
      });

    const readThread: DshAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: DshAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "thread/rollback",
          issue: "DeepSeek Harness ACP sessions do not support provider-side rollback.",
        });
      });

    const stopSession: DshAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: DshAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: DshAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: DshAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to emit DeepSeek Harness session shutdown event.", { cause }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsConversationRollback: false,
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies DshAdapterShape;
  });
}
