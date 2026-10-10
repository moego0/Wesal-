from rest_framework import viewsets, status, permissions
from rest_framework.decorators import action
from rest_framework.response import Response
from django.utils import timezone
from .models import MedicationRecord, MedicationSchedule
from .serializers import (
    MedicationRecordSerializer,
    MedicationScheduleSerializer,
    ChangeMedicationStatusSerializer
)
from accounts.permissions import IsPharmacyUser
from audit.models import AuditEvent


class MedicationRecordViewSet(viewsets.ModelViewSet):
    serializer_class = MedicationRecordSerializer
    permission_classes = [IsPharmacyUser]

    def get_queryset(self):
        user = self.request.user
        if not user.is_authenticated:
            return MedicationRecord.objects.none()

        qs = MedicationRecord.objects.select_related('patient', 'created_by', 'updated_by').prefetch_related('schedules')
        if user.role != 'admin' and user.pharmacy:
            qs = qs.filter(patient__pharmacy=user.pharmacy)

        patient_id = self.request.query_params.get('patient')
        if patient_id:
            qs = qs.filter(patient_id=patient_id)

        status_param = self.request.query_params.get('status')
        if status_param:
            qs = qs.filter(status=status_param)

        return qs

    def perform_create(self, serializer):
        user = self.request.user
        medication = serializer.save(created_by=user, updated_by=user)
        
        # Log Audit
        AuditEvent.log(
            pharmacy=medication.patient.pharmacy,
            user=user,
            action='medication.create',
            entity_type='medication',
            entity_id=str(medication.id),
            metadata={
                'patient_id': str(medication.patient.id),
                'name': medication.name,
                'dose': medication.dose,
                'times': medication.scheduled_times
            }
        )

    def perform_update(self, serializer):
        user = self.request.user
        instance = serializer.instance
        old_times = set(instance.scheduled_times or [])
        
        medication = serializer.save(updated_by=user)
        new_times = set(medication.scheduled_times or [])

        # If scheduled times changed, cancel future pending reminders that were for obsolete times
        if old_times != new_times:
            from reminders.models import ReminderEvent
            cancelled_count = ReminderEvent.objects.filter(
                medication_schedule__medication=medication,
                status__in=['scheduled', 'queued']
            ).update(
                status='cancelled',
                error_message='Schedule modified by pharmacist. Old reminders invalidated.'
            )

        # Log Audit
        AuditEvent.log(
            pharmacy=medication.patient.pharmacy,
            user=user,
            action='medication.update',
            entity_type='medication',
            entity_id=str(medication.id),
            metadata={
                'name': medication.name,
                'times': medication.scheduled_times
            }
        )

    @action(detail=True, methods=['post'], url_path='change-status')
    def change_status(self, request, pk=None):
        medication = self.get_object()
        serializer = ChangeMedicationStatusSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        new_status = serializer.validated_data['status']
        reason = serializer.validated_data['reason']

        medication.status = new_status
        medication.status_change_reason = reason
        medication.updated_by = request.user
        medication.save()

        # Invalidate affected pending reminders
        cancelled_count = 0
        if new_status in ['paused', 'discontinued', 'completed']:
            from reminders.models import ReminderEvent
            cancelled_count = ReminderEvent.objects.filter(
                medication_schedule__medication=medication,
                status__in=['scheduled', 'queued']
            ).update(
                status='cancelled',
                error_message=f'Medication {new_status}: {reason}'
            )

        # Log Audit
        AuditEvent.log(
            pharmacy=medication.patient.pharmacy,
            user=request.user,
            action=f'medication.status_{new_status}',
            entity_type='medication',
            entity_id=str(medication.id),
            metadata={
                'old_status': medication.status,
                'new_status': new_status,
                'reason': reason,
                'cancelled_reminders': cancelled_count
            }
        )

        return Response({
            'status': f'Medication marked as {new_status}',
            'cancelled_reminders': cancelled_count,
            'medication': MedicationRecordSerializer(medication).data
        })


class MedicationScheduleViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = MedicationScheduleSerializer
    permission_classes = [IsPharmacyUser]

    def get_queryset(self):
        user = self.request.user
        qs = MedicationSchedule.objects.select_related('medication', 'patient')
        if user.role != 'admin' and user.pharmacy:
            qs = qs.filter(patient__pharmacy=user.pharmacy)
        patient_id = self.request.query_params.get('patient')
        if patient_id:
            qs = qs.filter(patient_id=patient_id)
        return qs
