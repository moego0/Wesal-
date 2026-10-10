from rest_framework import viewsets, status, permissions
from rest_framework.decorators import action
from rest_framework.response import Response
from django.utils import timezone
from django.db.models import Count, Q
from .models import Patient, ConsentRecord
from .serializers import (
    PatientSerializer,
    PatientCreateSerializer,
    ConsentRecordSerializer,
    WithdrawConsentSerializer
)
from accounts.permissions import IsPharmacyUser


class PatientViewSet(viewsets.ModelViewSet):
    permission_classes = [IsPharmacyUser]

    def get_serializer_class(self):
        if self.action == 'create':
            return PatientCreateSerializer
        return PatientSerializer

    def get_queryset(self):
        user = self.request.user
        if not user.is_authenticated:
            return Patient.objects.none()
        
        qs = Patient.objects.select_related('pharmacy', 'responsible_pharmacist')
        if user.role != 'admin':
            if user.pharmacy:
                qs = qs.filter(pharmacy=user.pharmacy)
            else:
                return Patient.objects.none()

        # Filters
        search = self.request.query_params.get('search')
        if search:
            qs = qs.filter(
                Q(full_name__icontains=search) |
                Q(phone_number__icontains=search) |
                Q(patient_code__icontains=search)
            )

        consent = self.request.query_params.get('consent_status')
        if consent:
            qs = qs.filter(consent_status=consent)

        enrollment = self.request.query_params.get('enrollment_status')
        if enrollment:
            qs = qs.filter(enrollment_status=enrollment)

        pharmacist = self.request.query_params.get('pharmacist')
        if pharmacist:
            qs = qs.filter(responsible_pharmacist_id=pharmacist)

        return qs

    def perform_create(self, serializer):
        user = self.request.user
        if user.role != 'admin' and user.pharmacy:
            serializer.save(pharmacy=user.pharmacy, responsible_pharmacist=user)
        else:
            serializer.save()

    @action(detail=True, methods=['post'], url_path='withdraw-consent')
    def withdraw_consent(self, request, pk=None):
        patient = self.get_object()
        serializer = WithdrawConsentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        reason = serializer.validated_data.get('reason', 'Consent withdrawn by patient request')

        now = timezone.now()
        patient.consent_status = 'withdrawn'
        patient.enrollment_status = 'paused'
        patient.save()

        # Update active consent records
        patient.consent_records.filter(status='active').update(
            status='withdrawn',
            withdrawn_at=now,
            withdrawal_reason=reason
        )

        # Invalidate & cancel all future pending reminders
        from reminders.models import ReminderEvent
        cancelled_count = ReminderEvent.objects.filter(
            patient=patient,
            status__in=['scheduled', 'queued']
        ).update(
            status='cancelled',
            error_message=f'Cancelled due to consent withdrawal: {reason}'
        )

        # Audit event
        from audit.models import AuditEvent
        AuditEvent.log(
            pharmacy=patient.pharmacy,
            user=request.user,
            action='patient.withdraw_consent',
            entity_type='patient',
            entity_id=str(patient.id),
            metadata={'reason': reason, 'cancelled_reminders': cancelled_count}
        )

        return Response({
            'status': 'Consent withdrawn successfully',
            'cancelled_reminders': cancelled_count,
            'patient': PatientSerializer(patient).data
        })

    @action(detail=True, methods=['post'], url_path='renew-consent')
    def renew_consent(self, request, pk=None):
        patient = self.get_object()
        now = timezone.now()
        patient.consent_status = 'consented'
        patient.enrollment_status = 'active'
        patient.consent_recorded_at = now
        patient.save()

        ConsentRecord.objects.create(
            patient=patient,
            consent_type='medication_reminders',
            status='active',
            scope='WhatsApp medication reminders & adherence follow-up',
            recording_method=request.data.get('recording_method', 'verbal_in_person'),
            recorded_by=request.user,
            notes=request.data.get('notes', 'Consent renewed')
        )

        from audit.models import AuditEvent
        AuditEvent.log(
            pharmacy=patient.pharmacy,
            user=request.user,
            action='patient.renew_consent',
            entity_type='patient',
            entity_id=str(patient.id)
        )

        return Response({
            'status': 'Consent renewed successfully',
            'patient': PatientSerializer(patient).data
        })

    @action(detail=True, methods=['get'], url_path='timeline')
    def timeline(self, request, pk=None):
        patient = self.get_object()
        
        # Gather reminders
        from reminders.models import ReminderEvent
        reminders = ReminderEvent.objects.filter(patient=patient).select_related('medication_schedule__medication').order_by('-scheduled_for')[:30]
        
        # Gather responses
        from reminders.models import PatientResponse
        responses = PatientResponse.objects.filter(patient=patient).order_by('-received_at')[:30]
        
        # Gather follow-up cases
        from followups.models import FollowUpCase
        cases = FollowUpCase.objects.filter(patient=patient).prefetch_related('interventions').order_by('-created_at')[:15]
        
        # Gather consent records
        consents = patient.consent_records.all().order_by('-recorded_at')[:10]

        events = []
        for r in reminders:
            med_name = r.medication_schedule.medication.name if r.medication_schedule and r.medication_schedule.medication else 'Medication'
            events.append({
                'type': 'reminder',
                'timestamp': r.scheduled_for,
                'title': f'Reminder: {med_name}',
                'status': r.status,
                'details': {
                    'reminder_id': str(r.id),
                    'provider_message_id': r.provider_message_id,
                    'sent_at': r.sent_at,
                    'error': r.error_message
                }
            })

        for resp in responses:
            events.append({
                'type': 'patient_response',
                'timestamp': resp.received_at,
                'title': f'Patient Response: {resp.get_response_type_display()}',
                'status': resp.response_type,
                'details': {
                    'response_id': str(resp.id),
                    'raw_content': resp.raw_content,
                    'is_linked': resp.is_linked,
                    'reminder_id': str(resp.reminder_id) if resp.reminder_id else None
                }
            })

        for c in cases:
            events.append({
                'type': 'followup_case',
                'timestamp': c.created_at,
                'title': f'Follow-up Case: {c.get_trigger_reason_display()}',
                'status': c.status,
                'priority': c.priority,
                'details': {
                    'case_id': str(c.id),
                    'interventions_count': c.interventions.count(),
                    'due_date': c.due_date
                }
            })

        for cn in consents:
            events.append({
                'type': 'consent',
                'timestamp': cn.recorded_at,
                'title': f'Consent {cn.status.title()}',
                'status': cn.status,
                'details': {
                    'method': cn.get_recording_method_display(),
                    'scope': cn.scope,
                    'withdrawn_at': cn.withdrawn_at,
                    'reason': cn.withdrawal_reason
                }
            })

        # Sort combined events by timestamp descending
        events.sort(key=lambda x: x['timestamp'], reverse=True)

        return Response({'timeline': events})


class ConsentRecordViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = ConsentRecordSerializer
    permission_classes = [IsPharmacyUser]

    def get_queryset(self):
        user = self.request.user
        qs = ConsentRecord.objects.select_related('patient', 'recorded_by')
        if user.role != 'admin' and user.pharmacy:
            qs = qs.filter(patient__pharmacy=user.pharmacy)
        patient_id = self.request.query_params.get('patient')
        if patient_id:
            qs = qs.filter(patient_id=patient_id)
        return qs
