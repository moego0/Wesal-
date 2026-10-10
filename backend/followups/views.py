from rest_framework import viewsets, status, permissions
from rest_framework.decorators import action
from rest_framework.response import Response
from django.utils import timezone
from .models import FollowUpCase, PharmacistIntervention
from .serializers import (
    FollowUpCaseSerializer,
    PharmacistInterventionSerializer,
    CreateInterventionSerializer,
    CloseCaseSerializer
)
from accounts.permissions import IsPharmacyUser
from audit.models import AuditEvent


class FollowUpCaseViewSet(viewsets.ModelViewSet):
    serializer_class = FollowUpCaseSerializer
    permission_classes = [IsPharmacyUser]

    def get_queryset(self):
        user = self.request.user
        if not user.is_authenticated:
            return FollowUpCase.objects.none()

        qs = FollowUpCase.objects.select_related(
            'patient', 'pharmacy', 'assigned_pharmacist', 'closed_by'
        ).prefetch_related('interventions', 'interventions__pharmacist')

        if user.role != 'admin' and user.pharmacy:
            qs = qs.filter(pharmacy=user.pharmacy)

        patient_id = self.request.query_params.get('patient')
        if patient_id:
            qs = qs.filter(patient_id=patient_id)

        status_param = self.request.query_params.get('status')
        if status_param:
            qs = qs.filter(status=status_param)

        priority = self.request.query_params.get('priority')
        if priority:
            qs = qs.filter(priority=priority)

        due_today = self.request.query_params.get('due_today')
        if due_today:
            qs = qs.filter(due_date=timezone.now().date(), status__in=['open', 'in_progress'])

        overdue = self.request.query_params.get('overdue')
        if overdue:
            qs = qs.filter(due_date__lt=timezone.now().date(), status__in=['open', 'in_progress'])

        return qs

    def perform_create(self, serializer):
        user = self.request.user
        pharmacy = user.pharmacy if user.role != 'admin' else serializer.validated_data.get('pharmacy')
        case = serializer.save(pharmacy=pharmacy, assigned_pharmacist=user)
        
        AuditEvent.log(
            pharmacy=case.pharmacy,
            user=user,
            action='followup.case_created',
            entity_type='follow_up_case',
            entity_id=str(case.id),
            metadata={'trigger_reason': case.trigger_reason, 'priority': case.priority}
        )

    @action(detail=True, methods=['post'], url_path='add-intervention')
    def add_intervention(self, request, pk=None):
        case = self.get_object()
        serializer = CreateInterventionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        mark_resolved = serializer.validated_data.pop('mark_case_resolved', False)
        
        intervention = PharmacistIntervention.objects.create(
            follow_up_case=case,
            pharmacist=request.user,
            **serializer.validated_data
        )

        if mark_resolved:
            case.status = 'resolved'
        elif case.status == 'open':
            case.status = 'in_progress'

        if intervention.next_follow_up_date:
            case.due_date = intervention.next_follow_up_date

        case.save()

        AuditEvent.log(
            pharmacy=case.pharmacy,
            user=request.user,
            action='followup.add_intervention',
            entity_type='follow_up_case',
            entity_id=str(case.id),
            metadata={'intervention_id': str(intervention.id), 'status': case.status}
        )

        return Response({
            'status': 'Intervention recorded successfully',
            'case': FollowUpCaseSerializer(case).data,
            'intervention': PharmacistInterventionSerializer(intervention).data
        })

    @action(detail=True, methods=['post'], url_path='close')
    def close_case(self, request, pk=None):
        case = self.get_object()
        serializer = CloseCaseSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        reason = serializer.validated_data['closure_reason']
        case.status = 'closed'
        case.closed_at = timezone.now()
        case.closed_by = request.user
        case.closure_reason = reason
        case.save()

        AuditEvent.log(
            pharmacy=case.pharmacy,
            user=request.user,
            action='followup.close_case',
            entity_type='follow_up_case',
            entity_id=str(case.id),
            metadata={'closure_reason': reason}
        )

        return Response({
            'status': 'Case closed successfully',
            'case': FollowUpCaseSerializer(case).data
        })


class PharmacistInterventionViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = PharmacistInterventionSerializer
    permission_classes = [IsPharmacyUser]

    def get_queryset(self):
        user = self.request.user
        if not user.is_authenticated:
            return PharmacistIntervention.objects.none()

        qs = PharmacistIntervention.objects.select_related('follow_up_case', 'pharmacist')
        if user.role != 'admin' and user.pharmacy:
            qs = qs.filter(follow_up_case__pharmacy=user.pharmacy)
        return qs
