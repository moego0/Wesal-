'use client';

import React, { useState, useEffect } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { api } from '@/lib/api';
import {
  Settings,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  Key,
  Smartphone,
  Globe,
  Copy,
  ExternalLink,
  Moon,
  Clock,
  Save,
  Send,
  RefreshCw,
} from 'lucide-react';

export const SettingsView: React.FC = () => {
  const { t, isRTL } = useLanguage();
  const [settingsData, setSettingsData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  // Form State
  const [formData, setFormData] = useState({
    access_token: '',
    phone_number_id: '',
    business_account_id: '',
    app_secret: '',
    webhook_verify_token: 'wesal_webhook_verify_token_2026',
    default_template_name: 'wesal_medication_reminder',
  });

  // Test Message State
  const [testPhone, setTestPhone] = useState('+201001234567');
  const [testName, setTestName] = useState('Patient Test');
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const fetchSettings = async () => {
    setIsLoading(true);
    try {
      const res = await api.getMessagingSettings();
      setSettingsData(res);
      setFormData({
        access_token: res.access_token || '',
        phone_number_id: res.phone_number_id || '',
        business_account_id: res.business_account_id || '',
        app_secret: res.app_secret || '',
        webhook_verify_token: res.webhook_verify_token || 'wesal_webhook_verify_token_2026',
        default_template_name: res.default_template_name || 'wesal_medication_reminder',
      });
    } catch (err) {
      console.error('Error loading messaging settings:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  const webhookUrl = 'https://api.wesal.care/api/messaging/webhook/';

  const handleCopyWebhook = () => {
    navigator.clipboard.writeText(webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setSaveNotice(null);
    try {
      const res = await api.updateMessagingSettings(formData);
      setSaveNotice('WhatsApp Cloud API configuration saved successfully.');
      fetchSettings();
      setTimeout(() => setSaveNotice(null), 5000);
    } catch (err: any) {
      alert(`Error saving credentials: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSendTestMessage = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await api.sendTestMessage({
        phone_number: testPhone,
        patient_name: testName,
      });
      setTestResult(`✓ Success! Message ID: ${res.provider_message_id || 'Delivered'}`);
    } catch (err: any) {
      setTestResult(`✗ Failed: ${err.message}`);
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Header */}
      <div>
        <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
          <Settings className="w-5 h-5 text-emerald-400" />
          <span>{t('settings')} & WhatsApp Cloud API Gateway</span>
        </h2>
        <p className="text-xs text-slate-400 mt-0.5">
          Configure production Meta WhatsApp Business credentials, verify webhook signatures, and quiet hours.
        </p>
      </div>

      {saveNotice && (
        <div className="p-3.5 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2 animate-in fade-in">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{saveNotice}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: API Credentials & Setup (7 Cols) */}
        <div className="lg:col-span-7 space-y-6">
          <form onSubmit={handleSaveSettings} className="p-6 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-4 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <Key className="w-4 h-4 text-emerald-400" />
                <span>Meta WhatsApp Cloud API Credentials</span>
              </h3>
              <span
                className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                  settingsData?.is_configured
                    ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
                    : 'bg-amber-500/10 text-amber-300 border border-amber-500/20'
                }`}
              >
                {settingsData?.is_configured ? 'Configured & Active' : 'Setup Required'}
              </span>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  System User Permanent Access Token (WHATSAPP_ACCESS_TOKEN)
                </label>
                <input
                  type="password"
                  placeholder="EAABw..."
                  value={formData.access_token}
                  onChange={(e) => setFormData({ ...formData, access_token: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-slate-200 font-mono focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">
                    Phone Number ID (WHATSAPP_PHONE_NUMBER_ID)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. 100000000000001"
                    value={formData.phone_number_id}
                    onChange={(e) => setFormData({ ...formData, phone_number_id: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-slate-200 font-mono focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label className="block text-slate-300 font-semibold mb-1">
                    WhatsApp Business Account ID (WABA ID)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. 200000000000002"
                    value={formData.business_account_id}
                    onChange={(e) => setFormData({ ...formData, business_account_id: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-slate-200 font-mono focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">
                    Meta App Secret (HMAC SHA-256 Signature Verification)
                  </label>
                  <input
                    type="password"
                    placeholder="App secret from Meta dashboard"
                    value={formData.app_secret}
                    onChange={(e) => setFormData({ ...formData, app_secret: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-slate-200 font-mono focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label className="block text-slate-300 font-semibold mb-1">
                    Default Approved Template Name
                  </label>
                  <input
                    type="text"
                    placeholder="wesal_medication_reminder"
                    value={formData.default_template_name}
                    onChange={(e) => setFormData({ ...formData, default_template_name: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-slate-200 font-mono focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div className="pt-3 flex justify-end">
                <button
                  type="submit"
                  disabled={isSaving}
                  className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center gap-2 shadow-lg shadow-emerald-900/30 transition-all disabled:opacity-50"
                >
                  <Save className="w-4 h-4" />
                  <span>{isSaving ? 'Saving...' : 'Save API Credentials'}</span>
                </button>
              </div>
            </div>
          </form>

          {/* Test Live Sending Card */}
          <div className="p-6 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-4 shadow-xl">
            <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
              <Send className="w-4 h-4 text-teal-400" />
              <span>Test Live WhatsApp Message Delivery</span>
            </h3>
            <p className="text-xs text-slate-400">
              Send a test reminder template directly to a real patient WhatsApp number to verify API connectivity.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Recipient Phone Number (E.164)</label>
                <input
                  type="text"
                  placeholder="+201012345678"
                  value={testPhone}
                  onChange={(e) => setTestPhone(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200 font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Patient Greeting Name</label>
                <input
                  type="text"
                  placeholder="Patient Name"
                  value={testName}
                  onChange={(e) => setTestName(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200"
                />
              </div>
            </div>

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={handleSendTestMessage}
                disabled={isTesting || !testPhone}
                className="px-4 py-2 rounded-xl bg-teal-600 hover:bg-teal-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-all disabled:opacity-50"
              >
                <Send className="w-3.5 h-3.5" />
                <span>{isTesting ? 'Sending...' : 'Send Live Test'}</span>
              </button>

              {testResult && (
                <span className={`text-xs font-mono ${testResult.startsWith('✓') ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {testResult}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Webhook Setup & Quiet Hours (5 Cols) */}
        <div className="lg:col-span-5 space-y-6">
          {/* Webhook Configuration Card */}
          <div className="p-6 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-4 shadow-xl">
            <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
              <Globe className="w-4 h-4 text-emerald-400" />
              <span>Meta Webhook Configuration</span>
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              In Meta App Dashboard &gt; WhatsApp &gt; Configuration, configure your webhook endpoint:
            </p>

            <div className="space-y-3 text-xs font-mono">
              <div className="space-y-1">
                <span className="text-slate-400 font-sans">Callback URL (Webhook Endpoint):</span>
                <div className="flex items-center gap-2 p-2.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-200">
                  <span className="truncate flex-1 text-[11px]">{webhookUrl}</span>
                  <button
                    type="button"
                    onClick={handleCopyWebhook}
                    className="p-1 hover:bg-slate-800 rounded text-emerald-400"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div className="space-y-1">
                <span className="text-slate-400 font-sans">Verify Token:</span>
                <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 text-emerald-300 truncate text-[11px]">
                  {formData.webhook_verify_token}
                </div>
              </div>
            </div>
          </div>

          {/* Quiet Hours & Patient Protection Policy */}
          <div className="p-6 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-4 shadow-xl">
            <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
              <Moon className="w-4 h-4 text-cyan-400" />
              <span>Quiet Hours & Patient Safety Protocol</span>
            </h3>

            <div className="space-y-3 text-xs text-slate-300">
              <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 space-y-1">
                <div className="flex items-center gap-2 font-semibold text-slate-200">
                  <Clock className="w-3.5 h-3.5 text-teal-400" />
                  <span>Configured Quiet Hours: 22:00 — 08:00 (Cairo Time)</span>
                </div>
                <p className="text-slate-400 leading-relaxed">
                  Nighttime reminders are safely postponed until morning to avoid patient disruption.
                </p>
              </div>

              <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 space-y-1">
                <div className="flex items-center gap-2 font-semibold text-slate-200">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Pre-Send Verification Protocol</span>
                </div>
                <p className="text-slate-400 leading-relaxed">
                  Re-validates consent, active enrollment, and active medication status before every outbound message.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
