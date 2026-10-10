import uuid
from django.db import models


class WhatsAppMessageLog(models.Model):
    DIRECTION_CHOICES = [
        ('outbound', 'Outbound'),
        ('inbound', 'Inbound'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    direction = models.CharField(max_length=10, choices=DIRECTION_CHOICES, default='outbound')
    phone_number = models.CharField(max_length=30)
    provider_message_id = models.CharField(max_length=255, blank=True, null=True, db_index=True)
    template_name = models.CharField(max_length=100, blank=True, null=True)
    status = models.CharField(max_length=30, default='submitted')
    payload = models.JSONField(default=dict, blank=True)
    response_body = models.JSONField(default=dict, blank=True)
    error_details = models.TextField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['provider_message_id']),
            models.Index(fields=['phone_number', '-created_at']),
        ]

    def __str__(self):
        return f"{self.direction.upper()} to/from {self.phone_number} [{self.status}]"


class WebhookEventLog(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    event_type = models.CharField(max_length=50, blank=True, null=True)
    provider_message_id = models.CharField(max_length=255, blank=True, null=True, db_index=True)
    raw_payload = models.JSONField(default=dict)
    processed = models.BooleanField(default=False)
    processing_error = models.TextField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"Webhook event {self.event_type} ({'Processed' if self.processed else 'Pending'})"
