import uuid
import phonenumbers
from django.db import models
from django.utils import timezone
from accounts.models import Pharmacy, User


def normalize_phone_number(raw_phone: str, default_region: str = "EG") -> str:
    if not raw_phone:
        return ""
    cleaned = raw_phone.strip()
    try:
        parsed = phonenumbers.parse(cleaned, default_region)
        if phonenumbers.is_valid_number(parsed):
            return phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)
    except Exception:
        pass
    # Fallback basic cleanup if phonenumbers fails
    digits = "".join(c for c in cleaned if c.isdigit() or c == "+")
    if digits.startswith("0") and len(digits) == 11 and default_region == "EG":
        return "+20" + digits[1:]
    if not digits.startswith("+") and len(digits) == 10:
        return "+20" + digits
    return digits


class Patient(models.Model):
    CONSENT_STATUS_CHOICES = [
        ('consented', 'Consented'),
        ('withdrawn', 'Consent Withdrawn'),
        ('pending', 'Pending Consent'),
        ('refused', 'Refused'),
    ]

    ENROLLMENT_STATUS_CHOICES = [
        ('active', 'Active'),
        ('paused', 'Paused'),
        ('discharged', 'Discharged / Completed'),
        ('inactive', 'Inactive'),
    ]

    LANGUAGE_CHOICES = [
        ('ar', 'Arabic (العربية)'),
        ('en', 'English'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    patient_code = models.CharField(max_length=50, blank=True, null=True)
    full_name = models.CharField(max_length=255)
    phone_number = models.CharField(max_length=30)
    preferred_channel = models.CharField(max_length=20, default='whatsapp')
    preferred_language = models.CharField(max_length=10, choices=LANGUAGE_CHOICES, default='ar')
    
    consent_status = models.CharField(max_length=20, choices=CONSENT_STATUS_CHOICES, default='consented')
    consent_recorded_at = models.DateTimeField(default=timezone.now)
    
    enrollment_status = models.CharField(max_length=20, choices=ENROLLMENT_STATUS_CHOICES, default='active')
    
    pharmacy = models.ForeignKey(Pharmacy, on_delete=models.CASCADE, related_name='patients')
    responsible_pharmacist = models.ForeignKey(
        User, on_delete=models.SET_NULL, null=True, blank=True, related_name='assigned_patients'
    )
    
    notes = models.TextField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']
        unique_together = [['pharmacy', 'phone_number']]

    def __str__(self):
        return f"{self.full_name} ({self.phone_number})"

    def save(self, *args, **kwargs):
        if self.phone_number:
            self.phone_number = normalize_phone_number(self.phone_number)
        if not self.patient_code:
            # Generate short code
            self.patient_code = f"PAT-{uuid.uuid4().hex[:6].upper()}"
        super().save(*args, **kwargs)

    @property
    def has_active_consent(self) -> bool:
        return self.consent_status == 'consented' and self.enrollment_status == 'active'


class ConsentRecord(models.Model):
    CONSENT_METHOD_CHOICES = [
        ('verbal_in_person', 'Verbal (In-Person at Pharmacy)'),
        ('written_form', 'Written Form Signed'),
        ('digital_opt_in', 'Digital WhatsApp Opt-In'),
        ('phone_call', 'Verbal via Phone Call'),
    ]

    STATUS_CHOICES = [
        ('active', 'Active'),
        ('withdrawn', 'Withdrawn'),
        ('expired', 'Expired'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    patient = models.ForeignKey(Patient, on_delete=models.CASCADE, related_name='consent_records')
    consent_type = models.CharField(max_length=50, default='medication_reminders')
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='active')
    scope = models.CharField(max_length=255, default='WhatsApp medication reminders & adherence follow-up')
    recording_method = models.CharField(max_length=50, choices=CONSENT_METHOD_CHOICES, default='verbal_in_person')
    recorded_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True)
    recorded_at = models.DateTimeField(default=timezone.now)
    
    withdrawn_at = models.DateTimeField(null=True, blank=True)
    withdrawal_reason = models.TextField(blank=True, null=True)
    notes = models.TextField(blank=True, null=True)

    class Meta:
        ordering = ['-recorded_at']

    def __str__(self):
        return f"Consent for {self.patient.full_name} ({self.status})"
