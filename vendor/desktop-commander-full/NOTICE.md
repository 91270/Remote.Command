# Desktop Commander local core

Source package @wonderwhy-er/desktop-commander 0.3.3.
Upstream commit bce370e9395f5bc74eda34913e5ae1dee48df8f8.
MIT license and upstream copyright are preserved in LICENSE.

This directory reuses the published TypeScript output for tools and MCP App
resources. scripts/prepare-dc-core.mjs records reproducible local modifications.
The remote-device runtime, official authentication and npm installation scripts
are excluded. Telemetry, remote feature flags, browser onboarding and promotional
messages use local adapters. Configuration, history and diagnostics are stored
under RCM_CORE_STATE. Chrome and ripgrep resolve only to locally configured
executables. node:local temporary scripts run in the selected workspace.

The original tool schemas use the zod3 dependency alias. The independent
Gateway uses its own zod 4 schemas. The feedback tool records local feedback.
