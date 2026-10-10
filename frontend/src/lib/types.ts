export type Role = 'admin' | 'pharmacist' | 'staff';
export type ConsentStatus = 'consented' | 'withdrawn' | 'pending' | 'refused';
export type EnrollmentStatus = 'active' | 'paused' | 'discharged' | 'inactive';
export type MedicationStatus = 'active' | 'paused' | 'discontinued' | 'completed';
export type ReminderStatus = 'scheduled' | 'queued' | 'submitted' | 'sent' | 'delivered' | 'read' | 'failed' | 'responded' | 'cancelled';
export type ResponseType = 'taken' | 'taken_late' | 'missed' | 'remind_later' | 'problem' | 'unknown';
export type CasePriority = 'low' | 'medium' | 'high' | 'urgent';
export type CaseStatus = 'open' | 'in_progress' | 'resolved' | 'closed';

export interface Pharmacy {
  id: string;
  name: string;
  license_number?: string;
  phone?: string;
  address?: string;
  timezone: string;
  quiet_hours_start: string;
  quiet_hours_end: string;
  max_daily_reminders_per_patient: number;
  is_active: boolean;
}

export interface User {
  id: string;
  email: string;
  name: string;
  phone?: string;
  role: Role;
  pharmacy?: string;
  pharmacy_name?: string;
  is_active: boolean;
}

export interface Patient {
  id: string;
  patient_code: string;
  full_name: string;
  phone_number: string;
  preferred_channel: string;
  preferred_language: 'ar' | 'en';
  consent_status: ConsentStatus;
  consent_recorded_at: string;
  enrollment_status: EnrollmentStatus;
  pharmacy: string;
  pharmacy_name?: string;
  responsible_pharmacist?: string;
  responsible_pharmacist_name?: string;
  notes?: string;
  created_at: string;
  updated_at: string;
  active_medications_count?: number;
  open_cases_count?: number;
}

export interface ConsentRecord {
  id: string;
  patient: string;
  consent_type: string;
  status: 'active' | 'withdrawn' | 'expired';
  scope: string;
  recording_method: string;
  recorded_by?: string;
  recorded_by_name?: string;
  recorded_at: string;
  withdrawn_at?: string;
  withdrawal_reason?: string;
  notes?: string;
}

export interface MedicationSchedule {
  id: string;
  medication: string;
  patient: string;
  reminder_time: string;
  reminder_time_formatted?: string;
  days_of_week: string;
  is_active: boolean;
}

export interface MedicationRecord {
  id: string;
  patient: string;
  patient_name?: string;
  patient_phone?: string;
  name: string;
  dose: string;
  unit: string;
  route: string;
  frequency_description: string;
  scheduled_times: string[];
  start_date: string;
  end_date?: string;
  is_chronic: boolean;
  prescription_reference?: string;
  status: MedicationStatus;
  status_change_reason?: string;
  special_instructions?: string;
  created_by?: string;
  created_by_name?: string;
  schedules?: MedicationSchedule[];
  created_at: string;
  updated_at: string;
}

export interface ReminderEvent {
  id: string;
  patient: string;
  patient_name?: string;
  patient_phone?: string;
  medication_schedule?: string;
  medication_name?: string;
  dose_info?: string;
  scheduled_for: string;
  status: ReminderStatus;
  provider_message_id?: string;
  sent_at?: string;
  delivered_at?: string;
  read_at?: string;
  responded_at?: string;
  retry_count: number;
  error_message?: string;
  template_name: string;
  created_at: string;
}

export interface PatientResponse {
  id: string;
  patient: string;
  patient_name?: string;
  patient_phone?: string;
  reminder?: string;
  response_type: ResponseType;
  response_type_display?: string;
  raw_content: string;
  button_id?: string;
  provider_message_id?: string;
  is_linked: boolean;
  review_status: 'processed' | 'flagged_for_review' | 'resolved';
  received_at: string;
}

export interface PharmacistIntervention {
  id: string;
  follow_up_case: string;
  pharmacist?: string;
  pharmacist_name?: string;
  contact_attempted: boolean;
  contact_method: string;
  contact_method_display?: string;
  patient_reported_reason?: string;
  action_taken: string;
  referral_indicated: boolean;
  referral_notes?: string;
  next_follow_up_date?: string;
  outcome_notes?: string;
  created_at: string;
}

export interface FollowUpCase {
  id: string;
  patient: string;
  patient_name?: string;
  patient_phone?: string;
  pharmacy: string;
  trigger_reason: string;
  trigger_reason_display?: string;
  priority: CasePriority;
  status: CaseStatus;
  due_date: string;
  trigger_notes?: string;
  assigned_pharmacist?: string;
  assigned_pharmacist_name?: string;
  closed_at?: string;
  closed_by?: string;
  closed_by_name?: string;
  closure_reason?: string;
  interventions?: PharmacistIntervention[];
  created_at: string;
  updated_at: string;
}

export interface AuditEvent {
  id: string;
  pharmacy?: string;
  pharmacy_name?: string;
  user?: string;
  user_name?: string;
  action: string;
  entity_type: string;
  entity_id?: string;
  metadata: Record<string, any>;
  ip_address?: string;
  created_at: string;
}

export interface DashboardStats {
  total_enrolled_patients: number;
  active_patients: number;
  reminders_scheduled_today: number;
  reminders_delivered_today: number;
  reminders_failed_today: number;
  reminders_responded_today: number;
  delivery_rate_today: number;
  response_rate_today: number;
  patients_reporting_missed: number;
  patients_reporting_problems: number;
  followups_due_today: number;
  overdue_followups: number;
  open_cases: number;
  urgent_cases: number;
  response_breakdown_7d: {
    taken: number;
    taken_late: number;
    missed: number;
    problem: number;
    remind_later: number;
    unknown: number;
  };
  recent_alerts: Array<{
    id: string;
    patient_name: string;
    patient_phone: string;
    trigger_reason: string;
    priority: string;
    status: string;
    due_date: string;
    created_at: string;
  }>;
}
