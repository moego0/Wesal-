'use client';

import React, { useState } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { DashboardStats } from '@/lib/types';
import { api, getAuthToken } from '@/lib/api';
import {
  BarChart3,
  Download,
  FileSpreadsheet,
  TrendingUp,
  CheckCircle2,
  AlertTriangle,
  Flame,
  Users,
  BellRing,
} from 'lucide-react';

interface ReportsViewProps {
  stats: DashboardStats | null;
}

export const ReportsView: React.FC<ReportsViewProps> = ({ stats }) => {
  const { t, isRTL } = useLanguage();
  const [isExporting, setIsExporting] = useState(false);

  const handleDownloadCsv = (url: string, filename: string) => {
    const token = getAuthToken();
    fetch(url, {
      headers: {
        Authorization: token ? `Bearer ${token}` : '',
      },
    })
      .then((res) => res.blob())
      .then((blob) => {
        const downloadUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      })
      .catch((err) => alert(`Export error: ${err.message}`));
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-emerald-400" />
            <span>{t('reports')} & Clinical Auditing</span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Download verified adherence reports, follow-up logs, and messaging delivery metrics.
          </p>
        </div>
      </div>

      {/* CSV Export Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="p-6 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-4 shadow-xl">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center">
              <FileSpreadsheet className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-100">Enrolled Patients Directory</h3>
              <p className="text-xs text-slate-400">All registered patients, consent statuses, and pharmacy codes.</p>
            </div>
          </div>
          <button
            onClick={() => handleDownloadCsv(api.getExportPatientsUrl(), 'wesal_patients.csv')}
            className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-semibold flex items-center justify-center gap-2 transition-colors"
          >
            <Download className="w-4 h-4 text-emerald-400" />
            <span>{t('exportCsv')} (Patients)</span>
          </button>
        </div>

        <div className="p-6 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-4 shadow-xl">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center">
              <FileSpreadsheet className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-100">Follow-Up Cases & Interventions</h3>
              <p className="text-xs text-slate-400">Adherence alerts, pharmacist counseling notes, and referrals.</p>
            </div>
          </div>
          <button
            onClick={() => handleDownloadCsv(api.getExportFollowUpsUrl(), 'wesal_followups.csv')}
            className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-semibold flex items-center justify-center gap-2 transition-colors"
          >
            <Download className="w-4 h-4 text-amber-400" />
            <span>{t('exportCsv')} (Interventions)</span>
          </button>
        </div>
      </div>

      {/* Summary Matrix */}
      {stats && (
        <div className="rounded-2xl bg-slate-900/90 border border-slate-800 p-6 space-y-6 shadow-xl">
          <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-emerald-400" />
            <span>Clinical Adherence Summary (Past 7 Days)</span>
          </h3>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
            <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-1">
              <span className="text-slate-500 font-medium">Delivery Success</span>
              <p className="text-2xl font-bold text-emerald-400">{stats.delivery_rate_today}%</p>
              <p className="text-[11px] text-slate-400">{stats.reminders_delivered_today} delivered / {stats.reminders_scheduled_today} scheduled</p>
            </div>

            <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-1">
              <span className="text-slate-500 font-medium">Patient Response Rate</span>
              <p className="text-2xl font-bold text-cyan-400">{stats.response_rate_today}%</p>
              <p className="text-[11px] text-slate-400">{stats.reminders_responded_today} patient replies received</p>
            </div>

            <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-1">
              <span className="text-slate-500 font-medium">Missed Doses Flagged</span>
              <p className="text-2xl font-bold text-amber-400">{stats.patients_reporting_missed}</p>
              <p className="text-[11px] text-slate-400">Distinct patients non-adherent</p>
            </div>

            <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-1">
              <span className="text-slate-500 font-medium">Adverse Complaints</span>
              <p className="text-2xl font-bold text-rose-400">{stats.patients_reporting_problems}</p>
              <p className="text-[11px] text-slate-400">Patients reporting side effects</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
