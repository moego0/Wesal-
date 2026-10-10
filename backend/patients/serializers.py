from rest_framework import serializers
from django.utils import timezone
from .models import Patient, ConsentRecord
from accounts.models import User


class ConsentRecordSerializer(serializers.ModelSerializer):
    recorded_by_name = serializers.CharField(source='recorded_by.name', read_only=True)

    class Meta:
        model = ConsentRecord
        fields = [
            'id', 'patient', 'consent_type', 'status', 'scope',
            'recording_method', 'recorded_by', 'recorded_by_name',
            'recorded_at', 'withdrawn_at', 'withdrawal_reason', 'notes'
        ]
        read_only_fields = ['id', 'recorded_at']


class PatientSerializer(serializers.ModelSerializer):
    responsible_pharmacist_name = serializers.CharField(
        source='responsible_pharmacist.name', read_only=True
    )
    pharmacy_name = serializers.CharField(source='pharmacy.name', read_only=True)
    active_medications_count = serializers.IntegerField(read_only=True, default=0)
    open_cases_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = Patient
        fields = [
            'id', 'patient_code', 'full_name', 'phone_number',
            'preferred_channel', 'preferred_language', 'consent_status',
            'consent_recorded_at', 'enrollment_status', 'pharmacy',
            'pharmacy_name', 'responsible_pharmacist', 'responsible_pharmacist_name',
            'notes', 'created_at', 'updated_at',
            'active_medications_count', 'open_cases_count'
        ]
        read_only_fields = ['id', 'patient_code', 'created_at', 'updated_at']


class PatientCreateSerializer(serializers.ModelSerializer):
    consent_method = serializers.ChoiceField(
        choices=ConsentRecord.CONSENT_METHOD_CHOICES,
        default='verbal_in_person',
        write_only=True
    )
    consent_scope = serializers.CharField(
        default='WhatsApp medication reminders & adherence follow-up',
        write_only=True
    )

    class Meta:
        model = Patient
        fields = [
            'id', 'patient_code', 'full_name', 'phone_number',
            'preferred_channel', 'preferred_language', 'enrollment_status',
            'pharmacy', 'responsible_pharmacist', 'notes',
            'consent_method', 'consent_scope'
        ]
        read_only_fields = ['id', 'patient_code']

    def create(self, validated_data):
        consent_method = validated_data.pop('consent_method', 'verbal_in_person')
        consent_scope = validated_data.pop('consent_scope', 'WhatsApp medication reminders')
        request = self.context.get('request')
        pharmacist = request.user if request and request.user.is_authenticated else None

        if not validated_data.get('pharmacy') and pharmacist and pharmacist.pharmacy:
            validated_data['pharmacy'] = pharmacist.pharmacy

        patient = Patient.objects.create(
            consent_status='consented',
            consent_recorded_at=timezone.now(),
            **validated_data
        )

        # Create initial consent record
        ConsentRecord.objects.create(
            patient=patient,
            consent_type='medication_reminders',
            status='active',
            scope=consent_scope,
            recording_method=consent_method,
            recorded_by=pharmacist
        )

        return patient


class WithdrawConsentSerializer(serializers.Serializer):
    reason = serializers.CharField(required=False, allow_blank=True, default="Patient requested opt-out")
