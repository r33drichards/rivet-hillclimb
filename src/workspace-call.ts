/** Actor-local only: never release exclusivity until the original operation unwinds. */
export interface ActiveWorkspaceCall {
  requestId?: string;
  name: string;
  startedAt: number;
  promise: Promise<unknown>;
}
export interface WorkspaceCallState {
  busy: boolean;
  controller?: AbortController;
  active?: ActiveWorkspaceCall;
}
export function exclusiveWorkspaceCall<T>(state: WorkspaceCallState, requestId: string | undefined, name: string, signal: AbortSignal,
  execute: (signal: AbortSignal) => Promise<T>, busyError: () => Error): Promise<T> {
  if (state.active && requestId && state.active.requestId === requestId) return state.active.promise as Promise<T>;
  if (state.busy) return Promise.reject(busyError());
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  state.busy = true;
  state.controller = controller;
  const active: ActiveWorkspaceCall = { requestId: requestId || undefined, name, startedAt: Date.now(), promise: undefined! };
  state.active = active;
  active.promise = Promise.resolve().then(() => {
    controller.signal.throwIfAborted();
    return execute(controller.signal);
  }).finally(() => {
    signal.removeEventListener("abort", abort);
    if (state.active === active) {
      state.busy = false;
      state.controller = undefined;
      state.active = undefined;
    }
  });
  return active.promise as Promise<T>;
}
