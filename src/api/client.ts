import type {
  FocusData,
  TodayData,
  Task,
  WeekSchedule,
  SystemStatus,
  AuditEventItem,
} from './types';

// In-memory token storage (NEVER in localStorage, per AGENTS.md / Block 4 security contract)
let inMemorySessionToken: string | null = null;

export function setSessionToken(token: string | null) {
  inMemorySessionToken = token;
}

export function getSessionToken(): string | null {
  return inMemorySessionToken;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');

  if (inMemorySessionToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${inMemorySessionToken}`);
  }

  if (options.body && typeof options.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(path, {
    ...options,
    headers,
    credentials: 'include', // Send HttpOnly cookie
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok || json.ok === false) {
    const errorMsg = json.error?.message || `Request failed with status ${res.status}`;
    const err = new Error(errorMsg) as any;
    err.code = json.error?.code || 'request_failed';
    err.status = res.status;
    err.details = json.error;
    throw err;
  }

  return json.data as T;
}

export const api = {
  // Auth
  async pair(code: string): Promise<{ authenticated: boolean; token: string; expires_at: string }> {
    const data = await request<{ authenticated: boolean; token: string; expires_at: string }>(
      '/api/v1/auth/pair',
      {
        method: 'POST',
        body: JSON.stringify({ code: code.trim() }),
      }
    );
    if (data.token) {
      setSessionToken(data.token);
    }
    return data;
  },

  async getMe(): Promise<{ owner_user_id: string; expires_at: string; created_at: string }> {
    return request('/api/v1/auth/me');
  },

  async logout(): Promise<{ logged_out: boolean }> {
    const res = await request<{ logged_out: boolean }>('/api/v1/auth/logout', { method: 'POST' });
    setSessionToken(null);
    return res;
  },

  // Focus & Read Models
  async getFocus(): Promise<FocusData> {
    return request<FocusData>('/api/v1/focus');
  },

  async getToday(): Promise<TodayData> {
    return request<TodayData>('/api/v1/today');
  },

  async getUpcoming(): Promise<{ tasks: Task[]; schedule_preview: any[] }> {
    return request('/api/v1/upcoming');
  },

  // Tasks
  async getTasks(params: { status?: string; priority?: string; page?: number; limit?: number } = {}): Promise<{
    tasks: Task[];
    pagination: { page: number; total: number; has_more: boolean };
  }> {
    const sp = new URLSearchParams();
    if (params.status) sp.set('status', params.status);
    if (params.priority) sp.set('priority', params.priority);
    if (params.page) sp.set('page', String(params.page));
    if (params.limit) sp.set('limit', String(params.limit || 50));
    
    const res = await fetch(`/api/v1/tasks?${sp.toString()}`, {
      headers: inMemorySessionToken ? { Authorization: `Bearer ${inMemorySessionToken}`, Accept: 'application/json' } : { Accept: 'application/json' },
      credentials: 'include',
    });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error?.message || 'Failed to fetch tasks');
    return {
      tasks: json.data || [],
      pagination: json.pagination || { page: 1, total: json.data?.length || 0, has_more: false },
    };
  },

  async getTask(id: string): Promise<Task> {
    return request<Task>(`/api/v1/tasks/${encodeURIComponent(id)}`);
  },

  async createTask(data: { title: string; priority?: string; deadline?: string; category?: string; description?: string }): Promise<Task> {
    return request<Task>('/api/v1/tasks', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateTask(id: string, data: Partial<Task> & { deadline?: string }): Promise<Task> {
    return request<Task>(`/api/v1/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  async completeTask(id: string): Promise<{ completed: boolean; task: Task }> {
    return request(`/api/v1/tasks/${encodeURIComponent(id)}/complete`, {
      method: 'POST',
    });
  },

  async snoozeTask(id: string, minutes: number): Promise<{ snoozed: boolean; task: Task }> {
    return request(`/api/v1/tasks/${encodeURIComponent(id)}/snooze`, {
      method: 'POST',
      body: JSON.stringify({ minutes }),
    });
  },

  async dismissTask(id: string): Promise<{ dismissed: boolean; task: Task }> {
    return request(`/api/v1/tasks/${encodeURIComponent(id)}/dismiss`, {
      method: 'POST',
    });
  },

  async getTaskWhy(id: string): Promise<{ task: Task; audit_trail: any[]; notifications: any[] }> {
    return request(`/api/v1/tasks/${encodeURIComponent(id)}/why`);
  },

  // Timetable
  async getTimetableWeek(date?: string): Promise<WeekSchedule> {
    const sp = date ? `?date=${encodeURIComponent(date)}` : '';
    return request<WeekSchedule>(`/api/v1/timetable/week${sp}`);
  },

  async updateOccurrenceStatus(id: string, status: string): Promise<any> {
    return request(`/api/v1/timetable/occurrences/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  },

  // History & Audit
  async getHistory(params: { entity_type?: string; limit?: number } = {}): Promise<AuditEventItem[]> {
    const sp = new URLSearchParams();
    if (params.entity_type) sp.set('entity_type', params.entity_type);
    if (params.limit) sp.set('limit', String(params.limit || 50));
    const res = await fetch(`/api/v1/history?${sp.toString()}`, {
      headers: inMemorySessionToken ? { Authorization: `Bearer ${inMemorySessionToken}`, Accept: 'application/json' } : { Accept: 'application/json' },
      credentials: 'include',
    });
    const json = await res.json();
    return json.data || [];
  },

  // System Status
  async getSystemStatus(): Promise<SystemStatus> {
    return request<SystemStatus>('/api/v1/system/status');
  },

  // Settings
  async pauseReminders(): Promise<{ paused: boolean }> {
    return request('/api/v1/settings/pause', { method: 'POST' });
  },

  async resumeReminders(): Promise<{ resumed: boolean }> {
    return request('/api/v1/settings/resume', { method: 'POST' });
  },

  // Global Search
  async search(query: string): Promise<{ tasks: any[]; subjects: any[]; recurrence_rules: any[] }> {
    return request(`/api/v1/search?q=${encodeURIComponent(query)}`);
  },

  // Multimodal Ingress & Proposals (Block 7)
  async submitTextInput(text: string, metadata?: any): Promise<any> {
    return request('/api/v1/input/text', {
      method: 'POST',
      body: JSON.stringify({ text, metadata }),
    });
  },

  async submitAudioInput(audioBase64: string, filename?: string, mimeType?: string): Promise<any> {
    return request('/api/v1/input/audio', {
      method: 'POST',
      body: JSON.stringify({ audio_base64: audioBase64, filename, mime_type: mimeType }),
    });
  },

  async submitImageInput(imageBase64: string, filename?: string, mimeType?: string): Promise<any> {
    return request('/api/v1/input/image', {
      method: 'POST',
      body: JSON.stringify({ image_base64: imageBase64, filename, mime_type: mimeType }),
    });
  },

  async submitDocumentInput(documentBase64: string, filename?: string, mimeType?: string): Promise<any> {
    return request('/api/v1/input/document', {
      method: 'POST',
      body: JSON.stringify({ document_base64: documentBase64, filename, mime_type: mimeType }),
    });
  },

  async getInputSession(id: string): Promise<any> {
    return request(`/api/v1/input/${encodeURIComponent(id)}`);
  },

  async getProposals(status: string = 'pending'): Promise<{ proposals: any[]; total: number }> {
    return request(`/api/v1/proposals?status=${encodeURIComponent(status)}`);
  },

  async confirmProposal(id: string, overrides?: any): Promise<any> {
    return request(`/api/v1/proposals/${encodeURIComponent(id)}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ overrides }),
    });
  },

  async rejectProposal(id: string, reason?: string): Promise<any> {
    return request(`/api/v1/proposals/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },

  // Memory OS (Block 8)
  async getMemory(params: { type?: string; source?: string; tag?: string; limit?: number; offset?: number } = {}): Promise<{ objects: any[]; total: number }> {
    const sp = new URLSearchParams();
    if (params.type) sp.set('type', params.type);
    if (params.source) sp.set('source', params.source);
    if (params.tag) sp.set('tag', params.tag);
    if (params.limit) sp.set('limit', String(params.limit));
    if (params.offset) sp.set('offset', String(params.offset));
    return request(`/api/v1/memory?${sp.toString()}`);
  },

  async getMemoryById(id: string): Promise<{ object: any; tags: string[]; relationships_count: number }> {
    return request(`/api/v1/memory/${encodeURIComponent(id)}`);
  },

  async searchMemory(params: { q?: string; tag?: string; type?: string; from?: string; to?: string; limit?: number } = {}): Promise<{ results: any[]; count: number }> {
    const sp = new URLSearchParams();
    if (params.q) sp.set('q', params.q);
    if (params.tag) sp.set('tag', params.tag);
    if (params.type) sp.set('type', params.type);
    if (params.from) sp.set('from', params.from);
    if (params.to) sp.set('to', params.to);
    if (params.limit) sp.set('limit', String(params.limit));
    return request(`/api/v1/memory/search?${sp.toString()}`);
  },

  async getMemoryRelationships(id: string, direction: 'outgoing' | 'incoming' | 'both' = 'both'): Promise<{ relationships: any[]; count: number }> {
    return request(`/api/v1/memory/${encodeURIComponent(id)}/relationships?direction=${encodeURIComponent(direction)}`);
  },

  async getMemoryTimeline(id: string): Promise<{ timeline: any[]; count: number }> {
    return request(`/api/v1/memory/${encodeURIComponent(id)}/timeline`);
  },

  async getMemoryGraph(id: string, depth: number = 2): Promise<{ graph: any }> {
    return request(`/api/v1/memory/${encodeURIComponent(id)}/graph?depth=${depth}`);
  },

  async summarizeMemory(id: string, force: boolean = false): Promise<{ summary: string; wasCached: boolean }> {
    return request(`/api/v1/memory/${encodeURIComponent(id)}/summarize`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    });
  },

  async linkMemory(fromObject: string, toObject: string, relationshipType: string, confidence: number = 1.0): Promise<any> {
    return request('/api/v1/memory/link', {
      method: 'POST',
      body: JSON.stringify({ from_object: fromObject, to_object: toObject, relationship_type: relationshipType, confidence }),
    });
  },

  // Desktop Intelligence & Teach Mode (Block 9)
  async startTeachSession(title: string, appContext?: string): Promise<{ session: any }> {
    return request('/api/v1/teach/start', {
      method: 'POST',
      body: JSON.stringify({ title, appContext }),
    });
  },

  async recordTeachStep(sessionId: string, actionType: string, intentSummary: string, targetSelector?: string, rawInput?: string): Promise<{ step: any }> {
    return request('/api/v1/teach/step', {
      method: 'POST',
      body: JSON.stringify({ sessionId, actionType, intentSummary, targetSelector, rawInput }),
    });
  },

  async compileTeachSession(sessionId: string, title?: string, intent?: string, triggerType: string = 'manual'): Promise<{ recipe: any }> {
    return request('/api/v1/teach/compile', {
      method: 'POST',
      body: JSON.stringify({ sessionId, title, intent, triggerType }),
    });
  },

  async approveTeachRecipe(recipeId: string): Promise<{ recipe: any; approved: boolean }> {
    return request(`/api/v1/teach/${encodeURIComponent(recipeId)}/approve`, {
      method: 'POST',
    });
  },

  async rejectTeachRecipe(recipeId: string, reason?: string): Promise<{ rejected: boolean }> {
    return request(`/api/v1/teach/${encodeURIComponent(recipeId)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },

  async getTeachRecipes(status?: string): Promise<{ recipes: any[]; count: number }> {
    const sp = status ? `?status=${encodeURIComponent(status)}` : '';
    return request(`/api/v1/teach/recipes${sp}`);
  },

  async openSafeBrowser(url: string): Promise<{ launchPlan: any; allowed: boolean }> {
    return request('/api/v1/browser/open', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
  },

  async observeBrowserUrl(url: string): Promise<{ evaluation: any }> {
    return request('/api/v1/browser/observe', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
  },

  async getBrowserPolicies(): Promise<{ policies: any[]; count: number }> {
    return request('/api/v1/browser/policies');
  },

  async captureCamera(mode: string = 'still', permission: boolean = true, title?: string): Promise<{ capture: any }> {
    return request('/api/v1/camera/capture', {
      method: 'POST',
      body: JSON.stringify({ mode, permission, title }),
    });
  },

  async createExecutionPlan(intent: string, steps: any[]): Promise<{ plan: any }> {
    return request('/api/v1/execution/plan', {
      method: 'POST',
      body: JSON.stringify({ intent, steps }),
    });
  },

  async approveExecutionPlan(planId: string, approvalHash: string): Promise<{ plan: any; approved: boolean }> {
    return request(`/api/v1/execution/${encodeURIComponent(planId)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ approvalHash }),
    });
  },

  async executeExecutionPlan(planId: string): Promise<{ execution: any }> {
    return request(`/api/v1/execution/${encodeURIComponent(planId)}/execute`, {
      method: 'POST',
    });
  },

  async getExecutionPlan(planId: string): Promise<{ plan: any }> {
    return request(`/api/v1/execution/${encodeURIComponent(planId)}`);
  },

  async exportObsidianWorkflows(vaultName?: string): Promise<any> {
    return request('/api/v1/obsidian/export', {
      method: 'POST',
      body: JSON.stringify({ vaultName }),
    });
  },

  async getObsidianWorkflows(): Promise<{ workflows: any[]; count: number; canonicalNotice: string }> {
    return request('/api/v1/obsidian/workflows');
  },
};
