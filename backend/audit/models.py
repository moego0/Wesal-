import uuid
from django.db import models
from accounts.models import Pharmacy, User


class AuditEvent(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    pharmacy = models.ForeignKey(Pharmacy, on_delete=models.CASCADE, related_name='audit_events', null=True, blank=True)
    user = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name='audit_events')
    action = models.CharField(max_length=100)
    entity_type = models.CharField(max_length=50)
    entity_id = models.CharField(max_length=100, blank=True, null=True)
    metadata = models.JSONField(default=dict, blank=True)
    ip_address = models.CharField(max_length=45, blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['pharmacy', '-created_at']),
            models.Index(fields=['action']),
            models.Index(fields=['entity_type', 'entity_id']),
        ]

    def __str__(self):
        return f"{self.action} by {self.user.name if self.user else 'System'} at {self.created_at}"

    @classmethod
    def log(cls, pharmacy=None, user=None, action="", entity_type="", entity_id=None, metadata=None, ip_address=None):
        try:
            return cls.objects.create(
                pharmacy=pharmacy,
                user=user if user and user.is_authenticated else None,
                action=action,
                entity_type=entity_type,
                entity_id=str(entity_id) if entity_id else "",
                metadata=metadata or {},
                ip_address=ip_address
            )
        except Exception:
            return None
