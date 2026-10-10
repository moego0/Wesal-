from rest_framework import serializers, viewsets, permissions
from .models import AuditEvent
from accounts.permissions import IsPharmacyUser


class AuditEventSerializer(serializers.ModelSerializer):
    user_name = serializers.CharField(source='user.name', read_only=True)
    pharmacy_name = serializers.CharField(source='pharmacy.name', read_only=True)

    class Meta:
        model = AuditEvent
        fields = [
            'id', 'pharmacy', 'pharmacy_name', 'user', 'user_name',
            'action', 'entity_type', 'entity_id', 'metadata',
            'ip_address', 'created_at'
        ]
        read_only_fields = fields


class AuditEventViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = AuditEventSerializer
    permission_classes = [IsPharmacyUser]

    def get_queryset(self):
        user = self.request.user
        if not user.is_authenticated:
            return AuditEvent.objects.none()

        qs = AuditEvent.objects.select_related('pharmacy', 'user')
        if user.role != 'admin' and user.pharmacy:
            qs = qs.filter(pharmacy=user.pharmacy)

        action = self.request.query_params.get('action')
        if action:
            qs = qs.filter(action__icontains=action)

        entity_type = self.request.query_params.get('entity_type')
        if entity_type:
            qs = qs.filter(entity_type=entity_type)

        return qs
