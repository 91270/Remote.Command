import { dcCapability, type Capability } from './protocol.js';

export type BlockSource =
  | 'none'
  | 'host_safety'
  | 'local_command_policy'
  | 'local_path_policy'
  | 'local_capability';

export type CallReviewInput = {
  tool_name: string;
  arguments: Record<string, unknown>;
  summary: string;
  client_error?: string;
  likely_reason?: string;
};

export type CallReviewPreview = Omit<CallReviewInput, 'likely_reason'> & {
  status: 'awaiting_user';
  after_client_error: boolean;
  device_id: string | null;
  likely_reason: string | null;
  block_source: BlockSource;
  capability: Capability;
  manual_command: string | null;
  guidance: string[];
};

const placeholder = "'__RCM_VERSION__'";

export function renderCallReviewHtml(template: string, version: string): string {
  return template.replaceAll(placeholder, JSON.stringify(version));
}

export function classifyBlockSource(clientError?: string, likelyReason?: string): BlockSource {
  if (!clientError) return 'none';
  const combined = `${clientError}\n${likelyReason ?? ''}`;
  if (/command not allowed|blocked\s*commands?|command.*blocked/i.test(combined)) {
    return 'local_command_policy';
  }
  if (/path not allowed|allowed\s*directories|outside\s*(the\s*)?(agent\s*)?workspace|directory not allowed/i.test(combined)) {
    return 'local_path_policy';
  }
  if (/operation denied by local agent|not paired for this operation|local capability/i.test(combined)) {
    return 'local_capability';
  }
  return 'host_safety';
}

export function extractManualCommand(toolName: string, args: Record<string, unknown>): string | null {
  if (toolName === 'start_process' && typeof args.command === 'string' && args.command.trim()) {
    return args.command.trim();
  }
  if (toolName === 'interact_with_process' && typeof args.input === 'string' && args.input.trim()) {
    return args.input.trim();
  }
  return null;
}

export function guidanceForReview(source: BlockSource, cap: Capability, hasManualCommand: boolean): string[] {
  switch (source) {
    case 'local_command_policy':
      return [
        '此调用由本机 Desktop Commander 的 blockedCommands 策略拦截（并非 OpenAI 安全检查拦截），命令未在设备上运行。',
        '如确认需要执行，请在设备本地查看或调整 ~/.remote-command 下的安全配置，或直接在设备终端手动执行。'
      ];
    case 'local_path_policy':
      return [
        '此调用由本机工作区 / allowedDirectories 目录边界拦截（并非 OpenAI 安全检查拦截），未读写目标路径。',
        '请将路径调整到 Agent 配置的工作区目录内，或按需在设备本地更新 allowedDirectories 后重试。'
      ];
    case 'local_capability':
      return [
        '目标设备的本地 Agent 配置未启用该操作所需的 write / exec 权限。',
        '请检查设备本机 agent.json 中的 capabilities 白名单及配对授权范围。'
      ];
    case 'host_safety': {
      const steps = [
        '该调用在发送到你的设备前已被 ChatGPT / OpenAI 安全检查拦截，本机未执行任何操作。',
        '可向 AI 清晰说明业务目的与上下文，或将复杂指令拆分为更小的单步操作后重试。',
        '切勿在命令参数中直接拼接密码、API Key 或令牌，也不要尝试编码或混淆命令绕过检查。'
      ];
      if (hasManualCommand) {
        steps.push('若该步骤确实必要但持续被拦截，可复制下方终端命令在本机手动运行，再将结果贴回对话继续。');
      }
      return steps;
    }
    case 'none':
      if (cap === 'read') {
        return ['此调用属于只读操作，仅在本地设备工作区允许目录内执行。'];
      }
      return ['此调用涉及写入、配置修改或命令执行，触发后仍需在目标设备终端人工确认方可执行。'];
  }
}

export function buildCallReviewPreview(input: CallReviewInput, deviceId: string | null): CallReviewPreview {
  let cap: Capability = 'exec';
  try {
    cap = dcCapability(input.tool_name, input.arguments);
  } catch {
    cap = 'exec';
  }
  const blockSource = classifyBlockSource(input.client_error, input.likely_reason);
  const manualCommand = extractManualCommand(input.tool_name, input.arguments);
  const guidance = guidanceForReview(blockSource, cap, !!manualCommand);

  return {
    status: 'awaiting_user',
    ...input,
    after_client_error: !!input.client_error,
    device_id: deviceId,
    likely_reason: input.likely_reason ?? null,
    block_source: blockSource,
    capability: cap,
    manual_command: manualCommand,
    guidance
  };
}
