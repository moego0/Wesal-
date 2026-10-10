import uuid
from django.db import models
from django.utils import timezone
from patients.models import Patient
from accounts.models import Pharmacy, User


class FollowUpCase(models.Model):
    TRIGGER_REASONS = [
        ('medication_problem', 'Medication Problem / Adverse Symptom Reported'),
        ('consecutive_missed', 'Repeated Missed Doses (Non-Adherence)'),
        ('repeated_delivery_failure', 'Repeated WhatsApp Delivery Failures'),
        ('overdue_check', 'Routine / Overdue Adherence Check'),
        ('manual_pharmacist', 'Manual Pharmacist Referral / Case'),
    ]

    PRIORITY_CHOICES = [
        ('low', 'Low Priority'),
        ('medium', 'Medium Priority'),
        ('high', 'High Priority'),
        ('urgent', 'Urgent Attention Needed'),
    ]

    STATUS_CHOICES = [
        ('open', 'Open (Awaiting Pharmacist)'),
        ('in_progress', 'In Progress (Contact Attempted)'),
        ('resolved', 'Resolved'),
        ('closed', 'Closed'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    patient = models.ForeignKey(Patient, on_delete=models.CASCADE, related_name='follow_up_cases')
    pharmacy = models.ForeignKey(Pharmacy, on_delete=models.CASCADE, related_name='follow_up_cases')
    
    trigger_reason = models.CharField(max_length=40, choices=TRIGGER_REASONS)
    priority = models.CharField(max_length=20, choices=PRIORITY_CHOICES, default='medium')
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='open', db_index=True)
    
    due_date = models.DateField(default=timezone.now)
    trigger_notes = models.TextField(blank=True, null=True, help_text="Explanation of why this case was triggered")
    
    assigned_pharmacist = models.ForeignKey(
        User, on_delete=models.SET_NULL, null=True, blank=True, related_name='assigned_cases'
    )
    
    closed_at = models.DateTimeField(null=True, blank=True)
    closed_by = models.ForeignKey(
        User, on_delete=models.SET_NULL, null=True, blank=True, related_name='closed_cases'
    )
    closure_reason = models.TextField(blank=True, null=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['pharmacy', 'status']),
            models.Index(fields=['priority', 'status']),
            models.Index(fields=['due_date']),
        ]

    def __str__(self):
        return f"Case #{str(self.id)[:8]} - {self.patient.full_name} ({self.get_trigger_reason_display()})"


class PharmacistIntervention(models.Model):
    CONTACT_METHODS = [
        ('phone_call', 'Phone Call (مكالمة هاتفية)'),
        ('in_person', 'In-Person Pharmacy Visit (زيارة شخصية بالصيدلية)'),
        ('whatsapp_chat', 'WhatsApp Direct Conversation (محادثة واتساب)'),
        ('other', 'Other (أخرى)'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    follow_up_case = models.ForeignKey(
        FollowUpCase, on_delete=models.CASCADE, related_name='interventions'
    )
    pharmacist = models.ForeignKey(
        User, on_delete=models.SET_NULL, null=True, blank=True, related_name='interventions'
    )
    
    contact_attempted = models.BooleanField(default=True)
    contact_method = models.CharField(max_length=30, choices=CONTACT_METHODS, default='phone_call')
    
    patient_reported_reason = models.TextField(
        blank=True, null=True,
        help_text="Patient reported barrier e.g. side effects, forgetfulness, timing issue, cost"
    )
    
    action_taken = models.TextField(
        help_text="Clinical/counseling action taken by pharmacist (e.g. explained taking with meals, clarified dosage schedule)"
    )
    
    referral_indicated = models.BooleanField(
        default=False,
        help_text="Check if patient was advised to visit/refer back to prescribing physician"
    )
    referral_notes = models.TextField(blank=True, null=True)
    
    next_follow_up_date = models.DateField(null=True, blank=True)
    outcome_notes = models.TextField(blank=True, null=True)
    
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"Intervention for Case #{str(self.follow_up_case.id)[:8]} by {self.pharmacist.name if self.pharmacist else 'Pharmacist'}"
