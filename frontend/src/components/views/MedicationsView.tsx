'use client';

import React, { useState, useEffect } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { MedicationRecord } from '@/lib/types';
import { api } from '@/lib/api';
import {
  Pill,
  Search,
  CheckCircle2,
  Clock,
  AlertTriangle,
  RefreshCw,
  Plus,
  Ban,
  FileText,
} from 'lucide-react';

interface MedicationsViewProps {
  onSelectPatient?: (patientId: string) => void;
}

export const MedicationsView: React.FC<MedicationsViewProps> = ({ onSelectPatient }) => {
  const { t, isRTL } = useLanguage();
  const [medications, setMedications] = useState<MedicationRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');

  const loadMedications = async () => {
    setIsLoading(true);
    try {
      const params: Record<string, string> = {};
      if (statusFilter) params.status = statusFilter;
      const res = await api.getMedications(params);
      setMedications(res.results || []);
    } catch (err) {
      console.error('Error loading medications:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadMedications();
  }, [statusFilter]);

  const filteredMeds = medications.filter((m) =>
    search
      ? m.name.toLowerCase().includes(search.toLowerCase()) ||
        (m.patient_name && m.patient_name.toLowerCase().includes(search.toLowerCase()))
      : true
  );

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Pill className="w-5 h-5 text-emerald-400" />
            <span>{t('medications')} & Authorized Regimens</span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Active prescriptions, synchronized reminder times, and treatment adjustments.
          </p>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-slate-400 absolute start-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search by drug name or patient name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-slate-950/60 border border-slate-800 rounded-xl py-2 ps-10 pe-4 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500"
          />
        </div>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-300 focus:outline-none focus:border-emerald-500"
        >
          <option value="">All Statuses ({medications.length})</option>
          <option value="active">{t('active')}</option>
          <option value="paused">{t('paused')}</option>
          <option value="discontinued">{t('discontinued')}</option>
          <option value="completed">{t('completed')}</option>
        </select>

        <button
          onClick={loadMedications}
          className="p-2 bg-slate-800 hover:bg-slate-700 rounded-xl text-slate-300 transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {isLoading ? (
          <div className="col-span-3 p-12 text-center text-slate-400">
            <RefreshCw className="w-6 h-6 animate-spin mx-auto text-emerald-400 mb-2" />
            <p className="text-xs">Loading authorized medications...</p>
          </div>
        ) : filteredMeds.length === 0 ? (
          <div className="col-span-3 p-12 text-center border border-dashed border-slate-800 rounded-2xl text-slate-500 text-xs">
            No medication records match the criteria.
          </div>
        ) : (
          filteredMeds.map((med) => {
            const isActive = med.status === 'active';
            return (
              <div
                key={med.id}
                className={`p-5 rounded-2xl bg-slate-900/90 border transition-all space-y-3 shadow-xl ${
                  isActive ? 'border-slate-800' : 'border-slate-800/60 opacity-60'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-bold text-slate-100 text-sm">{med.name}</h3>
                    <p className="text-xs text-emerald-400 font-medium">
                      {med.dose} {med.unit} • {med.route}
                    </p>
                  </div>
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-md uppercase ${
                      isActive
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                        : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    {med.status}
                  </span>
                </div>

                <div
                  onClick={() => onSelectPatient && onSelectPatient(med.patient)}
                  className="p-2 rounded-xl bg-slate-950/60 border border-slate-800/80 cursor-pointer hover:border-emerald-500/40 transition-colors"
                >
                  <p className="text-[11px] text-slate-400">Patient:</p>
                  <p className="text-xs font-semibold text-slate-200 truncate">{med.patient_name}</p>
                </div>

                <div className="space-y-1.5 text-xs text-slate-400">
                  <p><strong>Frequency:</strong> {med.frequency_description}</p>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[11px] text-slate-500">Times:</span>
                    {med.scheduled_times.map((t_str, idx) => (
                      <span
                        key={idx}
                        className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 font-mono text-emerald-300 text-[11px]"
                      >
                        {t_str}
                      </span>
                    ))}
                  </div>
                  {med.prescription_reference && (
                    <p className="text-[11px] text-slate-500">Rx: {med.prescription_reference}</p>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
