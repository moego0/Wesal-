import csv
from datetime import timedelta
from django.http import HttpResponse
from django.utils import timezone
from django.db.models import Count, Q
from rest_framework import views, permissions
from rest_framework.response import Response
from accounts.permissions import IsPharmacyUser
from patients.models import Patient
from medications.models import MedicationRecord
from reminders.models import ReminderEvent, PatientResponse
from followups.models import FollowUpCase, PharmacistIntervention


class DashboardStatsView(views.APIView):
    permission_classes = [IsPharmacyUser]

    def get(self, request):
        user = request.user
        pharmacy = user.pharmacy if user.role != 'admin' else None
        now = timezone.now()
        today = now.date()

        # Patient querysets
        patient_qs = Patient.objects.all()
        if pharmacy:
            patient_qs = patient_qs.filter(pharmacy=pharmacy)

        total_enrolled_patients = patient_qs.count()
        active_patients = patient_qs.filter(enrollment_status='active', consent_status='consented').count()

        # Reminders today
        reminder_qs = ReminderEvent.objects.all()
        if pharmacy:
            reminder_qs = reminder_qs.filter(patient__pharmacy=pharmacy)

        reminders_today_qs = reminder_qs.filter(scheduled_for__date=today)
        reminders_scheduled_today = reminders_today_qs.count()
        reminders_delivered_today = reminders_today_qs.filter(status__in=['delivered', 'read', 'responded']).count()
        reminders_failed_today = reminders_today_qs.filter(status='failed').count()
        reminders_responded_today = reminders_today_qs.filter(status='responded').count()

        # Patient responses in last 7 days
        resp_qs = PatientResponse.objects.all()
        if pharmacy:
            resp_qs = resp_qs.filter(patient__pharmacy=pharmacy)

        last_7_days = now - timedelta(days=7)
        resp_last_7 = resp_qs.filter(received_at__gte=last_7_days)

        taken_count = resp_last_7.filter(response_type='taken').count()
        taken_late_count = resp_last_7.filter(response_type='taken_late').count()
        missed_count = resp_last_7.filter(response_type='missed').count()
        problem_count = resp_last_7.filter(response_type='problem').count()
        remind_later_count = resp_last_7.filter(response_type='remind_later').count()
        unknown_count = resp_last_7.filter(response_type='unknown').count()

        # Distinct patients reporting missed doses in last 7 days
        patients_reporting_missed = resp_last_7.filter(response_type='missed').values('patient').distinct().count()
        
        # Distinct patients reporting problems in last 7 days
        patients_reporting_problems = resp_last_7.filter(response_type='problem').values('patient').distinct().count()

        # Follow-up cases
        case_qs = FollowUpCase.objects.all()
        if pharmacy:
            case_qs = case_qs.filter(pharmacy=pharmacy)

        open_cases = case_qs.filter(status__in=['open', 'in_progress']).count()
        followups_due_today = case_qs.filter(status__in=['open', 'in_progress'], due_date=today).count()
        overdue_followups = case_qs.filter(status__in=['open', 'in_progress'], due_date__lt=today).count()
        urgent_cases = case_qs.filter(status__in=['open', 'in_progress'], priority__in=['high', 'urgent']).count()

        # Recent alerts (top 5 open cases)
        recent_cases = case_qs.filter(status__in=['open', 'in_progress']).select_related('patient').order_by('-priority', '-created_at')[:5]
        recent_alerts = [
            {
                'id': str(c.id),
                'patient_name': c.patient.full_name,
                'patient_phone': c.patient.phone_number,
                'trigger_reason': c.get_trigger_reason_display(),
                'priority': c.priority,
                'status': c.status,
                'due_date': c.due_date,
                'created_at': c.created_at
            }
            for c in recent_cases
        ]

        # Delivery rate calculation
        total_attempted_today = reminders_delivered_today + reminders_failed_today
        delivery_rate_today = round((reminders_delivered_today / total_attempted_today * 100), 1) if total_attempted_today > 0 else 100.0

        # Response rate calculation
        response_rate_today = round((reminders_responded_today / reminders_delivered_today * 100), 1) if reminders_delivered_today > 0 else 0.0

        return Response({
            'total_enrolled_patients': total_enrolled_patients,
            'active_patients': active_patients,
            'reminders_scheduled_today': reminders_scheduled_today,
            'reminders_delivered_today': reminders_delivered_today,
            'reminders_failed_today': reminders_failed_today,
            'reminders_responded_today': reminders_responded_today,
            'delivery_rate_today': delivery_rate_today,
            'response_rate_today': response_rate_today,
            'patients_reporting_missed': patients_reporting_missed,
            'patients_reporting_problems': patients_reporting_problems,
            'followups_due_today': followups_due_today,
            'overdue_followups': overdue_followups,
            'open_cases': open_cases,
            'urgent_cases': urgent_cases,
            'response_breakdown_7d': {
                'taken': taken_count,
                'taken_late': taken_late_count,
                'missed': missed_count,
                'problem': problem_count,
                'remind_later': remind_later_count,
                'unknown': unknown_count,
            },
            'recent_alerts': recent_alerts
        })


class ExportPatientsCsvView(views.APIView):
    permission_classes = [IsPharmacyUser]

    def get(self, request):
        user = request.user
        pharmacy = user.pharmacy if user.role != 'admin' else None

        qs = Patient.objects.all().select_related('pharmacy', 'responsible_pharmacist')
        if pharmacy:
            qs = qs.filter(pharmacy=pharmacy)

        response = HttpResponse(content_type='text/csv; charset=utf-8')
        response['Content-Disposition'] = f'attachment; filename="wesal_patients_{timezone.now().strftime("%Y%m%d_%H%M")}.csv"'
        response.write('\ufeff') # UTF-8 BOM for Arabic excel compatibility

        writer = csv.writer(response)
        writer.writerow(['Patient Code', 'Full Name', 'Phone Number', 'Consent Status', 'Language', 'Enrollment Status', 'Pharmacy', 'Responsible Pharmacist', 'Created At'])

        for p in qs:
            writer.writerow([
                p.patient_code,
                p.full_name,
                p.phone_number,
                p.consent_status,
                p.preferred_language,
                p.enrollment_status,
                p.pharmacy.name if p.pharmacy else '',
                p.responsible_pharmacist.name if p.responsible_pharmacist else '',
                p.created_at.strftime('%Y-%m-%d %H:%M')
            ])

        return response


class ExportFollowUpCasesCsvView(views.APIView):
    permission_classes = [IsPharmacyUser]

    def get(self, request):
        user = request.user
        pharmacy = user.pharmacy if user.role != 'admin' else None

        qs = FollowUpCase.objects.all().select_related('patient', 'pharmacy', 'assigned_pharmacist', 'closed_by')
        if pharmacy:
            qs = qs.filter(pharmacy=pharmacy)

        response = HttpResponse(content_type='text/csv; charset=utf-8')
        response['Content-Disposition'] = f'attachment; filename="wesal_followups_{timezone.now().strftime("%Y%m%d_%H%M")}.csv"'
        response.write('\ufeff')

        writer = csv.writer(response)
        writer.writerow(['Case ID', 'Patient Name', 'Phone', 'Trigger Reason', 'Priority', 'Status', 'Due Date', 'Notes', 'Assigned Pharmacist', 'Created At', 'Closed At', 'Closure Reason'])

        for c in qs:
            writer.writerow([
                str(c.id)[:8],
                c.patient.full_name,
                c.patient.phone_number,
                c.get_trigger_reason_display(),
                c.priority,
                c.status,
                c.due_date,
                c.trigger_notes,
                c.assigned_pharmacist.name if c.assigned_pharmacist else '',
                c.created_at.strftime('%Y-%m-%d %H:%M'),
                c.closed_at.strftime('%Y-%m-%d %H:%M') if c.closed_at else '',
                c.closure_reason or ''
            ])

        return response
