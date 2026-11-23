// Private Remote MCP adapter: telemetry is disabled and no endpoint is contacted.
export const capture = async () => {};
export const captureBase = capture;
export const capture_call_tool = capture;
export const capture_ui_event = capture;
export const captureRemote = capture;
export const captureTransport = capture;
export const buildEventProperties = async properties => properties ?? {};
export const sanitizeError = value => value;
export const isTelemetryDisabledByEnv = () => true;
export const runInUiOriginCallContext = fn => fn();
export const runWithToolCallPaths = fn => fn();
export const isInsideUiOriginCall = () => false;
export const addToolCallPaths = () => {};
