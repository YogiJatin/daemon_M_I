export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskStatus = 'open' | 'completed' | 'dismissed';

export interface Task {
  id: string;
  title: string;
  description?: string | null;
  category?: string | null;
  priority: Priority;
  status: TaskStatus;
  deadline_kind?: 'none' | 'date_only' | 'date_time' | null;
  deadline_local_date?: string | null;
  deadline_time_local?: string | null;
  deadline_at_utc?: string | null;
  deadline_version: number;
  created_at: string;
  updated_at: string;
}

export interface ClassOccurrence {
  id: string;
  subject_id: string;
  slot_id: string;
  occurrence_date: string;
  start_time: string;
  end_time: string;
  room?: string | null;
  faculty?: string | null;
  status: 'planned' | 'completed' | 'attended' | 'cancelled' | 'missed';
  subject_name: string;
  subject_code?: string | null;
  color?: string;
  materials?: Array<{
    materialType: string;
    title: string;
    notes?: string | null;
    required: boolean;
  }>;
}

export interface AttentionBudget {
  sent_today: number;
  reserved_today: number;
  daily_cap: number;
  remaining: number;
}

export interface FocusData {
  current_focus: { type: 'task' | 'class'; data: any } | null;
  next_task: Task | null;
  next_class: ClassOccurrence | null;
  ongoing_class: ClassOccurrence | null;
  next_notification: any | null;
  highest_priority_tasks: Task[];
  countdowns: {
    minutes_to_next_class: number | null;
  };
  attention_budget: AttentionBudget;
  system_status: string;
}

export interface TodayData {
  date: string;
  semester: string | null;
  overdue_tasks: Task[];
  today_tasks: Task[];
  classes_today: ClassOccurrence[];
}

export interface WeekSchedule {
  week_start: string;
  week_end: string;
  semester: string | null;
  days: Array<{
    date: string;
    weekday: number;
    classes: ClassOccurrence[];
  }>;
}

export interface SystemStatus {
  overall_status: 'healthy' | 'degraded' | 'paused' | 'offline';
  reminders_paused: boolean;
  scheduler: {
    status: 'running' | 'paused' | 'error';
    last_tick_at: string | null;
    consecutive_failures: number;
  };
  ai: {
    status: string;
    active_tier: string;
    capabilities_loaded: number;
  };
  audit: {
    status: string;
    latest_sequence: number;
    verified: boolean;
  };
  database: {
    status: string;
    engine: string;
  };
  telegram: {
    configured: boolean;
    sent_today: number;
    daily_cap: number;
    remaining: number;
  };
  provider: {
    active: string;
    status: string;
    fallback_ready: boolean;
  };
  desktop: {
    status: string;
    ready: boolean;
    disarmed: boolean;
  };
}

export interface AuditEventItem {
  id: string;
  sequence?: number;
  event_type: string;
  entity_type: string;
  entity_id: string;
  actor: string;
  payload_hash?: string;
  record_hash?: string;
  created_at: string;
  summary?: string;
  details_json?: string;
}

export type OSMode =
  | 'focus'     // / (Today / Briefing)
  | 'memory'    // /tasks (Tasks List & Detail)
  | 'academy'   // /timetable (Classes & Grid)
  | 'timeline'  // /history (Audit Events)
  | 'system'    // /health (Subsystems & QoS)
  | 'settings'  // /settings (Preferences)
  | 'pairing'   // /pair (Device Link)
  | 'panel';    // /panel (Compact Floating Bar)

export type SystemPresence =
  | 'healthy'
  | 'offline'
  | 'ai_busy'
  | 'syncing'
  | 'notifications_pending'
  | 'scheduler_running'
  | 'waiting_approval'
  | 'degraded'
  | 'provider_fallback'
  | 'audit_warning'
  | 'verification_failed'
  | 'privacy_restricted'
  | 'execution_running'
  | 'execution_complete';

export type StatusGlyphType =
  | 'loading'
  | 'empty'
  | 'offline'
  | 'error'
  | 'paused'
  | 'uncertain-send'
  | 'degraded'
  | 'processing'
  | 'requires_approval'
  | 'verification_failed'
  | 'provider_fallback'
  | 'privacy_restricted'
  | 'execution_pending'
  | 'execution_running'
  | 'execution_complete'
  | 'audit_verified'
  | 'audit_warning'
  | 'healthy'
  | 'done'
  | 'open';
