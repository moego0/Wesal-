import logging
from datetime import timedelta
from django.utils import timezone
from .models import FollowUpCase
from patients.models import Patient
from audit.models import AuditEvent

logger = logging.getLogger(__name__)


def evaluate_patient_followup_triggers(patient: Patient, trigger_hint: str = None, response_instance = None):
    """
    Evaluates clinical rules to automatically create or update follow-up cases:
    - Medication problems reported (High/Urgent)
    - Consecutive/frequent missed doses (Medium/High)
    - Repeated messaging delivery failures (Medium)
    """
    now = timezone.now()
    today = now.date()

    # Avoid duplicate open cases for the same reason within 48 hours
    def has_recent_open_case(reason):
        return FollowUpCase.objects.filter(
            patient=patient,
            trigger_reason=reason,
            status__in=['open', 'in_progress'],
            created_at__gte=now - timedelta(days=2)
        ).exists()

    # Rule 1: Medication Problem Reported
    if trigger_hint == 'problem':
        if not has_recent_open_case('medication_problem'):
            raw_text = response_instance.raw_content if response_instance else "Patient reported a problem via WhatsApp"
            case = FollowUpCase.objects.create(
                patient=patient,
                pharmacy=patient.pharmacy,
                trigger_reason='medication_problem',
                priority='urgent',
                status='open',
                due_date=today,
                trigger_notes=f"URGENT: Patient reported medication problem: '{raw_text}'. Pharmacist intervention required.",
                assigned_pharmacist=patient.responsible_pharmacist
            )
            AuditEvent.log(
                pharmacy=patient.pharmacy,
                action='followup.case_created',
                entity_type='follow_up_case',
                entity_id=str(case.id),
                metadata={'reason': 'medication_problem', 'patient_id': str(patient.id), 'priority': 'urgent'}
            )
        return

    # Rule 2: Repeated Missed Doses
    if trigger_hint in ['missed', None]:
        from reminders.models import PatientResponse
        recent_cutoff = now - timedelta(days=7)
        missed_count = PatientResponse.objects.filter(
            patient=patient,
            response_type='missed',
            received_at__gte=recent_cutoff
        ).count()

        if missed_count >= 2 and not has_recent_open_case('consecutive_missed'):
            case = FollowUpCase.objects.create(
                patient=patient,
                pharmacy=patient.pharmacy,
                trigger_reason='consecutive_missed',
                priority='high' if missed_count >= 3 else 'medium',
                status='open',
                due_date=today,
                trigger_notes=f"Non-adherence Alert: Patient has reported {missed_count} missed doses within the last 7 days.",
                assigned_pharmacist=patient.responsible_pharmacist
            )
            AuditEvent.log(
                pharmacy=patient.pharmacy,
                action='followup.case_created',
                entity_type='follow_up_case',
                entity_id=str(case.id),
                metadata={'reason': 'consecutive_missed', 'missed_count': missed_count, 'patient_id': str(patient.id)}
            )

    # Rule 3: Repeated Delivery Failures
    if trigger_hint in ['delivery_failure', None]:
        from reminders.models import ReminderEvent
        recent_failures = ReminderEvent.objects.filter(
            patient=patient,
            status='failed',
            scheduled_for__gte=now - timedelta(days=3)
        ).count()

        if recent_failures >= 3 and not has_recent_open_case('repeated_delivery_failure'):
            case = FollowUpCase.objects.create(
                patient=patient,
                pharmacy=patient.pharmacy,
                trigger_reason='repeated_delivery_failure',
                priority='medium',
                status='open',
                due_date=today,
                trigger_notes=f"Communication Failure: {recent_failures} reminders failed to deliver via WhatsApp. Please verify patient phone number.",
                assigned_pharmacist=patient.responsible_pharmacist
            )
            AuditEvent.log(
                pharmacy=patient.pharmacy,
                action='followup.case_created',
                entity_type='follow_up_case',
                entity_id=str(case.id),
                metadata={'reason': 'repeated_delivery_failure', 'failures': recent_failures, 'patient_id': str(patient.id)}
            )
