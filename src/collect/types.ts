// Unified Session Schema（USS）：采集器与加工层之间的统一中间格式。
// 核心只认 USS，适配器负责格式转换——格式漂移只影响单个适配器（规划 7.2 注）。
export interface UnifiedMessage {
  session_id: string;
  agent: string; // 'claude-code' | ...
  ts: string; // ISO 时间戳
  project_fp: string; // 项目指纹（git remote 归一化 hash；评估 4.5）
  role: 'user' | 'assistant';
  content: string; // 纯文本（tool_use/tool_result 块已剔除）
  msg_uuid: string; // 去重指纹组成：hash(agent + sessionId + msg_uuid)
  cwd?: string;
  git_branch?: string;
}

export interface SessionDigest {
  session_id: string;
  agent: string;
  project_fp: string;
  cwd?: string;
  started_ts: string;
  ended_ts: string;
  messages: UnifiedMessage[];
}
