from django.contrib import admin
from django.urls import path, include
from django.http import JsonResponse
from rest_framework.routers import DefaultRouter

from accounts.views import (
    LoginView,
    CurrentUserView,
    PharmacyViewSet,
    UserViewSet,
)
from patients.views import (
    PatientViewSet,
    ConsentRecordViewSet,
)
from medications.views import (
    MedicationRecordViewSet,
    MedicationScheduleViewSet,
)
from reminders.views import (
    ReminderEventViewSet,
    PatientResponseViewSet,
)
from followups.views import (
    FollowUpCaseViewSet,
    PharmacistInterventionViewSet,
)
from audit.views import (
    AuditEventViewSet,
)
from messaging.views import (
    WhatsAppWebhookView,
    MessagingSettingsView,
    SendTestMessageView,
    SimulateInboundWebhookView,
    WhatsAppMessageLogViewSet,
)
from .analytics import (
    DashboardStatsView,
    ExportPatientsCsvView,
    ExportFollowUpCasesCsvView,
)

def api_root_view(request):
    return JsonResponse({
        'platform': 'Wesal (وِصال) API Backend',
        'status': 'online',
        'frontend_url': 'http://localhost:3000',
        'api_documentation': {
            'auth_login': '/api/auth/login/',
            'patients': '/api/patients/',
            'medications': '/api/medications/',
            'reminders': '/api/reminders/',
            'followups': '/api/followups/',
            'webhook': '/api/messaging/webhook/',
            'simulator': '/api/messaging/simulate-webhook/',
            'dashboard_analytics': '/api/analytics/dashboard/',
        }
    })

router = DefaultRouter()
router.register(r'pharmacies', PharmacyViewSet, basename='pharmacy')
router.register(r'users', UserViewSet, basename='user')
router.register(r'patients', PatientViewSet, basename='patient')
router.register(r'consents', ConsentRecordViewSet, basename='consent')
router.register(r'medications', MedicationRecordViewSet, basename='medication')
router.register(r'schedules', MedicationScheduleViewSet, basename='schedule')
router.register(r'reminders', ReminderEventViewSet, basename='reminder')
router.register(r'responses', PatientResponseViewSet, basename='response')
router.register(r'followups', FollowUpCaseViewSet, basename='followup')
router.register(r'interventions', PharmacistInterventionViewSet, basename='intervention')
router.register(r'audit-logs', AuditEventViewSet, basename='audit-log')
router.register(r'messaging/logs', WhatsAppMessageLogViewSet, basename='messaging-log')

urlpatterns = [
    path('', api_root_view, name='root'),
    path('admin/', admin.site.urls),
    
    # Auth endpoints
    path('api/auth/login/', LoginView.as_view(), name='auth-login'),
    path('api/auth/me/', CurrentUserView.as_view(), name='auth-me'),
    
    # WhatsApp Webhook & Integration endpoints
    path('api/messaging/webhook/', WhatsAppWebhookView.as_view(), name='whatsapp-webhook'),
    path('api/messaging/settings/', MessagingSettingsView.as_view(), name='messaging-settings'),
    path('api/messaging/send-test/', SendTestMessageView.as_view(), name='send-test-message'),
    path('api/messaging/simulate-webhook/', SimulateInboundWebhookView.as_view(), name='simulate-webhook'),
    
    # Analytics & Reports
    path('api/analytics/dashboard/', DashboardStatsView.as_view(), name='analytics-dashboard'),
    path('api/analytics/export-patients/', ExportPatientsCsvView.as_view(), name='export-patients-csv'),
    path('api/analytics/export-followups/', ExportFollowUpCasesCsvView.as_view(), name='export-followups-csv'),
    
    # Core REST Resources
    path('api/', include(router.urls)),
]
