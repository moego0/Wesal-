import json
from datetime import time, timedelta
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient
from rest_framework import status

from accounts.models import Pharmacy, User
from accounts.authentication import generate_jwt_token
from patients.models import Patient, ConsentRecord
from medications.models import MedicationRecord, MedicationSchedule
from reminders.models import ReminderEvent, PatientResponse
from reminders.services import generate_daily_reminders, dispatch_due_reminders
from followups.models import FollowUpCase, PharmacistIntervention
from messaging.whatsapp_client import classify_patient_response, WhatsAppCloudApiClient
from messaging.webhook_processor import process_meta_webhook_payload


class WesalCorePlatformTests(TestCase):
    def setUp(self):
        self.client = APIClient()

        # Pharmacy 1
        self.pharmacy1 = Pharmacy.objects.create(
            name="Cairo Care Pharmacy",
            license_number="PHARM-001",
            phone="+201000000001",
            timezone="Africa/Cairo",
            quiet_hours_start=time(23, 0),
            quiet_hours_end=time(6, 0)
        )

        # Pharmacy 2 (For tenant isolation tests)
        self.pharmacy2 = Pharmacy.objects.create(
            name="Alexandria Health Pharmacy",
            license_number="PHARM-002",
            phone="+201000000002",
            timezone="Africa/Cairo"
        )

        # Users
        self.admin = User.objects.create_superuser(
            email="admin@wesal.test",
            password="adminpassword123",
            name="Admin User",
            role="admin"
        )

        self.pharmacist1 = User.objects.create_user(
            email="ph1@wesal.test",
            password="password123",
            name="Pharmacist One",
            role="pharmacist",
            pharmacy=self.pharmacy1
        )

        self.pharmacist2 = User.objects.create_user(
            email="ph2@wesal.test",
            password="password123",
            name="Pharmacist Two",
            role="pharmacist",
            pharmacy=self.pharmacy2
        )

        # Patients
        self.patient1 = Patient.objects.create(
            full_name="Patient In Cairo",
            phone_number="+201011112222",
            preferred_channel="whatsapp",
            preferred_language="ar",
            consent_status="consented",
            enrollment_status="active",
            pharmacy=self.pharmacy1,
            responsible_pharmacist=self.pharmacist1
        )
        ConsentRecord.objects.create(
            patient=self.patient1,
            consent_type="medication_reminders",
            status="active",
            recording_method="verbal_in_person",
            recorded_by=self.pharmacist1
        )

        self.patient2 = Patient.objects.create(
            full_name="Patient In Alexandria",
            phone_number="+201033334444",
            preferred_channel="whatsapp",
            preferred_language="ar",
            consent_status="consented",
            enrollment_status="active",
            pharmacy=self.pharmacy2,
            responsible_pharmacist=self.pharmacist2
        )

    # 1. Test Pharmacist Login and Auth
    def test_pharmacist_login_and_auth(self):
        res = self.client.post('/api/auth/login/', {
            'email': 'ph1@wesal.test',
            'password': 'password123'
        })
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertIn('token', res.data)
        self.assertIn('user', res.data)
        self.assertEqual(res.data['user']['email'], 'ph1@wesal.test')

    # 2. Test Pharmacy-level Record Isolation
    def test_pharmacy_record_isolation(self):
        token1 = generate_jwt_token(self.pharmacist1)
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {token1}')

        res = self.client.get('/api/patients/')
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        patient_ids = [p['id'] for p in res.data['results']]
        self.assertIn(str(self.patient1.id), patient_ids)
        self.assertNotIn(str(self.patient2.id), patient_ids)

    # 3. Test Patient Creation & Consent Withdrawal
    def test_patient_consent_withdrawal(self):
        token1 = generate_jwt_token(self.pharmacist1)
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {token1}')

        # Create medication and schedule for patient
        med = MedicationRecord.objects.create(
            patient=self.patient1,
            name="Amlodipine",
            dose="5",
            unit="mg",
            frequency_description="Daily morning",
            scheduled_times=["08:00"],
            status="active"
        )
        # Create scheduled reminder
        rem = ReminderEvent.objects.create(
            patient=self.patient1,
            medication_schedule=med.schedules.first(),
            scheduled_for=timezone.now() + timedelta(days=1),
            status="scheduled"
        )

        # Withdraw consent
        res = self.client.post(f'/api/patients/{self.patient1.id}/withdraw-consent/', {
            'reason': 'Patient requested stop'
        })
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        self.patient1.refresh_from_db()
        self.assertEqual(self.patient1.consent_status, 'withdrawn')
        self.assertEqual(self.patient1.enrollment_status, 'paused')

        # Check reminder cancelled
        rem.refresh_from_db()
        self.assertEqual(rem.status, 'cancelled')

    # 4. Test Medication Creation and Schedule Updates
    def test_medication_creation_and_schedule_sync(self):
        med = MedicationRecord.objects.create(
            patient=self.patient1,
            name="Metformin",
            dose="500",
            unit="mg",
            frequency_description="Twice daily",
            scheduled_times=["09:00", "21:00"],
            status="active"
        )
        self.assertEqual(med.schedules.filter(is_active=True).count(), 2)

        # Update times
        med.scheduled_times = ["09:00", "15:00", "21:00"]
        med.save()
        self.assertEqual(med.schedules.filter(is_active=True).count(), 3)

    # 5 & 6. Test Correct Reminder Scheduling and Idempotency (Duplicate Prevention)
    def test_reminder_scheduling_and_idempotency(self):
        MedicationRecord.objects.create(
            patient=self.patient1,
            name="Lipitor",
            dose="20",
            unit="mg",
            frequency_description="Daily",
            scheduled_times=["20:00"],
            status="active"
        )
        # Generate for today
        count1 = generate_daily_reminders()
        self.assertGreaterEqual(count1, 1)

        # Running a second time on same day should generate 0 duplicates
        count2 = generate_daily_reminders()
        self.assertEqual(count2, 0)

    # 7. Test Medication Discontinuation and Future Reminder Invalidation
    def test_medication_discontinuation_cancels_reminders(self):
        token1 = generate_jwt_token(self.pharmacist1)
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {token1}')

        med = MedicationRecord.objects.create(
            patient=self.patient1,
            name="Augmentin",
            dose="1",
            unit="g",
            frequency_description="Twice daily",
            scheduled_times=["12:00"],
            status="active"
        )
        rem = ReminderEvent.objects.create(
            patient=self.patient1,
            medication_schedule=med.schedules.first(),
            scheduled_for=timezone.now() + timedelta(hours=5),
            status="scheduled"
        )

        res = self.client.post(f'/api/medications/{med.id}/change-status/', {
            'status': 'discontinued',
            'reason': 'Course finished or allergy'
        })
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        rem.refresh_from_db()
        self.assertEqual(rem.status, 'cancelled')

    # 8. Test WhatsApp Response Classification
    def test_patient_response_classification(self):
        # Quick replies
        self.assertEqual(classify_patient_response("", "BTN_TAKEN")[0], "taken")
        self.assertEqual(classify_patient_response("", "BTN_TAKEN_LATE")[0], "taken_late")
        self.assertEqual(classify_patient_response("", "BTN_MISSED")[0], "missed")
        self.assertEqual(classify_patient_response("", "BTN_REMIND_LATER")[0], "remind_later")
        self.assertEqual(classify_patient_response("", "BTN_PROBLEM")[0], "problem")

        # Arabic text keywords
        self.assertEqual(classify_patient_response("تم أخذ الدواء الحمد لله")[0], "taken")
        self.assertEqual(classify_patient_response("اخذته متأخر")[0], "taken_late")
        self.assertEqual(classify_patient_response("لم اخد الدواء اليوم")[0], "missed")
        self.assertEqual(classify_patient_response("ذكرني كمان ساعة")[0], "remind_later")
        self.assertEqual(classify_patient_response("عندي مشكلة وتعب شديد في المعدة")[0], "problem")
        self.assertEqual(classify_patient_response("السلام عليكم")[0], "unknown")

    # 9. Test Webhook Verification Handshake
    def test_webhook_verification_handshake(self):
        res = self.client.get('/api/messaging/webhook/', {
            'hub.mode': 'subscribe',
            'hub.verify_token': 'wesal_webhook_verify_token_2026',
            'hub.challenge': 'challenge_code_xyz123'
        })
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.content.decode('utf-8'), 'challenge_code_xyz123')

        # Invalid token
        res_bad = self.client.get('/api/messaging/webhook/', {
            'hub.mode': 'subscribe',
            'hub.verify_token': 'wrong_token',
            'hub.challenge': 'challenge_code_xyz123'
        })
        self.assertEqual(res_bad.status_code, 403)

    # 10 & 11. Test Webhook Inbound Message and Interactive Button
    def test_inbound_webhook_processing(self):
        med = MedicationRecord.objects.create(
            patient=self.patient1,
            name="Crestor",
            dose="10",
            unit="mg",
            frequency_description="Daily",
            scheduled_times=["10:00"],
            status="active"
        )
        rem = ReminderEvent.objects.create(
            patient=self.patient1,
            medication_schedule=med.schedules.first(),
            scheduled_for=timezone.now() - timedelta(minutes=30),
            status="sent",
            provider_message_id="wamid.OUTBOUND_123"
        )

        inbound_payload = {
            "object": "whatsapp_business_account",
            "entry": [
                {
                    "id": "12345",
                    "changes": [
                        {
                            "field": "messages",
                            "value": {
                                "messaging_product": "whatsapp",
                                "contacts": [{"profile": {"name": "Patient"}, "wa_id": "201011112222"}],
                                "messages": [
                                    {
                                        "from": "201011112222",
                                        "id": "wamid.INBOUND_001",
                                        "timestamp": "1710000000",
                                        "type": "interactive",
                                        "interactive": {
                                            "type": "button_reply",
                                            "button_reply": {
                                                "id": "BTN_TAKEN",
                                                "title": "تم أخذ الدواء"
                                            }
                                        },
                                        "context": {
                                            "id": "wamid.OUTBOUND_123"
                                        }
                                    }
                                ]
                            }
                        }
                    ]
                }
            ]
        }

        result = process_meta_webhook_payload(inbound_payload)
        self.assertEqual(result['processed'], 1)

        # Check PatientResponse was created
        resp = PatientResponse.objects.filter(provider_message_id="wamid.INBOUND_001").first()
        self.assertIsNotNone(resp)
        self.assertEqual(resp.response_type, 'taken')
        self.assertEqual(resp.reminder, rem)

        rem.refresh_from_db()
        self.assertEqual(rem.status, 'responded')

        # Test duplicate idempotency
        result_duplicate = process_meta_webhook_payload(inbound_payload)
        self.assertEqual(PatientResponse.objects.filter(provider_message_id="wamid.INBOUND_001").count(), 1)

    # 12 & 14. Test Follow-up Alert Generation on Medication Problem
    def test_followup_alert_on_medication_problem(self):
        problem_payload = {
            "object": "whatsapp_business_account",
            "entry": [
                {
                    "id": "12345",
                    "changes": [
                        {
                            "field": "messages",
                            "value": {
                                "messaging_product": "whatsapp",
                                "contacts": [{"profile": {"name": "Patient"}, "wa_id": "201011112222"}],
                                "messages": [
                                    {
                                        "from": "201011112222",
                                        "id": "wamid.INBOUND_PROB_999",
                                        "timestamp": "1710000000",
                                        "type": "interactive",
                                        "interactive": {
                                            "type": "button_reply",
                                            "button_reply": {
                                                "id": "BTN_PROBLEM",
                                                "title": "لدي مشكلة مع الدواء"
                                            }
                                        }
                                    }
                                ]
                            }
                        }
                    ]
                }
            ]
        }

        process_meta_webhook_payload(problem_payload)

        # A follow-up case should have been automatically generated with priority 'urgent'
        case = FollowUpCase.objects.filter(
            patient=self.patient1,
            trigger_reason='medication_problem',
            status='open'
        ).first()
        self.assertIsNotNone(case)
        self.assertEqual(case.priority, 'urgent')

    # 15. Test Follow-up Documentation and Closure
    def test_followup_documentation_and_closure(self):
        token1 = generate_jwt_token(self.pharmacist1)
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {token1}')

        case = FollowUpCase.objects.create(
            patient=self.patient1,
            pharmacy=self.pharmacy1,
            trigger_reason='consecutive_missed',
            priority='medium',
            status='open',
            due_date=timezone.now().date()
        )

        # Record intervention
        res = self.client.post(f'/api/followups/{case.id}/add-intervention/', {
            'contact_attempted': True,
            'contact_method': 'phone_call',
            'patient_reported_reason': 'Busy during work hours',
            'action_taken': 'Adjusted dose timing to before leave for work',
            'referral_indicated': False,
            'outcome_notes': 'Patient agreed to new timing'
        })
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        case.refresh_from_db()
        self.assertEqual(case.status, 'in_progress')
        self.assertEqual(case.interventions.count(), 1)

        # Close case
        res_close = self.client.post(f'/api/followups/{case.id}/close/', {
            'closure_reason': 'Adherence restored, patient verified'
        })
        self.assertEqual(res_close.status_code, status.HTTP_200_OK)
        case.refresh_from_db()
        self.assertEqual(case.status, 'closed')

    # 16. Test CSV Export
    def test_csv_export_endpoint(self):
        token1 = generate_jwt_token(self.pharmacist1)
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {token1}')

        res = self.client.get('/api/analytics/export-patients/')
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertIn('text/csv', res['Content-Type'])
        content = res.content.decode('utf-8')
        self.assertIn('Patient Code', content)
        self.assertIn('Patient In Cairo', content)
        self.assertNotIn('Patient In Alexandria', content)
