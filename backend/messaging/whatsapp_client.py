import hmac
import hashlib
import json
import logging
import uuid
import requests
from django.conf import settings
from django.utils import timezone
from .models import WhatsAppMessageLog

logger = logging.getLogger(__name__)


class WhatsAppCloudApiClient:
    def __init__(self):
        self.access_token = getattr(settings, 'WHATSAPP_ACCESS_TOKEN', '')
        self.phone_number_id = getattr(settings, 'WHATSAPP_PHONE_NUMBER_ID', '')
        self.api_version = getattr(settings, 'WHATSAPP_API_VERSION', 'v21.0')
        self.verify_token = getattr(settings, 'WHATSAPP_VERIFY_TOKEN', '')
        self.app_secret = getattr(settings, 'WHATSAPP_APP_SECRET', '')
        self.mock_mode = getattr(settings, 'WHATSAPP_MOCK_MODE', False) or not bool(self.access_token)
        self.base_url = f"https://graph.facebook.com/{self.api_version}/{self.phone_number_id}"

    def verify_webhook_signature(self, raw_body: bytes, signature_header: str) -> bool:
        """
        Verifies X-Hub-Signature-256 header using SHA256 HMAC and APP_SECRET.
        """
        if not self.app_secret:
            # If no app secret is configured, allow in development/mock mode
            return getattr(settings, 'DEBUG', False)
        if not signature_header or not signature_header.startswith('sha256='):
            return False

        expected_sig = signature_header.split('sha256=')[1]
        calculated_sig = hmac.new(
            key=self.app_secret.encode('utf-8'),
            msg=raw_body,
            digestmod=hashlib.sha256
        ).hexdigest()

        return hmac.compare_digest(expected_sig, calculated_sig)

    def send_medication_reminder(
        self,
        to_phone: str,
        patient_name: str,
        template_name: str = None,
        language_code: str = 'ar',
        reminder_event_id: str = None
    ) -> dict:
        """
        Sends an approved WhatsApp reminder template message to the patient.
        """
        template_name = template_name or getattr(settings, 'WHATSAPP_DEFAULT_TEMPLATE_NAME', 'wesal_medication_reminder')
        
        # Build Meta Cloud API payload
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to_phone.replace("+", "").strip(),
            "type": "template",
            "template": {
                "name": template_name,
                "language": {
                    "code": language_code
                },
                "components": [
                    {
                        "type": "body",
                        "parameters": [
                            {
                                "type": "text",
                                "text": patient_name
                            }
                        ]
                    }
                ]
            }
        }

        # If Mock Mode is active, generate a simulated success response
        if self.mock_mode:
            simulated_id = f"wamid.MOCK_{uuid.uuid4().hex[:16].upper()}"
            simulated_response = {
                "messaging_product": "whatsapp",
                "contacts": [{"input": to_phone, "wa_id": to_phone.replace("+", "").strip()}],
                "messages": [{"id": simulated_id, "message_status": "accepted"}],
                "mock_mode": True
            }
            WhatsAppMessageLog.objects.create(
                direction='outbound',
                phone_number=to_phone,
                provider_message_id=simulated_id,
                template_name=template_name,
                status='submitted',
                payload=payload,
                response_body=simulated_response
            )
            return {
                "success": True,
                "provider_message_id": simulated_id,
                "response": simulated_response,
                "is_mock": True
            }

        # Live Meta Cloud API Request
        url = f"{self.base_url}/messages"
        headers = {
            "Authorization": f"Bearer {self.access_token}",
            "Content-Type": "application/json"
        }

        try:
            response = requests.post(url, json=payload, headers=headers, timeout=10)
            data = response.json()
            status_code = response.status_code

            if status_code in (200, 201) and "messages" in data:
                provider_id = data["messages"][0]["id"]
                WhatsAppMessageLog.objects.create(
                    direction='outbound',
                    phone_number=to_phone,
                    provider_message_id=provider_id,
                    template_name=template_name,
                    status='submitted',
                    payload=payload,
                    response_body=data
                )
                return {
                    "success": True,
                    "provider_message_id": provider_id,
                    "response": data,
                    "is_mock": False
                }
            else:
                error_msg = json.dumps(data.get("error", data))
                WhatsAppMessageLog.objects.create(
                    direction='outbound',
                    phone_number=to_phone,
                    provider_message_id=None,
                    template_name=template_name,
                    status='failed',
                    payload=payload,
                    response_body=data,
                    error_details=error_msg
                )
                return {
                    "success": False,
                    "error": error_msg,
                    "status_code": status_code,
                    "response": data
                }
        except requests.RequestException as exc:
            error_msg = f"HTTP Network Error: {str(exc)}"
            WhatsAppMessageLog.objects.create(
                direction='outbound',
                phone_number=to_phone,
                provider_message_id=None,
                template_name=template_name,
                status='failed',
                payload=payload,
                error_details=error_msg
            )
            return {
                "success": False,
                "error": error_msg,
                "is_network_error": True
            }


# Response classifier utility for patient text & interactive button clicks
def classify_patient_response(payload_text: str, button_id: str = None) -> tuple[str, str]:
    """
    Classifies raw inbound text or interactive button ID into a normalized response type:
    ('taken', 'taken_late', 'missed', 'remind_later', 'problem', 'unknown')
    and returns (response_type, normalized_label).
    """
    if button_id:
        btn_upper = button_id.upper()
        if 'REMIND_LATER' in btn_upper or 'LATER' in btn_upper or 'SNOOZE' in btn_upper:
            return ('remind_later', 'Remind Later')
        if 'TAKEN_LATE' in btn_upper or 'LATE' in btn_upper:
            return ('taken_late', 'Taken Late')
        if 'TAKEN' in btn_upper or 'DONE' in btn_upper:
            return ('taken', 'Taken')
        if 'MISSED' in btn_upper or 'SKIP' in btn_upper:
            return ('missed', 'Missed')
        if 'PROBLEM' in btn_upper or 'ISSUE' in btn_upper or 'HELP' in btn_upper:
            return ('problem', 'Medication Problem')

    text = (payload_text or "").strip().lower()

    # 1. Medication Problem / Side Effects (High Priority)
    if any(k in text for k in ['مشكلة', 'تعب', 'تعبان', 'دوخة', 'مغص', 'ألم', 'الم', 'حساسية', 'طوارئ', 'problem', 'issue', 'sick', 'hurt', '5']):
        return ('problem', 'Medication Problem')

    # 2. Missed / Skipped / Negation
    if any(k in text for k in ['لم اخذ', 'لم آخذ', 'لم اخد', 'لم أخد', 'ما اخدت', 'ما أخذت', 'ما خدت', 'نسيت', 'missed', 'skip', 'forgot', '3']):
        return ('missed', 'Missed')

    # 3. Remind Later / Snooze
    if any(k in text for k in ['ذكرني', 'ذكرنى', 'لاحقا', 'لاحقاً', 'بعدين', 'كمان شوية', 'remind', 'later', 'snooze', '4']):
        return ('remind_later', 'Remind Later')

    # 4. Taken Late
    if any(k in text for k in ['متاخر', 'متأخر', 'أخذته متأخرا', 'اخذته متاخر', 'late', '2']):
        return ('taken_late', 'Taken Late')

    # 5. Taken / Completed
    if any(k in text for k in ['اخذت', 'أخذت', 'اخدت', 'أخدت', 'تم', 'تمام', 'الحمد لله', 'نعم', 'ايوه', 'done', 'taken', 'yes', '1']):
        return ('taken', 'Taken')

    if text == 'لا' or text == 'no':
        return ('missed', 'Missed')

    return ('unknown', 'Unknown Response')
