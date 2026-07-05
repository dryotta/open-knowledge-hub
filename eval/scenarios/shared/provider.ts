import CopilotProvider from "../../provider/copilotProvider.js";

/**
 * Shared provider injected by every scenario config via
 * `providers: [file://../shared/provider.ts]`.
 *
 * It is the real Copilot-CLI provider preconfigured with the eval defaults
 * (model + timeout) and a stable id, so those live in ONE place instead of
 * being repeated across all 16 scenario files. promptfoo constructs a
 * `file://…ts` provider by importing this default export and calling
 * `new Default(options)`; `options.config` may carry per-run overrides
 * (e.g. a different `model`, or the `runner` the unit tests inject).
 */
type Options = ConstructorParameters<typeof CopilotProvider>[0];

const DEFAULT_CONFIG = { model: "claude-sonnet-4.5", timeoutMs: 300_000 };

export default class SharedCopilotProvider extends CopilotProvider {
  constructor(options: Options = {}) {
    super({ id: "copilot-default", config: { ...DEFAULT_CONFIG, ...(options?.config ?? {}) } });
  }
}
