from rest_framework import serializers, viewsets, status
from rest_framework.decorators import action
from rest_framework.response import Response
from .models import ReminderEvent, PatientResponse
from .services import generate_daily_reminders, dispatch_due_reminders
from accounts.permissions import IsPharmacyUser


class ReminderEventSerializer(serializers.ModelSerializer):
    patient_name = serializers.CharField(source='patient.full_name', read_only=True)
    patient_phone = serializers.CharField(source='patient.phone_number', read_only=True)
    medication_name = serializers.SerializerMethodField()
    dose_info = serializers.SerializerMethodField()

    class Meta:
        model = ReminderEvent
        fields = [
            'id', 'patient', 'patient_name', 'patient_phone',
            'medication_schedule', 'medication_name', 'dose_info',
            'scheduled_for', 'status', 'provider_message_id',
            'sent_at', 'delivered_at', 'read_at', 'responded_at',
            'retry_count', 'error_message', 'template_name',
            'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'provider_message_id', 'created_at', 'updated_at']

    def get_medication_name(self, obj):
        if obj.medication_schedule and obj.medication_schedule.medication:
            return obj.medication_schedule.medication.name
        return 'Medication Reminder'

    def get_dose_info(self, obj):
        if obj.medication_schedule and obj.medication_schedule.medication:
            med = obj.medication_schedule.medication
            return f"{med.dose} {med.unit}"
        return ''


class PatientResponseSerializer(serializers.ModelSerializer):
    patient_name = serializers.CharField(source='patient.full_name', read_only=True)
    patient_phone = serializers.CharField(source='patient.phone_number', read_only=True)
    response_type_display = serializers.CharField(source='get_response_type_display', read_only=True)

    class Meta:
        model = PatientResponse
        fields = [
            'id', 'patient', 'patient_name', 'patient_phone',
            'reminder', 'response_type', 'response_type_display',
            'raw_content', 'button_id', 'provider_message_id',
            'is_linked', 'review_status', 'received_at', 'created_at'
        ]
        read_only_fields = ['id', 'created_at']


class ReminderEventViewSet(viewsets.ModelViewSet):
    serializer_class = ReminderEventSerializer
    permission_classes = [IsPharmacyUser]

    def get_queryset(self):
        user = self.request.user
        if not user.is_authenticated:
            return ReminderEvent.objects.none()

        qs = ReminderEvent.objects.select_related('patient', 'medication_schedule__medication')
        if user.role != 'admin' and user.pharmacy:
            qs = qs.filter(patient__pharmacy=user.pharmacy)

        patient_id = self.request.query_params.get('patient')
        if patient_id:
            qs = qs.filter(patient_id=patient_id)

        status_param = self.request.query_params.get('status')
        if status_param:
            qs = qs.filter(status=status_param)

        date_param = self.request.query_params.get('date')
        if date_param:
            qs = qs.filter(scheduled_for__date=date_param)

        return qs

    @action(detail=False, methods=['post'], url_path='trigger-cycle')
    def trigger_cycle(self, request):
        """
        Triggers instant reminder generation and dispatch cycle.
        """
        generated = generate_daily_reminders()
        dispatched = dispatch_due_reminders()
        return Response({
            'message': 'Reminder cycle executed successfully',
            'generated_count': generated,
            'dispatch_summary': dispatched
        })

    @action(detail=True, methods=['post'], url_path='send-now')
    def send_now(self, request, pk=None):
        """
        Sends an individual reminder immediately via WhatsApp API.
        """
        reminder = self.get_object()
        from messaging.whatsapp_client import WhatsAppCloudApiClient
        client = WhatsAppCloudApiClient()
        
        send_res = client.send_medication_reminder(
            to_phone=reminder.patient.phone_number,
            patient_name=reminder.patient.full_name,
            template_name=reminder.template_name,
            language_code=reminder.patient.preferred_language,
            reminder_event_id=str(reminder.id)
        )

        if send_res.get('success'):
            reminder.status = 'sent'
            reminder.provider_message_id = send_res.get('provider_message_id')
            reminder.sent_at = serializers.DateTimeField().to_internal_value(serializers.DateTimeField().to_representation(serializers.timezone.now()))
            reminder.error_message = None
            reminder.save()
            return Response({'status': 'Sent successfully', 'reminder': ReminderEventSerializer(reminder).data})
        else:
            reminder.status = 'failed'
            reminder.error_message = send_res.get('error', 'Error sending')
            reminder.save()
            return Response({'status': 'Failed to send', 'error': reminder.error_message}, status=status.HTTP_400_BAD_REQUEST)


class PatientResponseViewSet(viewsets.ModelViewSet):
    serializer_class = PatientResponseSerializer
    permission_classes = [IsPharmacyUser]

    def get_queryset(self):
        user = self.request.user
        if not user.is_authenticated:
            return PatientResponse.objects.none()

        qs = PatientResponse.objects.select_related('patient', 'reminder')
        if user.role != 'admin' and user.pharmacy:
            qs = qs.filter(patient__pharmacy=user.pharmacy)

        patient_id = self.request.query_params.get('patient')
        if patient_id:
            qs = qs.filter(patient_id=patient_id)

        response_type = self.request.query_params.get('response_type')
        if response_type:
            qs = qs.filter(response_type=response_type)

        review_status = self.request.query_params.get('review_status')
        if review_status:
            qs = qs.filter(review_status=review_status)

        return qs

    @action(detail=True, methods=['post'], url_path='resolve')
    def resolve_response(self, request, pk=None):
        resp = self.get_object()
        resp.review_status = 'resolved'
        resp.save()
        return Response({'status': 'Response resolved', 'data': PatientResponseSerializer(resp).data})
