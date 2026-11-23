// Private Remote MCP: always expose the supported MCP App resources.
export const MCP_UI_EXPERIMENT_NAME = 'McpUiPreviews';
export const MCP_UI_SHOW_VARIANT = 'showMCPUi';
export const MCP_UI_HIDE_VARIANT = 'notShowMCPUi';
export const shouldShowMcpUiPreviews = async () => true;
export const resolveMcpUiPreviewDecision = async () => true;
