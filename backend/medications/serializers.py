from rest_framework import serializers
from .models import MedicationRecord, MedicationSchedule
from audit.models import AuditEvent


class MedicationScheduleSerializer(serializers.ModelSerializer):
    reminder_time_formatted = serializers.SerializerMethodField()

    class Meta:
        model = MedicationSchedule
        fields = ['id', 'medication', 'patient', 'reminder_time', 'reminder_time_formatted', 'days_of_week', 'is_active']
        read_only_fields = ['id', 'patient']

    def get_reminder_time_formatted(self, obj):
        return obj.reminder_time.strftime('%H:%M')


class MedicationRecordSerializer(serializers.ModelSerializer):
    schedules = MedicationScheduleSerializer(many=True, read_only=True)
    created_by_name = serializers.CharField(source='created_by.name', read_only=True)
    patient_name = serializers.CharField(source='patient.full_name', read_only=True)
    patient_phone = serializers.CharField(source='patient.phone_number', read_only=True)

    class Meta:
        model = MedicationRecord
        fields = [
            'id', 'patient', 'patient_name', 'patient_phone', 'name',
            'dose', 'unit', 'route', 'frequency_description',
            'scheduled_times', 'start_date', 'end_date', 'is_chronic',
            'prescription_reference', 'status', 'status_change_reason',
            'special_instructions', 'created_by', 'created_by_name',
            'updated_by', 'schedules', 'created_at', 'updated_at'
        ]
        read_only_fields = ['id', 'created_at', 'updated_at', 'created_by', 'updated_by']

    def validate_scheduled_times(self, value):
        if not isinstance(value, list):
            raise serializers.ValidationError("scheduled_times must be a list of time strings like ['08:00', '20:00']")
        for item in value:
            if not isinstance(item, str) or len(item.split(':')) < 2:
                raise serializers.ValidationError(f"Invalid time format '{item}'. Use HH:MM format.")
        return sorted(list(set(value)))


class ChangeMedicationStatusSerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=MedicationRecord.STATUS_CHOICES)
    reason = serializers.CharField(required=True, allow_blank=False)
