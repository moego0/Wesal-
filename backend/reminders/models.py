import uuid
from django.db import models
from django.utils import timezone
from patients.models import Patient
from medications.models import MedicationSchedule


class ReminderEvent(models.Model):
    STATUS_CHOICES = [
        ('scheduled', 'Scheduled'),
        ('queued', 'Queued'),
        ('submitted', 'Submitted to Provider'),
        ('sent', 'Sent (Delivered to Gateway)'),
        ('delivered', 'Delivered to Device'),
        ('read', 'Read by Patient'),
        ('failed', 'Delivery Failed'),
        ('responded', 'Responded by Patient'),
        ('cancelled', 'Cancelled'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    patient = models.ForeignKey(Patient, on_delete=models.CASCADE, related_name='reminders')
    medication_schedule = models.ForeignKey(
        MedicationSchedule, on_delete=models.SET_NULL, null=True, blank=True, related_name='reminders'
    )
    scheduled_for = models.DateTimeField(db_index=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='scheduled', db_index=True)
    
    # Meta WhatsApp message ID e.g. "wamid.HBgLMjAxMD..."
    provider_message_id = models.CharField(max_length=255, blank=True, null=True, db_index=True)
    
    sent_at = models.DateTimeField(null=True, blank=True)
    delivered_at = models.DateTimeField(null=True, blank=True)
    read_at = models.DateTimeField(null=True, blank=True)
    responded_at = models.DateTimeField(null=True, blank=True)
    
    retry_count = models.PositiveIntegerField(default=0)
    error_message = models.TextField(blank=True, null=True)
    
    # Custom template parameters used
    template_name = models.CharField(max_length=100, default='wesal_medication_reminder')
    
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-scheduled_for']
        indexes = [
            models.Index(fields=['patient', 'status']),
            models.Index(fields=['scheduled_for', 'status']),
            models.Index(fields=['provider_message_id']),
        ]

    def __str__(self):
        med_name = self.medication_schedule.medication.name if self.medication_schedule else 'Medication'
        return f"Reminder for {self.patient.full_name} ({med_name}) at {self.scheduled_for} [{self.status}]"


class PatientResponse(models.Model):
    RESPONSE_TYPES = [
        ('taken', 'Taken (تم أخذ الدواء)'),
        ('taken_late', 'Taken Late (أخذته متأخرًا)'),
        ('missed', 'Missed (لم آخذه)'),
        ('remind_later', 'Remind Later (ذكّرني لاحقًا)'),
        ('problem', 'Medication Problem (لدي مشكلة مع الدواء)'),
        ('unknown', 'Unknown / Unrecognized Response (رد غير معروف)'),
    ]

    REVIEW_STATUS_CHOICES = [
        ('processed', 'Processed'),
        ('flagged_for_review', 'Flagged for Pharmacist Review'),
        ('resolved', 'Resolved by Pharmacist'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    patient = models.ForeignKey(Patient, on_delete=models.CASCADE, related_name='responses')
    reminder = models.ForeignKey(
        ReminderEvent, on_delete=models.SET_NULL, null=True, blank=True, related_name='patient_responses'
    )
    response_type = models.CharField(max_length=20, choices=RESPONSE_TYPES, default='unknown', db_index=True)
    raw_content = models.TextField(help_text="Inbound WhatsApp message body or button title")
    button_id = models.CharField(max_length=100, blank=True, null=True)
    
    provider_message_id = models.CharField(max_length=255, blank=True, null=True, unique=True)
    is_linked = models.BooleanField(default=True)
    review_status = models.CharField(max_length=30, choices=REVIEW_STATUS_CHOICES, default='processed')
    
    received_at = models.DateTimeField(default=timezone.now)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-received_at']
        indexes = [
            models.Index(fields=['patient', '-received_at']),
            models.Index(fields=['response_type']),
            models.Index(fields=['review_status']),
        ]

    def __str__(self):
        return f"Response [{self.response_type}] from {self.patient.full_name} at {self.received_at}"
