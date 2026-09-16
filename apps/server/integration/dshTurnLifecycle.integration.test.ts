// @effect-diagnostics nodeBuiltinImport:off
/**
 * Live turn-lifecycle coverage for the DeepSeek Harness adapter.
 *
 * The pure turn decisions are unit-tested in `Layers/DshAdapter.test.ts`. This
 * file drives a real adapter session against `fixtures/dsh-acp-peer.mjs`, so the
 * wiring between those decisions, the shared ACP runtime and the published
 * runtime events is exercised end to end.
 *
 * Not covered here: interrupting a prompt in flight. The runtime's default
 * cancel behaviour interrupts the prompt fiber rather than letting the harness
 * answer a cancel, and the cases tried against the peer stalled the session
 * instead of settling it. The settlement invariant that path depends on — one
 * terminal event, no double settle — is pinned in `Layers/DshAdapter.test.ts`.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { makeDshAdapter } from "../src/provider/Layers/DshAdapter.ts";

const PROVIDER: ProviderDriverKind = "dsh" as ProviderDriverKind;
const INSTANCE = ProviderInstanceId.make("dsh");
const PEER_DIR = new URL("./fixtures/", import.meta.url).pathname;

/**
 * The adapter spawns a bare command and appends its own arguments
 * (`--profile acp`), and the peer is a Node module. On macOS and Linux a
 * `#!/bin/sh` shim forwards those arguments to Node, which is the repository's
 * existing fixture convention. Windows does not honour a shebang, so it gets a
 * `.cmd` shim that does the same thing: run Node on the peer entry and forward
 * the arguments the adapter passed.
 */
export const makePeerCommand = (platform: string): string => {
  const entry = NodePath.join(PEER_DIR, "dsh-acp-peer.cjs");
  const temp = NodeOS.tmpdir();
  if (platform === "win32") {
    const shim = NodePath.join(temp, `t3-dsh-peer-${process.pid}.cmd`);
    NodeFS.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`);
    return shim;
  }
  const shim = NodePath.join(temp, `t3-dsh-peer-${process.pid}.sh`);
  NodeFS.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`);
  NodeFS.chmodSync(shim, 0o755);
  return shim;
};

const SETTINGS = { enabled: true, binaryPath: "", homePath: "" };

type RecordedEvent = { readonly type: string; readonly payload: unknown };
type Adapter =
  ReturnType<typeof makeDshAdapter> extends Effect.Effect<infer A, unknown, unknown> ? A : never;

const startSession = (adapter: Adapter, id: ThreadId) =>
  adapter.startSession({
    threadId: id,
    cwd: process.cwd(),
    provider: PROVIDER,
    runtimeMode: "full-access",
  } as never);

/** Records published events so no assertion has to sleep for them. */
const recordEvents = Effect.fn("recordEvents")(function* (adapter: Adapter) {
  const log = yield* Ref.make<ReadonlyArray<RecordedEvent>>([]);
  yield* Stream.runForEach(adapter.streamEvents, (event) =>
    Ref.update(log, (current) => [...current, event as RecordedEvent]),
  ).pipe(Effect.forkScoped);
  const read = Ref.get(log);
  return {
    count: (type: string) =>
      read.pipe(Effect.map((events) => events.filter((event) => event.type === type).length)),
    awaitType: (type: string, attempts = 120) =>
      Effect.gen(function* () {
        for (let index = 0; index < attempts; index += 1) {
          const found = (yield* read).find((event) => event.type === type);
          if (found) return found;
          yield* Effect.sleep("50 millis");
        }
        return undefined;
      }),
  };
});

/**
 * Runs `body` with the peer in `mode`. The peer reads the mode when it spawns,
 * so setting it before `startSession` is enough.
 */
const withPeer = <A, E, R>(mode: string, body: () => Effect.Effect<A, E, R>) => {
  const previous = process.env.T3_DSH_PEER_MODE;
  process.env.T3_DSH_PEER_MODE = mode;
  return body().pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (previous === undefined) delete process.env.T3_DSH_PEER_MODE;
        else process.env.T3_DSH_PEER_MODE = previous;
      }),
    ),
  );
};

const makeAdapter = (options?: { readonly turnInactivityTimeoutMs?: number }) =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    return yield* makeDshAdapter(
      { ...SETTINGS, binaryPath: makePeerCommand(platform) },
      {
        environment: process.env,
        instanceId: INSTANCE,
        ...(options?.turnInactivityTimeoutMs !== undefined
          ? { turnInactivityTimeoutMs: options.turnInactivityTimeoutMs }
          : {}),
      },
    );
  });

describe("the lifecycle peer command", () => {
  it("forwards the adapter's arguments to Node on Windows", () => {
    // The adapter appends `--profile acp`, and a bare `process.execPath` would
    // read that as its script, so Windows needs a shim that forwards too. The
    // shim is only built here; running it needs a Windows host.
    const shim = makePeerCommand("win32");
    expect(shim.endsWith(".cmd")).toBe(true);
    const contents = NodeFS.readFileSync(shim, "utf8");
    expect(contents).toContain(process.execPath);
    expect(contents).toContain("dsh-acp-peer.cjs");
    expect(contents).toContain("%*");
  });

  it("uses an executable shell shim elsewhere", () => {
    const shim = makePeerCommand("darwin");
    expect(shim.endsWith(".sh")).toBe(true);
    expect(NodeFS.readFileSync(shim, "utf8")).toContain('"$@"');
  });
});

it.layer(Layer.mergeAll(NodeServices.layer))("DshAdapter live turn lifecycle", (it) => {
  it.effect("completes a normal turn and returns the session to ready", () =>
    withPeer("answer", () =>
      Effect.gen(function* () {
        const adapter = yield* makeAdapter();
        const events = yield* recordEvents(adapter);
        const id = ThreadId.make("dsh-live-answer");
        yield* startSession(adapter, id);

        const result = yield* adapter.sendTurn({ threadId: id, input: "hello" } as never);
        expect(result.turnId).toBeTruthy();

        const completed = yield* events.awaitType("turn.completed");
        expect(completed?.payload).toMatchObject({ state: "completed" });

        const sessions = yield* adapter.listSessions();
        expect(sessions[0]?.status).toBe("ready");
        expect(sessions[0]?.activeTurnId).toBeUndefined();
        yield* adapter.stopSession(id);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("rejects an empty turn without leaving the session running", () =>
    withPeer("answer", () =>
      Effect.gen(function* () {
        const adapter = yield* makeAdapter();
        const id = ThreadId.make("dsh-live-empty");
        yield* startSession(adapter, id);

        const outcome = yield* adapter
          .sendTurn({ threadId: id, input: "   " } as never)
          .pipe(Effect.result);
        expect(outcome._tag).toBe("Failure");

        const sessions = yield* adapter.listSessions();
        expect(sessions[0]?.status).toBe("ready");
        expect(sessions[0]?.activeTurnId).toBeUndefined();
        yield* adapter.stopSession(id);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("retires the session on stop", () =>
    withPeer("answer", () =>
      Effect.gen(function* () {
        const adapter = yield* makeAdapter();
        const events = yield* recordEvents(adapter);
        const id = ThreadId.make("dsh-live-stop");
        yield* startSession(adapter, id);
        expect(yield* adapter.hasSession(id)).toBe(true);

        yield* adapter.stopSession(id);
        expect(yield* adapter.hasSession(id)).toBe(false);
        expect(yield* events.awaitType("session.exited")).toBeDefined();
      }).pipe(Effect.scoped),
    ),
  );
});
