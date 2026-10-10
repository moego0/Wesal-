from datetime import datetime, time, timedelta
from django.core.management.base import BaseCommand
from django.utils import timezone
from accounts.models import Pharmacy, User
from patients.models import Patient, ConsentRecord
from medications.models import MedicationRecord, MedicationSchedule
from reminders.models import ReminderEvent, PatientResponse
from followups.models import FollowUpCase, PharmacistIntervention
from audit.models import AuditEvent


class Command(BaseCommand):
    help = 'Seeds realistic healthcare demonstration data for Wesal'

    def handle(self, *args, **options):
        self.stdout.write("Clearing previous demo records...")
        # Clear existing non-admin data if any
        Patient.objects.all().delete()
        Pharmacy.objects.all().delete()
        User.objects.all().delete()

        self.stdout.write("Creating Primary Pharmacy & Pharmacists...")
        pharmacy = Pharmacy.objects.create(
            name="Al-Shifa Community Pharmacy (صيدلية الشفاء النموذجية)",
            license_number="PHARM-EG-2024-8849",
            phone="+20227954120",
            address="14 Tahrir St, Downtown, Cairo, Egypt",
            timezone="Africa/Cairo",
            quiet_hours_start=time(22, 0),
            quiet_hours_end=time(8, 0),
            max_daily_reminders_per_patient=4
        )

        admin_user = User.objects.create_superuser(
            email="admin@wesal.care",
            password="adminpassword123",
            name="Dr. Tarek El-Sayed (Admin)",
            phone="+201001112222",
            role="admin"
        )

        pharmacist = User.objects.create_user(
            email="pharmacist@wesal.care",
            password="pharmacist123",
            name="Pharm. Sarah Mahmoud",
            phone="+201009988776",
            role="pharmacist",
            pharmacy=pharmacy
        )

        second_pharmacist = User.objects.create_user(
            email="ahmed.pharm@wesal.care",
            password="pharmacist123",
            name="Pharm. Ahmed Mostafa",
            phone="+201005544332",
            role="pharmacist",
            pharmacy=pharmacy
        )

        self.stdout.write("Creating Patients with varied adherence profiles...")
        now = timezone.now()
        today = now.date()

        # Patient 1: Highly Adherent Hypertensive Patient
        p1 = Patient.objects.create(
            full_name="Mahmoud Hassan Ibrahim (محمود حسن إبراهيم)",
            phone_number="+201001234567",
            preferred_channel="whatsapp",
            preferred_language="ar",
            consent_status="consented",
            enrollment_status="active",
            pharmacy=pharmacy,
            responsible_pharmacist=pharmacist,
            notes="Chronic hypertension patient. Well-managed, highly responsive."
        )
        ConsentRecord.objects.create(
            patient=p1,
            consent_type="medication_reminders",
            status="active",
            recording_method="verbal_in_person",
            recorded_by=pharmacist,
            scope="WhatsApp reminders for morning and evening antihypertensive doses."
        )

        m1 = MedicationRecord.objects.create(
            patient=p1,
            name="Concor (Bisoprolol)",
            dose="5",
            unit="mg",
            route="oral",
            frequency_description="Once daily in the morning after breakfast",
            scheduled_times=["08:30"],
            start_date=today - timedelta(days=30),
            is_chronic=True,
            prescription_reference="Cardiology Clinic - Dr. Hazem",
            status="active",
            created_by=pharmacist,
            updated_by=pharmacist
        )

        # Patient 2: Diabetic Patient Reporting Missed Doses
        p2 = Patient.objects.create(
            full_name="Fatma Ali El-Ghamry (فاطمة علي الغمري)",
            phone_number="+201019876543",
            preferred_channel="whatsapp",
            preferred_language="ar",
            consent_status="consented",
            enrollment_status="active",
            pharmacy=pharmacy,
            responsible_pharmacist=pharmacist,
            notes="Type 2 Diabetes. Frequently forgets evening dose when visiting family."
        )
        ConsentRecord.objects.create(
            patient=p2,
            consent_type="medication_reminders",
            status="active",
            recording_method="written_form",
            recorded_by=pharmacist,
            scope="WhatsApp reminders for Glucophage morning and evening."
        )

        m2 = MedicationRecord.objects.create(
            patient=p2,
            name="Glucophage (Metformin)",
            dose="1000",
            unit="mg",
            route="oral",
            frequency_description="Twice daily with main meals",
            scheduled_times=["09:00", "20:00"],
            start_date=today - timedelta(days=20),
            is_chronic=True,
            prescription_reference="Endocrinology Center - Dr. Nader",
            status="active",
            created_by=pharmacist,
            updated_by=pharmacist
        )

        # Patient 3: Patient with Medication Problem (Gastric Distress)
        p3 = Patient.objects.create(
            full_name="Hassan Gamal Abdel-Rahman (حسن جمال عبد الرحمن)",
            phone_number="+201123456789",
            preferred_channel="whatsapp",
            preferred_language="ar",
            consent_status="consented",
            enrollment_status="active",
            pharmacy=pharmacy,
            responsible_pharmacist=second_pharmacist,
            notes="Initiated NSAID therapy for acute orthopedic inflammation. Reported stomach pain."
        )
        ConsentRecord.objects.create(
            patient=p3,
            consent_type="medication_reminders",
            status="active",
            recording_method="verbal_in_person",
            recorded_by=second_pharmacist,
            scope="Short-term medication follow-up"
        )

        m3 = MedicationRecord.objects.create(
            patient=p3,
            name="Voltaren (Diclofenac Potassium)",
            dose="50",
            unit="mg",
            route="oral",
            frequency_description="Twice daily after food for 10 days",
            scheduled_times=["10:00", "21:00"],
            start_date=today - timedelta(days=4),
            end_date=today + timedelta(days=6),
            is_chronic=False,
            prescription_reference="Orthopedics - Dr. Sherif",
            status="active",
            created_by=second_pharmacist,
            updated_by=second_pharmacist
        )

        # Patient 4: Patient who Withdrew Consent
        p4 = Patient.objects.create(
            full_name="Omar Khaled Soliman (عمر خالد سليمان)",
            phone_number="+201209871234",
            preferred_channel="whatsapp",
            preferred_language="ar",
            consent_status="withdrawn",
            enrollment_status="paused",
            pharmacy=pharmacy,
            responsible_pharmacist=pharmacist,
            notes="Requested opt-out due to changing phone number."
        )
        ConsentRecord.objects.create(
            patient=p4,
            consent_type="medication_reminders",
            status="withdrawn",
            recording_method="verbal_in_person",
            recorded_by=pharmacist,
            withdrawn_at=now - timedelta(days=2),
            withdrawal_reason="Patient requested communication pause"
        )

        self.stdout.write("Generating Historical Reminders and Responses...")

        # Past reminders for Patient 1 (Taken)
        schedules_p1 = m1.schedules.first()
        for d in range(1, 4):
            rem_date = now - timedelta(days=d)
            rem = ReminderEvent.objects.create(
                patient=p1,
                medication_schedule=schedules_p1,
                scheduled_for=rem_date.replace(hour=8, minute=30, second=0),
                status='responded',
                provider_message_id=f"wamid.DEMO_P1_D{d}",
                sent_at=rem_date.replace(hour=8, minute=30, second=5),
                delivered_at=rem_date.replace(hour=8, minute=30, second=15),
                read_at=rem_date.replace(hour=8, minute=32, second=0),
                responded_at=rem_date.replace(hour=8, minute=35, second=0)
            )
            PatientResponse.objects.create(
                patient=p1,
                reminder=rem,
                response_type='taken',
                raw_content="تم أخذ الدواء",
                button_id="BTN_TAKEN",
                provider_message_id=f"wamid.RESP_P1_D{d}",
                is_linked=True,
                review_status='processed',
                received_at=rem_date.replace(hour=8, minute=35, second=0)
            )

        # Past reminders for Patient 2 (Consecutive Missed)
        schedules_p2 = m2.schedules.all()
        for idx, sched in enumerate(schedules_p2):
            rem_date = now - timedelta(days=1)
            rem = ReminderEvent.objects.create(
                patient=p2,
                medication_schedule=sched,
                scheduled_for=rem_date.replace(hour=sched.reminder_time.hour, minute=sched.reminder_time.minute),
                status='responded',
                provider_message_id=f"wamid.DEMO_P2_{idx}",
                sent_at=rem_date.replace(hour=sched.reminder_time.hour, minute=sched.reminder_time.minute, second=3),
                delivered_at=rem_date.replace(hour=sched.reminder_time.hour, minute=sched.reminder_time.minute, second=10),
                read_at=rem_date.replace(hour=sched.reminder_time.hour, minute=sched.reminder_time.minute, second=25),
                responded_at=rem_date.replace(hour=sched.reminder_time.hour, minute=sched.reminder_time.minute + 10)
            )
            PatientResponse.objects.create(
                patient=p2,
                reminder=rem,
                response_type='missed',
                raw_content="لم آخذه - نسيت القرص في المنزل",
                button_id="BTN_MISSED",
                provider_message_id=f"wamid.RESP_P2_{idx}",
                is_linked=True,
                review_status='processed',
                received_at=rem_date.replace(hour=sched.reminder_time.hour, minute=sched.reminder_time.minute + 10)
            )

        # Past reminder for Patient 3 (Problem Reported)
        schedules_p3 = m3.schedules.first()
        rem_p3 = ReminderEvent.objects.create(
            patient=p3,
            medication_schedule=schedules_p3,
            scheduled_for=now - timedelta(hours=3),
            status='responded',
            provider_message_id="wamid.DEMO_P3_PROB",
            sent_at=now - timedelta(hours=3),
            delivered_at=now - timedelta(hours=3) + timedelta(seconds=12),
            read_at=now - timedelta(hours=3) + timedelta(seconds=45),
            responded_at=now - timedelta(hours=2, minutes=50)
        )
        resp_p3 = PatientResponse.objects.create(
            patient=p3,
            reminder=rem_p3,
            response_type='problem',
            raw_content="لدي مشكلة مع الدواء: أشعر بألم شديد وحرقة في فم المعدة بعد تناوله",
            button_id="BTN_PROBLEM",
            provider_message_id="wamid.RESP_P3_PROB",
            is_linked=True,
            review_status='flagged_for_review',
            received_at=now - timedelta(hours=2, minutes=50)
        )

        # Today's Scheduled Reminders
        for sched in m1.schedules.all():
            ReminderEvent.objects.create(
                patient=p1,
                medication_schedule=sched,
                scheduled_for=now.replace(hour=sched.reminder_time.hour, minute=sched.reminder_time.minute, second=0),
                status='scheduled'
            )

        for sched in m2.schedules.all():
            ReminderEvent.objects.create(
                patient=p2,
                medication_schedule=sched,
                scheduled_for=now.replace(hour=sched.reminder_time.hour, minute=sched.reminder_time.minute, second=0),
                status='scheduled'
            )

        self.stdout.write("Creating Follow-up Cases and Interventions...")
        # Follow-up Case for Patient 3 (Urgent Problem)
        case_p3 = FollowUpCase.objects.create(
            patient=p3,
            pharmacy=pharmacy,
            trigger_reason='medication_problem',
            priority='urgent',
            status='open',
            due_date=today,
            trigger_notes="URGENT: Patient reported severe epigastric burning pain after taking Voltaren 50mg.",
            assigned_pharmacist=second_pharmacist
        )

        # Follow-up Case for Patient 2 (Non-adherence) with documented intervention
        case_p2 = FollowUpCase.objects.create(
            patient=p2,
            pharmacy=pharmacy,
            trigger_reason='consecutive_missed',
            priority='high',
            status='in_progress',
            due_date=today + timedelta(days=3),
            trigger_notes="Patient missed 2 consecutive Glucophage doses due to schedule changes.",
            assigned_pharmacist=pharmacist
        )

        PharmacistIntervention.objects.create(
            follow_up_case=case_p2,
            pharmacist=pharmacist,
            contact_attempted=True,
            contact_method='phone_call',
            patient_reported_reason="Patient forgot medication when visiting family away from home.",
            action_taken="Explained clinical risks of blood glucose fluctuations. Advised carrying a portable pill organizer in purse. Adjusted reminder times to align with her actual dinner time.",
            referral_indicated=False,
            next_follow_up_date=today + timedelta(days=3),
            outcome_notes="Patient understood and agreed to set evening reminder with alarm."
        )

        # Audit events
        AuditEvent.log(
            pharmacy=pharmacy,
            user=admin_user,
            action="system.seed_demo_data",
            entity_type="system",
            metadata={"patients_seeded": 4, "pharmacies_seeded": 1}
        )

        self.stdout.write(self.style.SUCCESS("Demo database seeded successfully!"))
        self.stdout.write(self.style.SUCCESS("Admin login: admin@wesal.care / adminpassword123"))
        self.stdout.write(self.style.SUCCESS("Pharmacist login: pharmacist@wesal.care / pharmacist123"))
