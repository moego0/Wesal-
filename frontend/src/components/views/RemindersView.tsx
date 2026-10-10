'use client';

import React, { useState, useEffect } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { ReminderEvent } from '@/lib/types';
import { api } from '@/lib/api';
import {
  BellRing,
  CheckCircle2,
  Clock,
  Send,
  AlertCircle,
  Ban,
  RefreshCw,
  Search,
  Eye,
  MessageSquare,
  PlayCircle,
  Phone,
} from 'lucide-react';

interface RemindersViewProps {
  onSelectPatient?: (patientId: string) => void;
}

export const RemindersView: React.FC<RemindersViewProps> = ({ onSelectPatient }) => {
  const { t, isRTL } = useLanguage();
  const [reminders, setReminders] = useState<ReminderEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const loadReminders = async () => {
    setIsLoading(true);
    try {
      const params: Record<string, string> = {};
      if (statusFilter) params.status = statusFilter;
      const res = await api.getReminders(params);
      setReminders(res.results || []);
    } catch (err) {
      console.error('Error loading reminders:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadReminders();
  }, [statusFilter]);

  const handleSendNow = async (id: string) => {
    try {
      const res = await api.sendReminderNow(id);
      setActionNotice(`Reminder sent immediately to ${res.reminder.patient_name}`);
      loadReminders();
    } catch (err: any) {
      alert(`Error sending reminder: ${err.message}`);
    }
  };

  const handleTriggerCycle = async () => {
    try {
      const res = await api.triggerReminderCycle();
      setActionNotice(`Reminder cycle executed: ${res.generated_count} generated, ${res.dispatch_summary?.sent || 0} sent.`);
      loadReminders();
    } catch (err: any) {
      alert(`Error running dispatch cycle: ${err.message}`);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Header and Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <BellRing className="w-5 h-5 text-emerald-400" />
            <span>{t('reminders')} & WhatsApp Dispatch Log</span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Real-time status of scheduled, submitted, delivered, and responded medication reminders.
          </p>
        </div>

        <button
          onClick={handleTriggerCycle}
          className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-semibold shadow-md flex items-center gap-2 transition-all self-start sm:self-auto"
        >
          <PlayCircle className="w-4 h-4" />
          <span>{t('triggerCycle')}</span>
        </button>
      </div>

      {actionNotice && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 px-4 py-3 rounded-2xl flex items-center justify-between text-xs animate-in fade-in">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{actionNotice}</span>
          </div>
          <button onClick={() => setActionNotice(null)} className="text-slate-400 hover:text-slate-200">✕</button>
        </div>
      )}

      {/* Filters */}
      <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-300 focus:outline-none focus:border-emerald-500/50"
          >
            <option value="">All Statuses ({reminders.length})</option>
            <option value="scheduled">{t('scheduled')}</option>
            <option value="sent">{t('sent')}</option>
            <option value="delivered">{t('delivered')}</option>
            <option value="read">{t('read')}</option>
            <option value="responded">{t('responded')}</option>
            <option value="failed">{t('failed')}</option>
            <option value="cancelled">{t('cancelled')}</option>
          </select>
        </div>

        <button
          onClick={loadReminders}
          className="p-2 bg-slate-800 hover:bg-slate-700 rounded-xl text-slate-300 transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Reminders Table */}
      <div className="rounded-2xl bg-slate-900/80 border border-slate-800 overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-start text-xs">
            <thead className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold uppercase tracking-wider">
              <tr>
                <th className="px-5 py-3.5 text-start">Patient & Medication</th>
                <th className="px-5 py-3.5 text-start">Scheduled For</th>
                <th className="px-5 py-3.5 text-start">Status</th>
                <th className="px-5 py-3.5 text-start">Provider Message ID</th>
                <th className="px-5 py-3.5 text-start">Delivered / Read At</th>
                <th className="px-5 py-3.5 text-end">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-300">
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center text-slate-400">
                    <div className="flex justify-center items-center gap-2">
                      <RefreshCw className="w-4 h-4 animate-spin text-emerald-400" />
                      <span>Loading reminders log...</span>
                    </div>
                  </td>
                </tr>
              ) : reminders.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center text-slate-500 space-y-2">
                    <BellRing className="w-8 h-8 mx-auto opacity-50 text-slate-400" />
                    <p className="font-semibold text-slate-400">No reminder events found</p>
                    <p className="text-[11px] text-slate-500">Run the dispatch cycle to generate today's reminders.</p>
                  </td>
                </tr>
              ) : (
                reminders.map((rem) => {
                  const isDelivered = ['delivered', 'read', 'responded'].includes(rem.status);
                  const isFailed = rem.status === 'failed';
                  const isScheduled = rem.status === 'scheduled';

                  return (
                    <tr key={rem.id} className="hover:bg-slate-800/40 transition-colors">
                      {/* Patient & Med */}
                      <td className="px-5 py-4">
                        <div>
                          <p
                            onClick={() => onSelectPatient && onSelectPatient(rem.patient)}
                            className="font-bold text-slate-100 hover:text-emerald-300 cursor-pointer text-sm transition-colors"
                          >
                            {rem.patient_name}
                          </p>
                          <p className="text-xs text-emerald-400 font-medium">
                            {rem.medication_name} {rem.dose_info && `(${rem.dose_info})`}
                          </p>
                        </div>
                      </td>

                      {/* Scheduled Time */}
                      <td className="px-5 py-4 font-mono text-slate-300">
                        {new Date(rem.scheduled_for).toLocaleString()}
                      </td>

                      {/* Status */}
                      <td className="px-5 py-4">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border ${
                            rem.status === 'responded'
                              ? 'bg-cyan-500/10 text-cyan-300 border-cyan-500/20'
                              : isDelivered
                              ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20'
                              : isScheduled
                              ? 'bg-blue-500/10 text-blue-300 border-blue-500/20'
                              : isFailed
                              ? 'bg-rose-500/10 text-rose-300 border-rose-500/20'
                              : 'bg-slate-800 text-slate-400 border-slate-700'
                          }`}
                        >
                          <span className="w-1.5 h-1.5 rounded-full bg-current" />
                          <span>{t(rem.status)}</span>
                        </span>
                        {rem.error_message && (
                          <p className="text-[10px] text-rose-400 mt-1 max-w-[200px] truncate" title={rem.error_message}>
                            {rem.error_message}
                          </p>
                        )}
                      </td>

                      {/* Provider Message ID */}
                      <td className="px-5 py-4 font-mono text-[11px] text-slate-400 truncate max-w-[160px]">
                        {rem.provider_message_id || '—'}
                      </td>

                      {/* Delivered / Read timestamp */}
                      <td className="px-5 py-4 text-slate-400 font-mono text-[11px]">
                        {rem.delivered_at
                          ? new Date(rem.delivered_at).toLocaleTimeString()
                          : rem.sent_at
                          ? new Date(rem.sent_at).toLocaleTimeString()
                          : '—'}
                      </td>

                      {/* Action */}
                      <td className="px-5 py-4 text-end">
                        {isScheduled && (
                          <button
                            onClick={() => handleSendNow(rem.id)}
                            className="px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 text-xs font-semibold transition-colors flex items-center gap-1 inline-flex"
                          >
                            <Send className="w-3 h-3" />
                            <span>Send Now</span>
                          </button>
                        )}
                        {isFailed && (
                          <button
                            onClick={() => handleSendNow(rem.id)}
                            className="px-3 py-1.5 rounded-lg bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-500/30 text-xs font-semibold transition-colors flex items-center gap-1 inline-flex"
                          >
                            <RefreshCw className="w-3 h-3" />
                            <span>Retry</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
