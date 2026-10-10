import uuid
from django.db import models
from django.utils import timezone
from patients.models import Patient
from accounts.models import User


class MedicationRecord(models.Model):
    STATUS_CHOICES = [
        ('active', 'Active'),
        ('paused', 'Paused'),
        ('discontinued', 'Discontinued'),
        ('completed', 'Completed'),
    ]

    ROUTE_CHOICES = [
        ('oral', 'Oral (فموي)'),
        ('inhaled', 'Inhaled (استنشاق)'),
        ('topical', 'Topical (موضعي)'),
        ('sublingual', 'Sublingual (تحت اللسان)'),
        ('ophthalmic', 'Eye Drops (قطرة عين)'),
        ('nasal', 'Nasal Spray (بخاخ أنف)'),
        ('subcutaneous', 'Subcutaneous (حقن تحت الجلد)'),
        ('intramuscular', 'Intramuscular (حقن عضلي)'),
        ('other', 'Other (أخرى)'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    patient = models.ForeignKey(Patient, on_delete=models.CASCADE, related_name='medications')
    name = models.CharField(max_length=255)
    dose = models.CharField(max_length=50)
    unit = models.CharField(max_length=50, default='tablet')
    route = models.CharField(max_length=50, choices=ROUTE_CHOICES, default='oral')
    frequency_description = models.CharField(max_length=255, help_text="e.g. Once daily after breakfast")
    
    # List of time strings e.g. ["09:00", "21:00"]
    scheduled_times = models.JSONField(default=list)
    
    start_date = models.DateField(default=timezone.localdate)
    end_date = models.DateField(null=True, blank=True)
    is_chronic = models.BooleanField(default=False)
    
    prescription_reference = models.CharField(max_length=255, blank=True, null=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='active')
    status_change_reason = models.TextField(blank=True, null=True)
    
    special_instructions = models.TextField(blank=True, null=True)
    
    created_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name='created_medications')
    updated_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name='updated_medications')
    
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.name} {self.dose} {self.unit} - {self.patient.full_name} ({self.status})"

    def save(self, *args, **kwargs):
        is_new = self._state.adding
        super().save(*args, **kwargs)
        # Synchronize MedicationSchedules
        self.sync_schedules()

    def sync_schedules(self):
        """
        Creates or updates MedicationSchedule entries based on scheduled_times.
        If status is not active, deactivates schedules.
        """
        if self.status != 'active':
            self.schedules.update(is_active=False)
            return

        current_times = set(self.scheduled_times or [])
        existing_schedules = self.schedules.all()
        
        # Deactivate or delete schedules for removed times
        for schedule in existing_schedules:
            time_str = schedule.reminder_time.strftime('%H:%M')
            if time_str not in current_times:
                schedule.is_active = False
                schedule.save()
            else:
                if not schedule.is_active:
                    schedule.is_active = True
                    schedule.save()

        # Add new schedules
        existing_time_strs = {s.reminder_time.strftime('%H:%M') for s in existing_schedules if s.is_active}
        for time_str in current_times:
            if time_str not in existing_time_strs:
                try:
                    parts = time_str.split(':')
                    hour = int(parts[0])
                    minute = int(parts[1]) if len(parts) > 1 else 0
                    from datetime import time
                    MedicationSchedule.objects.create(
                        medication=self,
                        patient=self.patient,
                        reminder_time=time(hour=hour, minute=minute),
                        is_active=True
                    )
                except Exception:
                    continue


class MedicationSchedule(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    medication = models.ForeignKey(MedicationRecord, on_delete=models.CASCADE, related_name='schedules')
    patient = models.ForeignKey(Patient, on_delete=models.CASCADE, related_name='medication_schedules')
    reminder_time = models.TimeField()
    # Days of week: 1=Mon, 7=Sun or comma separated "1,2,3,4,5,6,7"
    days_of_week = models.CharField(max_length=20, default='1,2,3,4,5,6,7')
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['reminder_time']

    def __str__(self):
        return f"{self.medication.name} at {self.reminder_time.strftime('%H:%M')} for {self.patient.full_name}"
