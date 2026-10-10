'use client';

import React, { useState, useEffect } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { Patient } from '@/lib/types';
import { api } from '@/lib/api';
import {
  Smartphone,
  Send,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  MessageSquare,
  Bot,
  User,
  ShieldCheck,
  CheckCheck,
} from 'lucide-react';

interface WhatsAppSimulatorViewProps {
  initialPhone?: string;
  onSelectPatient?: (patientId: string) => void;
}

export const WhatsAppSimulatorView: React.FC<WhatsAppSimulatorViewProps> = ({
  initialPhone = '',
  onSelectPatient,
}) => {
  const { t, isRTL } = useLanguage();
  const [patients, setPatients] = useState<Patient[]>([]);
  const [selectedPhone, setSelectedPhone] = useState(initialPhone || '+201001234567');
  const [patientName, setPatientName] = useState('Mahmoud Hassan');
  const [customText, setCustomText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [simulationLogs, setSimulationLogs] = useState<any[]>([]);

  // Sample Chat Bubbles in Simulator
  const [chatMessages, setChatMessages] = useState<
    Array<{
      id: string;
      sender: 'bot' | 'user';
      text: string;
      buttons?: string[];
      timestamp: string;
    }>
  >([
    {
      id: '1',
      sender: 'bot',
      text: 'السلام عليكم محمود 👋\n\nحان موعد التذكير بالدواء المسجل في نظام وِصال (Concor 5mg).\n\nيرجى تسجيل ردك من الخيارات المتاحة:',
      buttons: [
        'تم أخذ الدواء',
        'أخذته متأخرًا',
        'لم آخذه',
        'ذكّرني لاحقًا',
        'لدي مشكلة مع الدواء',
      ],
      timestamp: '08:30 AM',
    },
  ]);

  useEffect(() => {
    const fetchPatients = async () => {
      try {
        const res = await api.getPatients();
        if (res.results && res.results.length > 0) {
          setPatients(res.results);
          if (!initialPhone) {
            setSelectedPhone(res.results[0].phone_number);
            setPatientName(res.results[0].full_name);
          }
        }
      } catch (err) {
        console.error('Error fetching patients for simulator:', err);
      }
    };
    fetchPatients();
  }, [initialPhone]);

  const handlePatientChange = (phone: string) => {
    setSelectedPhone(phone);
    const p = patients.find((pat) => pat.phone_number === phone);
    if (p) {
      setPatientName(p.full_name);
      // Reset chat preview for this patient
      setChatMessages([
        {
          id: String(Date.now()),
          sender: 'bot',
          text: `السلام عليكم ${p.full_name.split(' ')[0]} 👋\n\nحان موعد التذكير بالدواء المسجل في نظام وِصال.\n\nيرجى تسجيل ردك من الخيارات المتاحة:`,
          buttons: [
            'تم أخذ الدواء',
            'أخذته متأخرًا',
            'لم آخذه',
            'ذكّرني لاحقًا',
            'لدي مشكلة مع الدواء',
          ],
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    }
  };

  const sendInteractiveResponse = async (
    responseType: 'taken' | 'taken_late' | 'missed' | 'remind_later' | 'problem' | 'custom_text',
    textLabel: string
  ) => {
    setIsProcessing(true);
    const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Add user bubble
    setChatMessages((prev) => [
      ...prev,
      {
        id: String(Date.now()),
        sender: 'user',
        text: textLabel,
        timestamp: nowStr,
      },
    ]);

    try {
      const res = await api.simulateInboundWebhook({
        phone_number: selectedPhone,
        response_type: responseType,
        custom_text: textLabel,
      });

      setSimulationLogs((prev) => [
        {
          timestamp: new Date().toLocaleTimeString(),
          phone: selectedPhone,
          response_type: responseType,
          text: textLabel,
          result: res.result,
        },
        ...prev,
      ]);

      // Add automated bot acknowledgment
      let ackText = 'شكراً لك! تم تسجيل ردك بنجاح في سجل المتابعة لدى الصيدلية.';
      if (responseType === 'problem') {
        ackText = '⚠️ تم تسجيل الشكوى الدوائية وإرسال تنبيه عاجل للصيدلي المسؤول للتواصل معك ومساعدتك فوراً.';
      } else if (responseType === 'remind_later') {
        ackText = '⏰ تم تأجيل التذكير لمدة ساعة. سنقوم بتذكيرك لاحقاً.';
      } else if (responseType === 'missed') {
        ackText = 'تم تسجيل تفويت الجرعة. يرجى عدم مضاعفة الجرعة القادمة إلا باستشارة الصيدلي.';
      }

      setTimeout(() => {
        setChatMessages((prev) => [
          ...prev,
          {
            id: String(Date.now() + 1),
            sender: 'bot',
            text: ackText,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
        ]);
      }, 600);
    } catch (err: any) {
      alert(`Simulation Error: ${err.message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-teal-500/10 border border-teal-500/20 text-teal-400 flex items-center justify-center">
            <Smartphone className="w-4 h-4" />
          </div>
          <h2 className="text-xl font-bold text-slate-100">{t('simulator')}</h2>
          <span className="px-2 py-0.5 rounded-full bg-teal-500/10 border border-teal-500/20 text-teal-300 text-[10px] font-bold">
            Interactive Testbed
          </span>
        </div>
        <p className="text-xs text-slate-400 mt-1">
          Test real Meta WhatsApp webhook execution, Arabic interactive buttons, and custom symptoms without incurring Meta messaging fees.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Controls & Webhook Execution Logs (7 Cols) */}
        <div className="lg:col-span-7 space-y-6">
          {/* Target Patient Selector Card */}
          <div className="p-6 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-4 shadow-xl">
            <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
              <User className="w-4 h-4 text-emerald-400" />
              <span>1. Select Patient Session</span>
            </h3>

            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-300">Enrolled Patient</label>
              <select
                value={selectedPhone}
                onChange={(e) => handlePatientChange(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
              >
                {patients.map((p) => (
                  <option key={p.id} value={p.phone_number}>
                    {p.full_name} ({p.phone_number}) — [{p.consent_status}]
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Preset Inbound Actions */}
          <div className="p-6 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-4 shadow-xl">
            <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-teal-400" />
              <span>2. Trigger Patient Quick-Reply Webhooks</span>
            </h3>
            <p className="text-xs text-slate-400">
              Clicking below sends an authentic Meta Webhook payload to the backend with the exact button ID.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
              <button
                onClick={() => sendInteractiveResponse('taken', 'تم أخذ الدواء')}
                disabled={isProcessing}
                className="p-3 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 font-semibold flex items-center justify-between transition-all"
              >
                <span>BTN_TAKEN</span>
                <span className="text-xs">تم أخذ الدواء</span>
              </button>

              <button
                onClick={() => sendInteractiveResponse('taken_late', 'أخذته متأخرًا')}
                disabled={isProcessing}
                className="p-3 rounded-xl bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-cyan-300 font-semibold flex items-center justify-between transition-all"
              >
                <span>BTN_TAKEN_LATE</span>
                <span className="text-xs">أخذته متأخرًا</span>
              </button>

              <button
                onClick={() => sendInteractiveResponse('missed', 'لم آخذه')}
                disabled={isProcessing}
                className="p-3 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-300 font-semibold flex items-center justify-between transition-all"
              >
                <span>BTN_MISSED</span>
                <span className="text-xs">لم آخذه</span>
              </button>

              <button
                onClick={() => sendInteractiveResponse('remind_later', 'ذكّرني لاحقًا')}
                disabled={isProcessing}
                className="p-3 rounded-xl bg-teal-500/10 hover:bg-teal-500/20 border border-teal-500/30 text-teal-300 font-semibold flex items-center justify-between transition-all"
              >
                <span>BTN_REMIND_LATER</span>
                <span className="text-xs">ذكّرني لاحقًا</span>
              </button>

              <button
                onClick={() =>
                  sendInteractiveResponse('problem', 'لدي مشكلة مع الدواء: أشعر بألم شديد في المعدة')
                }
                disabled={isProcessing}
                className="sm:col-span-2 p-3 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-300 font-semibold flex items-center justify-between transition-all"
              >
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-rose-400" />
                  <span>BTN_PROBLEM (Triggers Urgent Follow-Up Alert)</span>
                </div>
                <span className="text-xs">لدي مشكلة مع الدواء</span>
              </button>
            </div>

            {/* Custom Text Inbound Message Input */}
            <div className="pt-4 border-t border-slate-800 space-y-2">
              <label className="block text-xs font-semibold text-slate-300">
                Or Type Custom Arabic Inbound WhatsApp Message:
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="e.g. نسيت الجرعة بسبب العمل / أشعر بدوخة بعد الدواء"
                  value={customText}
                  onChange={(e) => setCustomText(e.target.value)}
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-slate-200"
                />
                <button
                  onClick={() => {
                    if (!customText) return;
                    sendInteractiveResponse('custom_text', customText);
                    setCustomText('');
                  }}
                  disabled={!customText || isProcessing}
                  className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold disabled:opacity-50 transition-colors"
                >
                  Send Inbound
                </button>
              </div>
            </div>
          </div>

          {/* Webhook Execution Logs */}
          <div className="p-6 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-3 shadow-xl">
            <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Real-Time Webhook Engine Activity</span>
            </h3>

            {simulationLogs.length === 0 ? (
              <p className="text-xs text-slate-500 py-4 text-center">
                Click any interactive button above to see the backend webhook execution trace.
              </p>
            ) : (
              <div className="space-y-2 max-h-56 overflow-y-auto">
                {simulationLogs.map((log, idx) => (
                  <div key={idx} className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs font-mono space-y-1">
                    <div className="flex justify-between text-slate-400 text-[11px]">
                      <span>{log.timestamp} • {log.phone}</span>
                      <span className="text-emerald-400">HTTP 200 OK</span>
                    </div>
                    <p className="text-slate-200">Input: "{log.text}"</p>
                    <p className="text-teal-400 text-[11px]">Processed: {JSON.stringify(log.result)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Realistic WhatsApp Phone Mockup (5 Cols) */}
        <div className="lg:col-span-5 flex justify-center sticky top-20">
          <div className="w-full max-w-sm rounded-[36px] bg-slate-950 border-[6px] border-slate-800 shadow-2xl overflow-hidden flex flex-col h-[580px]">
            {/* Phone Speaker & Camera Notch */}
            <div className="h-6 bg-slate-900 flex items-center justify-center">
              <div className="w-16 h-3 bg-slate-950 rounded-full" />
            </div>

            {/* WhatsApp App Header */}
            <div className="bg-[#075E54] px-4 py-3 text-white flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center font-bold text-xs">
                و
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold truncate">Wesal Care • وِصال</p>
                <p className="text-[10px] text-emerald-200">Official Business Account ✓</p>
              </div>
            </div>

            {/* WhatsApp Chat Area */}
            <div className="flex-1 bg-[#0b141a] p-3 overflow-y-auto space-y-3 custom-scrollbar">
              {/* Encryption Banner */}
              <div className="p-2 rounded-lg bg-slate-900/90 text-center text-[10px] text-amber-200/80 border border-amber-500/10">
                🔒 Messages are end-to-end encrypted with WhatsApp Cloud API.
              </div>

              {chatMessages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl p-3 text-xs shadow-sm space-y-2 leading-relaxed ${
                      msg.sender === 'user'
                        ? 'bg-[#005c4b] text-slate-100 rounded-tr-none'
                        : 'bg-[#202c33] text-slate-100 rounded-tl-none'
                    }`}
                  >
                    <p className="whitespace-pre-line">{msg.text}</p>

                    {/* Interactive Quick Reply Buttons on Outbound template */}
                    {msg.buttons && (
                      <div className="pt-2 border-t border-slate-700/60 space-y-1.5">
                        {msg.buttons.map((btnTitle, bIdx) => {
                          const rType =
                            bIdx === 0
                              ? 'taken'
                              : bIdx === 1
                              ? 'taken_late'
                              : bIdx === 2
                              ? 'missed'
                              : bIdx === 3
                              ? 'remind_later'
                              : 'problem';

                          return (
                            <button
                              key={bIdx}
                              onClick={() => sendInteractiveResponse(rType, btnTitle)}
                              disabled={isProcessing}
                              className="w-full py-1.5 px-3 rounded-lg bg-slate-800/80 hover:bg-emerald-600/30 text-emerald-300 font-semibold text-[11px] border border-slate-700 hover:border-emerald-500/40 text-center transition-colors"
                            >
                              {btnTitle}
                            </button>
                          );
                        })}
                      </div>
                    )}

                    <div className="flex items-center justify-end gap-1 text-[9px] text-slate-400">
                      <span>{msg.timestamp}</span>
                      {msg.sender === 'user' && (
                        <CheckCheck className="w-3 h-3 text-cyan-400" />
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Bottom Bar */}
            <div className="p-2.5 bg-[#1f2c34] flex items-center gap-2 border-t border-slate-800">
              <input
                type="text"
                placeholder="رد عبر واتساب..."
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customText) {
                    sendInteractiveResponse('custom_text', customText);
                    setCustomText('');
                  }
                }}
                className="flex-1 bg-[#2a3942] rounded-full px-3.5 py-1.5 text-xs text-slate-100 focus:outline-none"
              />
              <button
                onClick={() => {
                  if (!customText) return;
                  sendInteractiveResponse('custom_text', customText);
                  setCustomText('');
                }}
                className="w-8 h-8 rounded-full bg-[#00a884] flex items-center justify-center text-slate-950"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
