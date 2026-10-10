import json
import logging
from datetime import timedelta
from django.utils import timezone
from django.db import transaction
from .models import WebhookEventLog, WhatsAppMessageLog
from .whatsapp_client import classify_patient_response
from patients.models import Patient, normalize_phone_number
from reminders.models import ReminderEvent, PatientResponse
from followups.services import evaluate_patient_followup_triggers

logger = logging.getLogger(__name__)


def process_meta_webhook_payload(payload: dict) -> dict:
    """
    Parses Meta WhatsApp Webhook payload and safely processes message statuses or inbound responses.
    """
    entry_list = payload.get("entry", [])
    processed_events = 0
    errors = []

    for entry in entry_list:
        changes = entry.get("changes", [])
        for change in changes:
            value = change.get("value", {})
            field = change.get("field", "")

            if field != "messages":
                continue

            # 1. Process Status Updates (sent, delivered, read, failed)
            statuses = value.get("statuses", [])
            for status_item in statuses:
                try:
                    _process_status_update(status_item)
                    processed_events += 1
                except Exception as e:
                    logger.exception("Error processing status update: %s", e)
                    errors.append(str(e))

            # 2. Process Inbound Messages / Interactive Responses
            messages = value.get("messages", [])
            contacts = value.get("contacts", [])
            for msg_item in messages:
                try:
                    _process_inbound_message(msg_item, contacts)
                    processed_events += 1
                except Exception as e:
                    logger.exception("Error processing inbound message: %s", e)
                    errors.append(str(e))

    return {"processed": processed_events, "errors": errors}


def _process_status_update(status_item: dict):
    provider_id = status_item.get("id")
    status_name = status_item.get("status") # 'sent', 'delivered', 'read', 'failed'
    timestamp_str = status_item.get("timestamp")
    recipient_id = status_item.get("recipient_id")

    # Log webhook event idempotently
    event_key = f"status_{provider_id}_{status_name}"
    if WebhookEventLog.objects.filter(provider_message_id=event_key).exists():
        return

    log_entry = WebhookEventLog.objects.create(
        event_type=f"status_{status_name}",
        provider_message_id=event_key,
        raw_payload=status_item
    )

    # Find matching reminder
    reminders = ReminderEvent.objects.filter(provider_message_id=provider_id)
    if reminders.exists():
        reminder = reminders.first()
        event_time = timezone.now()

        if status_name == 'sent':
            if reminder.status in ['scheduled', 'queued', 'submitted']:
                reminder.status = 'sent'
                reminder.sent_at = reminder.sent_at or event_time
        elif status_name == 'delivered':
            if reminder.status in ['scheduled', 'queued', 'submitted', 'sent']:
                reminder.status = 'delivered'
                reminder.delivered_at = event_time
        elif status_name == 'read':
            reminder.status = 'read'
            reminder.read_at = event_time
        elif status_name == 'failed':
            reminder.status = 'failed'
            errors = status_item.get("errors", [])
            error_msg = "; ".join([f"Code {e.get('code')}: {e.get('title', '')} - {e.get('details', '')}" for e in errors]) if errors else "Delivery failed"
            reminder.error_message = error_msg
            
            # Check repeated delivery failures trigger
            evaluate_patient_followup_triggers(reminder.patient, trigger_hint='delivery_failure')

        reminder.save()

    # Also update WhatsAppMessageLog
    WhatsAppMessageLog.objects.filter(provider_message_id=provider_id).update(status=status_name)
    log_entry.processed = True
    log_entry.save()


def _process_inbound_message(msg_item: dict, contacts: list):
    provider_msg_id = msg_item.get("id")
    from_phone_raw = msg_item.get("from")
    normalized_phone = normalize_phone_number("+" + from_phone_raw if not from_phone_raw.startswith("+") else from_phone_raw)
    msg_type = msg_item.get("type") # 'text', 'interactive', 'button', etc.

    # Idempotency check
    if PatientResponse.objects.filter(provider_message_id=provider_msg_id).exists():
        return

    raw_text = ""
    button_id = None

    if msg_type == 'text':
        raw_text = msg_item.get("text", {}).get("body", "")
    elif msg_type == 'interactive':
        interactive_data = msg_item.get("interactive", {})
        itype = interactive_data.get("type")
        if itype == 'button_reply':
            button_id = interactive_data.get("button_reply", {}).get("id")
            raw_text = interactive_data.get("button_reply", {}).get("title", "")
        elif itype == 'list_reply':
            button_id = interactive_data.get("list_reply", {}).get("id")
            raw_text = interactive_data.get("list_reply", {}).get("title", "")
    elif msg_type == 'button':
        button_id = msg_item.get("button", {}).get("payload")
        raw_text = msg_item.get("button", {}).get("text", "")
    else:
        raw_text = f"[{msg_type} message]"

    response_type, _ = classify_patient_response(raw_text, button_id)

    # Find Patient
    patient = Patient.objects.filter(phone_number=normalized_phone).first()
    if not patient:
        # Fallback: check without country code or digits match
        last_9 = normalized_phone[-9:] if len(normalized_phone) >= 9 else normalized_phone
        patient = Patient.objects.filter(phone_number__endswith=last_9).first()

    # Link to recent ReminderEvent
    context_data = msg_item.get("context", {})
    context_wamid = context_data.get("id")
    matching_reminder = None

    if context_wamid:
        matching_reminder = ReminderEvent.objects.filter(provider_message_id=context_wamid).first()

    if not matching_reminder and patient:
        # Find latest reminder sent within last 24 hours that hasn't responded yet
        recent_window = timezone.now() - timedelta(hours=24)
        matching_reminder = ReminderEvent.objects.filter(
            patient=patient,
            scheduled_for__gte=recent_window,
            status__in=['sent', 'delivered', 'read', 'submitted']
        ).order_by('-scheduled_for').first()

    with transaction.atomic():
        if patient:
            # Handle "Remind Later" workflow
            if response_type == 'remind_later':
                _handle_remind_later(patient, matching_reminder)

            review_status = 'processed'
            if response_type in ['problem', 'unknown'] or not matching_reminder:
                review_status = 'flagged_for_review'

            patient_response = PatientResponse.objects.create(
                patient=patient,
                reminder=matching_reminder,
                response_type=response_type,
                raw_content=raw_text,
                button_id=button_id or "",
                provider_message_id=provider_msg_id,
                is_linked=bool(matching_reminder),
                review_status=review_status,
                received_at=timezone.now()
            )

            if matching_reminder:
                matching_reminder.status = 'responded'
                matching_reminder.responded_at = timezone.now()
                matching_reminder.save()

            # Trigger follow-up check
            evaluate_patient_followup_triggers(patient, trigger_hint=response_type, response_instance=patient_response)

        # Log inbound message
        WhatsAppMessageLog.objects.create(
            direction='inbound',
            phone_number=normalized_phone,
            provider_message_id=provider_msg_id,
            status='received',
            payload=msg_item,
            response_body={'response_type': response_type, 'patient_matched': bool(patient)}
        )


def _handle_remind_later(patient: Patient, original_reminder: ReminderEvent = None):
    """
    Snoozes the reminder for 60 minutes if within allowed quiet hours.
    """
    snooze_time = timezone.now() + timedelta(minutes=60)
    
    # Check if quiet hours allow this
    pharmacy = patient.pharmacy
    local_time = timezone.localtime(snooze_time, timezone.get_current_timezone()).time()
    if pharmacy.quiet_hours_start <= local_time or local_time <= pharmacy.quiet_hours_end:
        # If snooze falls inside quiet hours, schedule for morning after quiet hours end
        next_day = snooze_time.date()
        if local_time >= pharmacy.quiet_hours_start:
            next_day += timedelta(days=1)
        snooze_time = timezone.make_aware(
            timezone.datetime.combine(next_day, pharmacy.quiet_hours_end) + timedelta(minutes=15)
        )

    # Create snoozed reminder event
    med_schedule = original_reminder.medication_schedule if original_reminder else None
    ReminderEvent.objects.create(
        patient=patient,
        medication_schedule=med_schedule,
        scheduled_for=snooze_time,
        status='scheduled',
        template_name='wesal_medication_reminder'
    )
