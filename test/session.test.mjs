import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/session.js";

test("session forwards SDK generation seconds and final status, not wall-clock connection time", async () => {
  const events = {},
    reports = [];
  const { run } = setup({
    token: async () => ({ apiKey: "temporary", billId: "bill-one" }),
    connect: async () => ({
      on: (name, handler) => (events[name] = handler),
      disconnect() {},
    }),
    onUsage: (report) => reports.push(report),
  });
  await run.start(stream(), {}, "prompt", 10);
  assert.equal(reports.length, 0);
  events.generationTick({ seconds: 3 });
  events.generationTick({ seconds: 2 });
  run.stop();
  assert.deepEqual(
    reports.map((report) => [report.seconds, report.status]),
    [
      [3, "running"],
      [3, "running"],
      [3, "ended"],
    ],
  );
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const stream = () => {
  const track = {
    readyState: "live",
    stop() {
      this.readyState = "ended";
    },
  };
  return { getTracks: () => [track], clone: () => stream() };
};
const client = () => ({
  disconnected: false,
  on() {},
  disconnect() {
    this.disconnected = true;
  },
});
function setup(options = {}) {
  const calls = { states: [], streams: [] };
  let time = 0,
    tick;
  const run = new Session({
    token: async () => "short-test-token",
    connect: async () => client(),
    onState: (...args) => calls.states.push(args),
    onStream: (value) => calls.streams.push(value),
    onTime() {},
    now: () => time,
    interval: (fn) => {
      tick = fn;
      return 1;
    },
    clear() {
      tick = null;
    },
    ...options,
  });
  return {
    run,
    calls,
    advance(seconds) {
      time = seconds * 1000;
      tick?.();
    },
  };
}

test("duplicate starts do not dial twice; stop preserves original camera", async () => {
  let dials = 0;
  const pending = deferred(),
    camera = stream();
  const { run } = setup({
    connect: async () => {
      dials++;
      return pending.promise;
    },
  });
  const first = run.start(camera, {}, "prompt", 20);
  await run.start(camera, {}, "prompt", 20);
  assert.equal(dials, 1);
  const upload = run.upload;
  run.stop();
  assert.equal(upload.getTracks()[0].readyState, "ended");
  assert.equal(camera.getTracks()[0].readyState, "live");
  const late = client();
  pending.resolve(late);
  await first;
  assert.equal(late.disconnected, true);
  assert.equal(run.active, false);
});

test("stop during token request prevents later dial", async () => {
  const pending = deferred();
  let dials = 0;
  const { run } = setup({
    token: () => pending.promise,
    connect: async () => {
      dials++;
      return client();
    },
  });
  const task = run.start(stream(), {}, "prompt", 20);
  run.stop();
  pending.resolve("late-token");
  await task;
  assert.equal(dials, 0);
});

test("late stream after stop is disposed and never displayed", async () => {
  let callbacks;
  const { run, calls } = setup({
    connect: async (_, options) => {
      callbacks = options;
      return client();
    },
  });
  await run.start(stream(), {}, "prompt", 20);
  run.stop();
  const late = stream();
  callbacks.onRemoteStream(late);
  assert.equal(late.getTracks()[0].readyState, "ended");
  assert.deepEqual(calls.streams, [null]);
});

test("timeout, duration and connection loss clean up and do not auto reconnect", async () => {
  const { run, advance, calls } = setup();
  await run.start(stream(), {}, "prompt", 20);
  advance(15);
  assert.equal(run.active, false);
  assert.match(calls.states.at(-1)[1], /超时/);
  let callback;
  const remote = stream();
  const rt = client();
  const next = setup({
    connect: async (_, options) => {
      callback = options;
      options.onRemoteStream(remote);
      return rt;
    },
  });
  await next.run.start(stream(), {}, "prompt", 10);
  next.advance(10);
  assert.equal(rt.disconnected, true);
  assert.equal(remote.getTracks()[0].readyState, "ended");
  await next.run.start(stream(), {}, "prompt", 30);
  callback.onConnectionChange("reconnecting");
  assert.equal(next.run.active, false);
});

test("provider failure does not display raw supplier errors", async () => {
  const { run, calls } = setup({
    connect: async () => {
      throw new Error("sensitive provider context");
    },
  });
  await run.start(stream(), {}, "prompt", 20);
  assert.equal(run.active, false);
  assert.equal(JSON.stringify(calls.states).includes("sensitive"), false);
});

test("a remote stream with no playable frames still times out after 15 seconds", async () => {
  const { run, advance } = setup({
    connect: async (_, options) => {
      options.onRemoteStream(stream());
      return client();
    },
  });
  await run.start(stream(), {}, "prompt", 30);
  advance(15);
  assert.equal(run.active, false);
});
