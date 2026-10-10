from rest_framework import serializers
from .models import WhatsAppMessageLog, WebhookEventLog


class WhatsAppMessageLogSerializer(serializers.ModelSerializer):
    class Meta:
        model = WhatsAppMessageLog
        fields = [
            'id', 'direction', 'phone_number', 'provider_message_id',
            'template_name', 'status', 'payload', 'response_body',
            'error_details', 'created_at'
        ]
        read_only_fields = fields


class WebhookEventLogSerializer(serializers.ModelSerializer):
    class Meta:
        model = WebhookEventLog
        fields = ['id', 'event_type', 'provider_message_id', 'raw_payload', 'processed', 'processing_error', 'created_at']
        read_only_fields = fields


class SendTestMessageSerializer(serializers.Serializer):
    phone_number = serializers.CharField(required=True)
    patient_name = serializers.CharField(default="Patient Test")
    template_name = serializers.CharField(required=False, default="wesal_medication_reminder")
    language_code = serializers.CharField(default="ar")


class SimulateInboundWebhookSerializer(serializers.Serializer):
    phone_number = serializers.CharField(required=True)
    response_type = serializers.ChoiceField(
        choices=['taken', 'taken_late', 'missed', 'remind_later', 'problem', 'custom_text'],
        default='taken'
    )
    custom_text = serializers.CharField(required=False, allow_blank=True)
    reminder_id = serializers.CharField(required=False, allow_blank=True)
