import {
  User,
  Pharmacy,
  Patient,
  ConsentRecord,
  MedicationRecord,
  ReminderEvent,
  PatientResponse,
  FollowUpCase,
  PharmacistIntervention,
  AuditEvent,
  DashboardStats
} from './types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000/api';

export function getAuthToken(): string | null {
  if (typeof window !== 'undefined') {
    return localStorage.getItem('wesal_jwt_token');
  }
  return null;
}

export function setAuthToken(token: string) {
  if (typeof window !== 'undefined') {
    localStorage.setItem('wesal_jwt_token', token);
  }
}

export function removeAuthToken() {
  if (typeof window !== 'undefined') {
    localStorage.removeItem('wesal_jwt_token');
    localStorage.removeItem('wesal_user_data');
  }
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    let errorData: any = {};
    try {
      errorData = await response.json();
    } catch {
      errorData = { detail: response.statusText };
    }
    const error = new Error(errorData.detail || JSON.stringify(errorData) || 'Request failed');
    (error as any).status = response.status;
    (error as any).data = errorData;
    throw error;
  }

  if (response.status === 204) {
    return {} as T;
  }

  return response.json();
}

export const api = {
  // Auth
  login: (credentials: { email: string; password: string }) =>
    request<{ user: User; token: string }>('/auth/login/', {
      method: 'POST',
      body: JSON.stringify(credentials),
    }),
  getMe: () => request<User>('/auth/me/'),

  // Dashboard Stats
  getDashboardStats: () => request<DashboardStats>('/analytics/dashboard/'),

  // Patients
  getPatients: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request<{ results: Patient[]; count: number }>(`/patients/?${qs}`);
  },
  getPatient: (id: string) => request<Patient>(`/patients/${id}/`),
  createPatient: (data: Partial<Patient> & { consent_method?: string; consent_scope?: string }) =>
    request<Patient>('/patients/', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updatePatient: (id: string, data: Partial<Patient>) =>
    request<Patient>(`/patients/${id}/`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  withdrawConsent: (id: string, reason: string) =>
    request<{ status: string; cancelled_reminders: number; patient: Patient }>(`/patients/${id}/withdraw-consent/`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  renewConsent: (id: string, recording_method = 'verbal_in_person', notes = '') =>
    request<{ status: string; patient: Patient }>(`/patients/${id}/renew-consent/`, {
      method: 'POST',
      body: JSON.stringify({ recording_method, notes }),
    }),
  getPatientTimeline: (id: string) => request<{ timeline: any[] }>(`/patients/${id}/timeline/`),

  // Medications
  getMedications: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request<{ results: MedicationRecord[]; count: number }>(`/medications/?${qs}`);
  },
  createMedication: (data: Partial<MedicationRecord>) =>
    request<MedicationRecord>('/medications/', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateMedication: (id: string, data: Partial<MedicationRecord>) =>
    request<MedicationRecord>(`/medications/${id}/`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  changeMedicationStatus: (id: string, status: string, reason: string) =>
    request<{ status: string; cancelled_reminders: number; medication: MedicationRecord }>(
      `/medications/${id}/change-status/`,
      {
        method: 'POST',
        body: JSON.stringify({ status, reason }),
      }
    ),

  // Reminders
  getReminders: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request<{ results: ReminderEvent[]; count: number }>(`/reminders/?${qs}`);
  },
  triggerReminderCycle: () =>
    request<{ message: string; generated_count: number; dispatch_summary: any }>('/reminders/trigger-cycle/', {
      method: 'POST',
    }),
  sendReminderNow: (id: string) =>
    request<{ status: string; reminder: ReminderEvent }>(`/reminders/${id}/send-now/`, {
      method: 'POST',
    }),

  // Responses
  getResponses: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request<{ results: PatientResponse[]; count: number }>(`/responses/?${qs}`);
  },
  resolveResponse: (id: string) =>
    request<{ status: string; data: PatientResponse }>(`/responses/${id}/resolve/`, {
      method: 'POST',
    }),

  // Follow-up Cases
  getFollowUps: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request<{ results: FollowUpCase[]; count: number }>(`/followups/?${qs}`);
  },
  getFollowUp: (id: string) => request<FollowUpCase>(`/followups/${id}/`),
  createFollowUp: (data: Partial<FollowUpCase>) =>
    request<FollowUpCase>('/followups/', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  addIntervention: (caseId: string, data: Partial<PharmacistIntervention> & { mark_case_resolved?: boolean }) =>
    request<{ status: string; case: FollowUpCase; intervention: PharmacistIntervention }>(
      `/followups/${caseId}/add-intervention/`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    ),
  closeCase: (caseId: string, closure_reason: string) =>
    request<{ status: string; case: FollowUpCase }>(`/followups/${caseId}/close/`, {
      method: 'POST',
      body: JSON.stringify({ closure_reason }),
    }),

  // Messaging & WhatsApp Integration
  getMessagingSettings: () => request<any>('/messaging/settings/'),
  updateMessagingSettings: (data: any) =>
    request<any>('/messaging/settings/', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  sendTestMessage: (data: { phone_number: string; patient_name?: string; template_name?: string; language_code?: string }) =>
    request<any>('/messaging/send-test/', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  simulateInboundWebhook: (data: { phone_number: string; response_type: string; custom_text?: string; reminder_id?: string }) =>
    request<any>('/messaging/simulate-webhook/', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getMessageLogs: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request<{ results: any[]; count: number }>(`/messaging/logs/?${qs}`);
  },

  // Audit Logs
  getAuditLogs: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request<{ results: AuditEvent[]; count: number }>(`/audit-logs/?${qs}`);
  },

  // Export URLs
  getExportPatientsUrl: () => `${API_BASE}/analytics/export-patients/`,
  getExportFollowUpsUrl: () => `${API_BASE}/analytics/export-followups/`,
};
