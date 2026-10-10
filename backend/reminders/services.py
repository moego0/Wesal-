import logging
from datetime import datetime, time, timedelta
from django.utils import timezone
import zoneinfo
from django.db import transaction
from .models import ReminderEvent
from patients.models import Patient
from medications.models import MedicationSchedule, MedicationRecord
from messaging.whatsapp_client import WhatsAppCloudApiClient
from audit.models import AuditEvent

logger = logging.getLogger(__name__)


def generate_daily_reminders(target_date=None) -> int:
    """
    Generates ReminderEvent records for active medication schedules for the specified target date.
    Ensures idempotency (no duplicate reminders).
    """
    if target_date is None:
        target_date = timezone.localdate()

    created_count = 0
    # Day of week in Python: Monday is 0, Sunday is 6.
    # Our format: 1=Mon .. 7=Sun
    dow_str = str(target_date.weekday() + 1)

    # Find active schedules for active patients with valid consent
    active_schedules = MedicationSchedule.objects.filter(
        is_active=True,
        medication__status='active',
        patient__consent_status='consented',
        patient__enrollment_status='active'
    ).select_related('patient', 'patient__pharmacy', 'medication')

    for schedule in active_schedules:
        # Check day of week
        if dow_str not in schedule.days_of_week.split(','):
            continue

        # Check medication date bounds
        med = schedule.medication
        start_d = med.start_date.date() if isinstance(med.start_date, datetime) else med.start_date
        end_d = med.end_date.date() if isinstance(med.end_date, datetime) else med.end_date

        if start_d and target_date < start_d:
            continue
        if end_d and target_date > end_d:
            continue

        pharmacy = schedule.patient.pharmacy
        tz_name = pharmacy.timezone if pharmacy and pharmacy.timezone else 'Africa/Cairo'
        try:
            tz = zoneinfo.ZoneInfo(tz_name)
        except Exception:
            tz = zoneinfo.ZoneInfo('Africa/Cairo')

        local_datetime = datetime.combine(target_date, schedule.reminder_time)
        aware_scheduled_for = timezone.make_aware(local_datetime, tz)

        # Idempotency check: don't create if reminder already exists for this schedule and target date
        day_start = timezone.make_aware(datetime.combine(target_date, time.min), tz)
        day_end = timezone.make_aware(datetime.combine(target_date, time.max), tz)

        exists = ReminderEvent.objects.filter(
            patient=schedule.patient,
            medication_schedule=schedule,
            scheduled_for__range=(day_start, day_end)
        ).exclude(status='cancelled').exists()

        if not exists:
            ReminderEvent.objects.create(
                patient=schedule.patient,
                medication_schedule=schedule,
                scheduled_for=aware_scheduled_for,
                status='scheduled',
                template_name='wesal_medication_reminder'
            )
            created_count += 1

    return created_count


def dispatch_due_reminders(batch_size: int = 50) -> dict:
    """
    Finds due reminders, performs strict pre-send reconciliation,
    and sends via WhatsApp Cloud API.
    """
    now = timezone.now()
    due_reminders = ReminderEvent.objects.filter(
        status='scheduled',
        scheduled_for__lte=now
    ).select_related('patient', 'patient__pharmacy', 'medication_schedule', 'medication_schedule__medication')[:batch_size]

    sent_count = 0
    failed_count = 0
    cancelled_count = 0

    client = WhatsAppCloudApiClient()

    for reminder in due_reminders:
        with transaction.atomic():
            # Refresh from DB
            reminder = ReminderEvent.objects.select_for_update().get(id=reminder.id)
            if reminder.status != 'scheduled':
                continue

            patient = reminder.patient
            med_schedule = reminder.medication_schedule
            medication = med_schedule.medication if med_schedule else None

            # 1. Pre-send Verification
            if not patient.has_active_consent:
                reminder.status = 'cancelled'
                reminder.error_message = 'Patient consent is not active or enrollment paused.'
                reminder.save()
                cancelled_count += 1
                continue

            if medication and medication.status != 'active':
                reminder.status = 'cancelled'
                reminder.error_message = f'Medication is currently {medication.status}.'
                reminder.save()
                cancelled_count += 1
                continue

            # Check quiet hours
            pharmacy = patient.pharmacy
            if pharmacy:
                local_now = timezone.localtime(now, timezone.get_current_timezone()).time()
                is_quiet = False
                if pharmacy.quiet_hours_start > pharmacy.quiet_hours_end:
                    is_quiet = local_now >= pharmacy.quiet_hours_start or local_now <= pharmacy.quiet_hours_end
                else:
                    is_quiet = pharmacy.quiet_hours_start <= local_now <= pharmacy.quiet_hours_end

                if is_quiet:
                    # Delay reminder to next morning after quiet hours
                    continue

            # Mark as Queued / Submitted
            reminder.status = 'submitted'
            reminder.save()

        # Send via WhatsApp API
        send_res = client.send_medication_reminder(
            to_phone=patient.phone_number,
            patient_name=patient.full_name,
            template_name=reminder.template_name,
            language_code=patient.preferred_language,
            reminder_event_id=str(reminder.id)
        )

        if send_res.get('success'):
            reminder.status = 'sent'
            reminder.provider_message_id = send_res.get('provider_message_id')
            reminder.sent_at = timezone.now()
            reminder.error_message = None
            reminder.save()
            sent_count += 1
        else:
            reminder.status = 'failed'
            reminder.error_message = send_res.get('error', 'Unknown WhatsApp API error')
            reminder.retry_count += 1
            reminder.save()
            failed_count += 1

    return {
        'due_count': len(due_reminders),
        'sent': sent_count,
        'failed': failed_count,
        'cancelled': cancelled_count
    }
