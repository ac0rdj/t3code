#!/usr/bin/env node
/**
 * Minimal ACP v1 agent standing in for `dsh --profile acp` in tests.
 *
 * The timing that matters for the adapter's turn lifecycle — a prompt that never
 * answers, a second prompt arriving mid-turn — cannot be driven through the real
 * harness, so the test chooses how a prompt behaves with T3_DSH_PEER_MODE:
 *   answer (default) | hang | content-then-hang
 * A cancelled prompt resolves with stopReason "cancelled".
 */
import * as readline from "node:readline";

const MODE = process.env.T3_DSH_PEER_MODE ?? "answer";
const FLASH = JSON.stringify(["deepseek-official", "deepseek-v4-flash"]);
const PRO = JSON.stringify(["deepseek-official", "deepseek-v4-pro"]);

const configOptions = (model = FLASH, effort = "high") => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: model,
    options: [
      {
        group: "deepseek-official",
        name: "DeepSeek",
        options: [
          { value: FLASH, name: "DeepSeek-V4-Flash" },
          { value: PRO, name: "DeepSeek-V4-Pro" },
        ],
      },
    ],
  },
  {
    id: "reasoning_effort",
    name: "Reasoning effort",
    category: "thought_level",
    type: "select",
    currentValue: effort,
    options: [
      { value: "off", name: "Off" },
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  },
];

let sequence = 1;
let sessionId;
const active = new Map();

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const update = (payload) => {
  if (sessionId) {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: payload } });
  }
};

const resolve = (id, stopReason) => {
  const entry = active.get(id);
  active.delete(id);
  if (entry) active.delete(`s:${entry.sessionId}`);
  send({ jsonrpc: "2.0", id, result: { stopReason } });
};

const handle = ({ id, method, params }) => {
  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "deepseek-harness-acp", version: "0.0.1" },
          agentCapabilities: {
            mcpCapabilities: { http: true },
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
            sessionCapabilities: { close: {}, list: {}, resume: {} },
          },
          authMethods: [],
        },
      });
      return;
    case "authenticate":
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    case "session/new":
    case "session/resume":
      sessionId = params?.sessionId ?? `peer-${sequence++}`;
      send({ jsonrpc: "2.0", id, result: { sessionId, configOptions: configOptions() } });
      return;
    case "session/set_config_option":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          configOptions: configOptions(
            params?.configId === "model" ? params.value : FLASH,
            params?.configId === "reasoning_effort" ? params.value : "high",
          ),
        },
      });
      return;
    case "session/cancel": {
      const target = active.get(`s:${params?.sessionId}`);
      if (target !== undefined) resolve(target, "cancelled");
      if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    case "session/close":
      if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
      return;
    case "session/prompt": {
      const hangs = MODE === "hang" || MODE === "content-then-hang";
      if (hangs) {
        if (MODE === "content-then-hang") {
          update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "partial" },
          });
        }
        active.set(id, { sessionId: params.sessionId });
        active.set(`s:${params.sessionId}`, id);
        return;
      }
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } });
      update({ sessionUpdate: "usage_update", used: 10, size: 1000 });
      resolve(id, "end_turn");
      return;
    }
    default:
      if (id !== undefined) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `no ${method}` } });
      }
  }
};

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch {
    /* ignore malformed frames */
  }
});
