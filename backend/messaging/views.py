import json
import logging
import uuid
from django.conf import settings
from django.http import HttpResponse, JsonResponse
from rest_framework import views, viewsets, status, permissions
from rest_framework.response import Response
from rest_framework.decorators import api_view, permission_classes
from .models import WhatsAppMessageLog, WebhookEventLog
from .serializers import (
    WhatsAppMessageLogSerializer,
    WebhookEventLogSerializer,
    SendTestMessageSerializer,
    SimulateInboundWebhookSerializer
)
from .whatsapp_client import WhatsAppCloudApiClient
from .webhook_processor import process_meta_webhook_payload
from accounts.permissions import IsPharmacyUser, IsPlatformAdmin
from patients.models import normalize_phone_number

logger = logging.getLogger(__name__)


class WhatsAppWebhookView(views.APIView):
    """
    Official Meta WhatsApp Business Webhook Endpoint.
    GET: Webhook Verification handshake with Meta servers.
    POST: Processes inbound status updates and patient message responses.
    """
    permission_classes = [permissions.AllowAny]
    authentication_classes = []

    def get(self, request):
        mode = request.GET.get('hub.mode')
        token = request.GET.get('hub.verify_token')
        challenge = request.GET.get('hub.challenge')

        configured_token = getattr(settings, 'WHATSAPP_VERIFY_TOKEN', 'wesal_webhook_verify_token_2026')

        if mode == 'subscribe' and token == configured_token:
            logger.info("Meta Webhook verification handshake successful.")
            return HttpResponse(challenge, content_type='text/plain', status=200)

        logger.warning(f"Meta Webhook verification failed. Received mode={mode}, token={token}")
        return HttpResponse('Verification token mismatch', status=403)

    def post(self, request):
        client = WhatsAppCloudApiClient()
        raw_body = request.body
        signature = request.headers.get('X-Hub-Signature-256', '')

        # Verify HMAC signature when app secret is present or in production
        if not getattr(settings, 'DEBUG', False) and client.app_secret:
            if not client.verify_webhook_signature(raw_body, signature):
                logger.warning("Invalid Webhook HMAC SHA256 Signature.")
                return HttpResponse('Invalid signature', status=401)

        try:
            payload = json.loads(raw_body.decode('utf-8'))
        except Exception as e:
            return JsonResponse({'error': f'Malformed JSON: {str(e)}'}, status=400)

        result = process_meta_webhook_payload(payload)
        return JsonResponse({'status': 'ok', 'result': result}, status=200)


class MessagingSettingsView(views.APIView):
    permission_classes = [IsPharmacyUser]

    def get(self, request):
        client = WhatsAppCloudApiClient()
        return Response({
            'is_configured': bool(client.access_token and client.phone_number_id),
            'mock_mode': client.mock_mode,
            'api_version': client.api_version,
            'phone_number_id': client.phone_number_id,
            'access_token': client.access_token[:10] + '...' if client.access_token else '',
            'business_account_id': getattr(settings, 'WHATSAPP_BUSINESS_ACCOUNT_ID', ''),
            'default_template_name': getattr(settings, 'WHATSAPP_DEFAULT_TEMPLATE_NAME', 'wesal_medication_reminder'),
            'default_language_code': getattr(settings, 'WHATSAPP_DEFAULT_LANGUAGE_CODE', 'ar'),
            'webhook_verify_token': getattr(settings, 'WHATSAPP_VERIFY_TOKEN', 'wesal_webhook_verify_token_2026'),
            'app_secret': getattr(settings, 'WHATSAPP_APP_SECRET', ''),
        })

    def post(self, request):
        token = request.data.get('access_token')
        phone_id = request.data.get('phone_number_id')
        waba_id = request.data.get('business_account_id')
        app_secret = request.data.get('app_secret')
        verify_token = request.data.get('webhook_verify_token')
        template_name = request.data.get('default_template_name')

        if token is not None:
            settings.WHATSAPP_ACCESS_TOKEN = token
        if phone_id is not None:
            settings.WHATSAPP_PHONE_NUMBER_ID = phone_id
        if waba_id is not None:
            settings.WHATSAPP_BUSINESS_ACCOUNT_ID = waba_id
        if app_secret is not None:
            settings.WHATSAPP_APP_SECRET = app_secret
        if verify_token is not None:
            settings.WHATSAPP_VERIFY_TOKEN = verify_token
        if template_name is not None:
            settings.WHATSAPP_DEFAULT_TEMPLATE_NAME = template_name

        # Update mock mode based on token presence
        settings.WHATSAPP_MOCK_MODE = not bool(settings.WHATSAPP_ACCESS_TOKEN)

        return Response({
            'status': 'Settings updated successfully',
            'is_configured': bool(settings.WHATSAPP_ACCESS_TOKEN and settings.WHATSAPP_PHONE_NUMBER_ID),
            'mock_mode': settings.WHATSAPP_MOCK_MODE
        })


class SendTestMessageView(views.APIView):
    permission_classes = [IsPharmacyUser]

    def post(self, request):
        serializer = SendTestMessageSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        phone = normalize_phone_number(serializer.validated_data['phone_number'])
        patient_name = serializer.validated_data.get('patient_name', 'Patient')
        template_name = serializer.validated_data.get('template_name')
        lang = serializer.validated_data.get('language_code', 'ar')

        client = WhatsAppCloudApiClient()
        res = client.send_medication_reminder(
            to_phone=phone,
            patient_name=patient_name,
            template_name=template_name,
            language_code=lang
        )

        return Response(res, status=status.HTTP_200_OK if res.get('success') else status.HTTP_400_BAD_REQUEST)


class SimulateInboundWebhookView(views.APIView):
    """
    Developer / Testing utility to simulate real Meta Webhook events
    (Patient clicking quick replies or sending Arabic text messages).
    """
    permission_classes = [IsPharmacyUser]

    def post(self, request):
        serializer = SimulateInboundWebhookSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        phone = normalize_phone_number(serializer.validated_data['phone_number'])
        response_type = serializer.validated_data['response_type']
        custom_text = serializer.validated_data.get('custom_text', '')
        reminder_id = serializer.validated_data.get('reminder_id', '')

        # Button ID mapping
        button_map = {
            'taken': ('BTN_TAKEN', 'تم أخذ الدواء'),
            'taken_late': ('BTN_TAKEN_LATE', 'أخذته متأخرًا'),
            'missed': ('BTN_MISSED', 'لم آخذه'),
            'remind_later': ('BTN_REMIND_LATER', 'ذكّرني لاحقًا'),
            'problem': ('BTN_PROBLEM', 'لدي مشكلة مع الدواء'),
        }

        button_id, default_text = button_map.get(response_type, ('', custom_text or 'رد'))
        body_text = custom_text if custom_text else default_text

        # Create synthetic Meta Webhook payload
        synthetic_wamid = f"wamid.INBOUND_{uuid.uuid4().hex[:16].upper()}"
        synthetic_payload = {
            "object": "whatsapp_business_account",
            "entry": [
                {
                    "id": "100000000000000",
                    "changes": [
                        {
                            "value": {
                                "messaging_product": "whatsapp",
                                "metadata": {
                                    "display_phone_number": "201000000000",
                                    "phone_number_id": "100000000000001"
                                },
                                "contacts": [
                                    {
                                        "profile": {"name": "Patient Simulator"},
                                        "wa_id": phone.replace("+", "")
                                    }
                                ],
                                "messages": [
                                    {
                                        "from": phone.replace("+", ""),
                                        "id": synthetic_wamid,
                                        "timestamp": "1710000000",
                                        "type": "interactive" if button_id else "text",
                                        "interactive": {
                                            "type": "button_reply",
                                            "button_reply": {
                                                "id": button_id,
                                                "title": body_text
                                            }
                                        } if button_id else None,
                                        "text": {"body": body_text} if not button_id else None,
                                        "context": {
                                            "id": f"wamid.ORIG_{reminder_id}" if reminder_id else None
                                        } if reminder_id else None
                                    }
                                ]
                            },
                            "field": "messages"
                        }
                    ]
                }
            ]
        }

        # Process through official webhook pipeline
        result = process_meta_webhook_payload(synthetic_payload)
        return Response({
            'message': 'Simulated webhook processed successfully',
            'simulated_wamid': synthetic_wamid,
            'result': result
        })


class WhatsAppMessageLogViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = WhatsAppMessageLogSerializer
    permission_classes = [IsPharmacyUser]
    queryset = WhatsAppMessageLog.objects.all()

    def get_queryset(self):
        qs = WhatsAppMessageLog.objects.all()
        phone = self.request.query_params.get('phone')
        if phone:
            qs = qs.filter(phone_number__icontains=phone)
        direction = self.request.query_params.get('direction')
        if direction:
            qs = qs.filter(direction=direction)
        return qs
