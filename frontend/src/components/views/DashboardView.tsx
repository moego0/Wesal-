'use client';

import React from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { DashboardStats } from '@/lib/types';
import {
  Users,
  BellRing,
  CheckCircle,
  AlertTriangle,
  Flame,
  ArrowUpRight,
  Sparkles,
  TrendingUp,
  Clock,
  Send,
  HelpCircle,
  PhoneCall,
  Activity,
} from 'lucide-react';

interface DashboardViewProps {
  stats: DashboardStats | null;
  onNavigate: (tab: string, filter?: string) => void;
  onSelectPatient?: (patientId: string) => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  stats,
  onNavigate,
  onSelectPatient,
}) => {
  const { t, isRTL } = useLanguage();

  if (!stats) {
    return (
      <div className="p-8 flex items-center justify-center min-h-[400px]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin" />
          <p className="text-sm text-slate-400">Loading live clinical dashboard...</p>
        </div>
      </div>
    );
  }

  const statCards = [
    {
      title: t('totalEnrolled'),
      value: stats.total_enrolled_patients,
      subValue: `${stats.active_patients} ${t('active')}`,
      icon: Users,
      color: 'from-blue-500/20 to-indigo-500/10 text-blue-400 border-blue-500/30',
      action: () => onNavigate('patients'),
    },
    {
      title: t('remindersToday'),
      value: stats.reminders_scheduled_today,
      subValue: `${stats.reminders_delivered_today} ${t('deliveredReminders')}`,
      icon: BellRing,
      color: 'from-emerald-500/20 to-teal-500/10 text-emerald-400 border-emerald-500/30',
      action: () => onNavigate('reminders'),
    },
    {
      title: t('problemReports'),
      value: stats.patients_reporting_problems,
      subValue: stats.patients_reporting_problems > 0 ? 'Requires pharmacist assessment' : 'No adverse complaints',
      icon: Flame,
      color: 'from-rose-500/20 to-orange-500/10 text-rose-400 border-rose-500/30',
      isUrgent: stats.patients_reporting_problems > 0,
      action: () => onNavigate('followups', 'problem'),
    },
    {
      title: t('missedReports'),
      value: stats.patients_reporting_missed,
      subValue: 'Missed dose alerts (7d)',
      icon: AlertTriangle,
      color: 'from-amber-500/20 to-yellow-500/10 text-amber-400 border-amber-500/30',
      action: () => onNavigate('followups', 'missed'),
    },
  ];

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      {/* Top Banner / Welcome */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 border border-slate-700/60 p-6 lg:p-8 shadow-xl">
        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="max-w-2xl space-y-2">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-semibold">
              <Activity className="w-3.5 h-3.5" />
              <span>Wesal WhatsApp Follow-Up Engine</span>
            </div>
            <h2 className="text-2xl lg:text-3xl font-bold text-slate-100">
              {t('appTagline')}
            </h2>
            <p className="text-sm text-slate-400 leading-relaxed">
              Automated post-dispense WhatsApp reminders, patient response tracking, and pharmacist intervention workflow for Egypt community pharmacies.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => onNavigate('patients')}
              className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-semibold transition-all flex items-center gap-2"
            >
              <Users className="w-4 h-4 text-emerald-400" />
              <span>{t('patients')}</span>
            </button>
            <button
              onClick={() => onNavigate('reminders')}
              className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-semibold shadow-lg shadow-emerald-900/30 transition-all flex items-center gap-2"
            >
              <BellRing className="w-4 h-4" />
              <span>{t('reminders')}</span>
            </button>
          </div>
        </div>

        {/* Subtle decorative glow */}
        <div className="absolute -end-10 -bottom-10 w-64 h-64 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
      </div>

      {/* 4 Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((card, idx) => {
          const Icon = card.icon;
          return (
            <div
              key={idx}
              onClick={card.action}
              className={`relative overflow-hidden rounded-2xl bg-slate-900/80 border p-5 transition-all duration-200 hover:-translate-y-1 hover:shadow-xl cursor-pointer ${card.color}`}
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-medium text-slate-400">{card.title}</span>
                <div className="p-2 rounded-xl bg-slate-800/80 border border-slate-700/60">
                  <Icon className="w-4 h-4" />
                </div>
              </div>
              <div className="space-y-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-extrabold text-slate-100 tracking-tight">{card.value}</span>
                  {card.isUrgent && (
                    <span className="px-2 py-0.5 rounded-md bg-rose-500/20 text-rose-300 text-[10px] font-bold border border-rose-500/30 animate-pulse">
                      Urgent
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-400 font-medium">{card.subValue}</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Secondary Row: Rates & Alerts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Delivery & Response Performance */}
        <div className="rounded-2xl bg-slate-900/80 border border-slate-800 p-6 space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-emerald-400" />
              <span>Messaging Performance</span>
            </h3>
            <span className="text-xs text-slate-400">Today</span>
          </div>

          <div className="space-y-5">
            {/* Delivery Rate */}
            <div>
              <div className="flex justify-between text-xs font-semibold mb-2">
                <span className="text-slate-400">{t('deliveryRate')}</span>
                <span className="text-emerald-400">{stats.delivery_rate_today}%</span>
              </div>
              <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all duration-500"
                  style={{ width: `${Math.min(100, Math.max(0, stats.delivery_rate_today))}%` }}
                />
              </div>
            </div>

            {/* Response Rate */}
            <div>
              <div className="flex justify-between text-xs font-semibold mb-2">
                <span className="text-slate-400">{t('responseRate')}</span>
                <span className="text-cyan-400">{stats.response_rate_today}%</span>
              </div>
              <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-cyan-500 to-blue-400 rounded-full transition-all duration-500"
                  style={{ width: `${Math.min(100, Math.max(0, stats.response_rate_today))}%` }}
                />
              </div>
            </div>
          </div>

          {/* Response Type Breakdown Mini Badges */}
          <div className="pt-4 border-t border-slate-800/80">
            <p className="text-xs font-medium text-slate-400 mb-3">7-Day Response Breakdown:</p>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 flex justify-between items-center">
                <span>{t('taken')}</span>
                <span className="font-bold">{stats.response_breakdown_7d?.taken || 0}</span>
              </div>
              <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 flex justify-between items-center">
                <span>{t('missed')}</span>
                <span className="font-bold">{stats.response_breakdown_7d?.missed || 0}</span>
              </div>
              <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 flex justify-between items-center">
                <span>{t('problem')}</span>
                <span className="font-bold">{stats.response_breakdown_7d?.problem || 0}</span>
              </div>
              <div className="p-2.5 rounded-xl bg-teal-500/10 border border-teal-500/20 text-teal-300 flex justify-between items-center">
                <span>{t('remindLater')}</span>
                <span className="font-bold">{stats.response_breakdown_7d?.remind_later || 0}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Urgent Follow-Up Alerts (2 Cols) */}
        <div className="lg:col-span-2 rounded-2xl bg-slate-900/80 border border-slate-800 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400" />
                <span>{t('urgentAlerts')} & Follow-Up Queue</span>
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                {stats.open_cases} open cases ({stats.urgent_cases} urgent / high priority)
              </p>
            </div>
            <button
              onClick={() => onNavigate('followups')}
              className="text-xs text-emerald-400 hover:text-emerald-300 font-semibold flex items-center gap-1 transition-colors"
            >
              <span>View all cases</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="space-y-3">
            {stats.recent_alerts && stats.recent_alerts.length > 0 ? (
              stats.recent_alerts.map((alert) => (
                <div
                  key={alert.id}
                  onClick={() => onNavigate('followups')}
                  className="p-4 rounded-xl bg-slate-800/60 hover:bg-slate-800 border border-slate-700/60 transition-all cursor-pointer flex flex-col sm:flex-row sm:items-center justify-between gap-3 group"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm text-slate-100 group-hover:text-emerald-300 transition-colors">
                        {alert.patient_name}
                      </span>
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                          alert.priority === 'urgent'
                            ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                            : alert.priority === 'high'
                            ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                            : 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                        }`}
                      >
                        {alert.priority}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400">
                      Reason: <span className="text-slate-300">{alert.trigger_reason}</span>
                    </p>
                  </div>

                  <div className="flex items-center gap-3 self-end sm:self-center">
                    <span className="text-xs text-slate-400 flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" />
                      Due: {alert.due_date}
                    </span>
                    <button className="px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 text-xs font-semibold transition-all">
                      Document
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="p-8 text-center border border-dashed border-slate-800 rounded-xl space-y-2">
                <CheckCircle className="w-8 h-8 text-emerald-400 mx-auto opacity-70" />
                <p className="text-sm font-semibold text-slate-300">All follow-ups are up to date!</p>
                <p className="text-xs text-slate-500">No unhandled patient alerts or urgent cases pending.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
