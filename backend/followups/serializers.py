from rest_framework import serializers
from .models import FollowUpCase, PharmacistIntervention


class PharmacistInterventionSerializer(serializers.ModelSerializer):
    pharmacist_name = serializers.CharField(source='pharmacist.name', read_only=True)
    contact_method_display = serializers.CharField(source='get_contact_method_display', read_only=True)

    class Meta:
        model = PharmacistIntervention
        fields = [
            'id', 'follow_up_case', 'pharmacist', 'pharmacist_name',
            'contact_attempted', 'contact_method', 'contact_method_display',
            'patient_reported_reason', 'action_taken',
            'referral_indicated', 'referral_notes',
            'next_follow_up_date', 'outcome_notes', 'created_at'
        ]
        read_only_fields = ['id', 'created_at', 'pharmacist']


class FollowUpCaseSerializer(serializers.ModelSerializer):
    patient_name = serializers.CharField(source='patient.full_name', read_only=True)
    patient_phone = serializers.CharField(source='patient.phone_number', read_only=True)
    assigned_pharmacist_name = serializers.CharField(source='assigned_pharmacist.name', read_only=True)
    closed_by_name = serializers.CharField(source='closed_by.name', read_only=True)
    trigger_reason_display = serializers.CharField(source='get_trigger_reason_display', read_only=True)
    interventions = PharmacistInterventionSerializer(many=True, read_only=True)

    class Meta:
        model = FollowUpCase
        fields = [
            'id', 'patient', 'patient_name', 'patient_phone', 'pharmacy',
            'trigger_reason', 'trigger_reason_display', 'priority', 'status',
            'due_date', 'trigger_notes', 'assigned_pharmacist',
            'assigned_pharmacist_name', 'closed_at', 'closed_by',
            'closed_by_name', 'closure_reason', 'interventions',
            'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at', 'closed_at', 'closed_by']


class CreateInterventionSerializer(serializers.ModelSerializer):
    mark_case_resolved = serializers.BooleanField(default=False, write_only=True)

    class Meta:
        model = PharmacistIntervention
        fields = [
            'id', 'contact_attempted', 'contact_method',
            'patient_reported_reason', 'action_taken',
            'referral_indicated', 'referral_notes',
            'next_follow_up_date', 'outcome_notes',
            'mark_case_resolved'
        ]


class CloseCaseSerializer(serializers.Serializer):
    closure_reason = serializers.CharField(required=True, allow_blank=False)
