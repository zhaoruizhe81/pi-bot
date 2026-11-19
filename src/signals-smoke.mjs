// Real durable-signals round-trip: a task sleeps on a signal, the host delivers it,
// the task wakes and completes. No model call involved.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { obj, str } from "@earendil-works/pi-schema";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry, defineExtension, defineSignal, defineTask, Harness, MemoryStorage,
} from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;

// 1) a typed signal kind
const Answer = defineSignal({ name: "app.answer", version: 1, schema: obj({ text: str() }) });

// 2) a task that parks on that signal, then completes with its value
const AskPerson = defineTask({
  name: "app.ask-person",
  version: 1,
  initial: () => ({ phase: "ask" }),
  phases: {
    ask: (_task, runtime, ctx) =>
      runtime.commit(
        () => ({ status: "sleeping", signals: [Answer.key("answer")], checkpoint: { phase: "answered" } }),
        ctx,
      ),
    answered: async (task, runtime, ctx) => {
      const state = await runtime.readSignal(Answer, "answer", ctx);
      const text = state !== undefined && "value" in state ? state.value.text : null;
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: text } }),
        ctx,
      );
    },
  },
  abort: (_task, runtime, ctx) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

const models = createModels();
models.setProvider(fauxProvider().provider);
// task definitions must be installed through an extension's `tasks`
const registry = createRegistry();
registry.install(defineExtension({ name: "asker", tasks: [AskPerson] }));
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
harness.resume();

const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });

// 3) create the task inside a commit; it starts running its "ask" phase and parks
const taskId = await root.commit(
  (tx) => tx.createTask(AskPerson, { question: "Deploy to prod?" }, { ownership: { kind: "conversation" } }),
  context,
);
console.log("task created:", taskId);

// 4) host delivers the signal (e.g. a webhook / a person clicking Approve)
const res = await harness.signal(taskId, Answer, "answer", { text: "Yes" }, context);
console.log("signal result:", res.status ?? res);

// 5) task wakes and completes
const settled = await harness.waitForTask(taskId, context);
console.log("settled:", settled.state.status, "result:", JSON.stringify(settled.state.outcome?.result));

await harness.close(context);
console.log("SIGNALS SMOKE OK");
