// Shapes from DESIGN.md section 2. These are the contract between the UI and
// the two backends; nothing here is inferred from a live response.

export type ProjectStatus = 'active' | 'dormant' | 'dead';
export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'abandoned';
export type AgentStatus = 'working' | 'idle' | 'blocked' | 'done' | 'unknown';

export interface TaskCounts {
  queued: number;
  running: number;
  done: number;
  failed: number;
  abandoned: number;
}

export interface Task {
  id: number;
  project_id: number;
  title: string;
  status: TaskStatus;
  session_ref: string;
  result_summary: string;
  created_at: string;
  updated_at: string;
}

export interface SummaryProject {
  id: number;
  name: string;
  description?: string;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
  /**
   * When anything last happened on this project: the project row, any of its
   * tasks, or any event on those tasks. projtrack computes it and turns a
   * project dormant once it is older than `dormant_after_hours`.
   *
   * Optional because a projtrack from before automatic dormancy does not send
   * it, and the app still has to render against one.
   */
  last_activity?: string;
  running_tasks: Task[];
  open_tasks: Task[];
  task_counts: TaskCounts;
}

export interface Summary {
  generated_at: string;
  status: string;
  /** How long a project may go untouched before projtrack marks it dormant. */
  dormant_after_hours?: number;
  projects_shown: number;
  running_tasks: number;
  queued_tasks: number;
  projects: SummaryProject[];
}

export interface ProjectDetail {
  id: number;
  name: string;
  description: string;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
  /** See SummaryProject.last_activity. */
  last_activity?: string;
  tasks: Task[];
}

export interface TaskEvent {
  id: number;
  task_id: number;
  note: string;
  created_at: string;
}

export interface TaskDetail extends Task {
  events: TaskEvent[];
}

export interface Pane {
  /** `w95:p1` on this laptop, `box/w1:p1` on another machine. */
  pane_id: string;
  /** Which machine the pane is on. 'local' is this laptop. */
  machine: string;
  workspace_id: string;
  label: string;
  cwd: string;
  agent_status: AgentStatus;
  /**
   * Which agent holds the pane: 'claude', 'codex', or 'unknown'.
   *
   * Optional because a bridge older than this field simply omits it, and the
   * transcript parser copes with either TUI without being told which it has.
   */
  provider?: string;
}

export interface Machine {
  name: string;
  reachable: boolean;
}

export interface PaneRead {
  pane_id: string;
  machine?: string;
  agent_status: AgentStatus;
  read_at: string;
  text: string;
}

export type ChatRole = 'user' | 'orchestrator' | 'event' | 'system';
export type ChatKind = 'text' | 'finished' | 'stalled' | 'ended' | 'error' | 'status';

export interface ChatMessage {
  id: number;
  role: ChatRole;
  kind: ChatKind;
  text: string;
  pane_id: string | null;
  ts: string;
}

export interface ChatState {
  busy: boolean;
  muted: boolean;
  agents: { pane_id: string; label: string; agent_status: AgentStatus; cwd: string }[];
}
